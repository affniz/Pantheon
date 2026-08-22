import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
    ModelRegistry,
    Gateway,
    Sandbox,
    PermissionManager,
    ToolRegistry,
    registerBuiltinTools,
    AgentRuntime,
    SessionManager,
    SessionSummarizer,
    Orchestrator,
    PluginRegistry,
    loadConfig,
    getCapabilities,
    DEFAULT_PLUGINS_DIR,
    buildRepoMap,
} from "@pantheon/core";
import type { PermissionDecision } from "@pantheon/core";
import type { ChatMessage, OrchestrationEvent } from "@pantheon/shared";

export const chatRouter = new Hono();

/**
 * Pending tool permission requests, keyed by toolCallId.
 * Each entry holds the resolver and a timeout handle that auto-denies after
 * PERMISSION_TIMEOUT_MS if the CLI never responds (e.g., disconnected).
 */
const PERMISSION_TIMEOUT_MS = 60_000;
const pendingPermissions = new Map<string, { resolve: (decision: PermissionDecision) => void; timer: NodeJS.Timeout }>();

/**
 * POST /api/chat — Start an agentic chat turn over SSE.
 *
 * Request body:
 *   { sessionId?, prompt, model?, noTools?, workingDir?, orchestrate? }
 *
 * SSE event stream (existing):
 *   routing  → { tier, selectedModelId, reason }
 *   text     → { content: string }
 *   tool_call → { id, name, arguments, safety }
 *   tool_permission_required → { toolCallId, toolName, safety }
 *   tool_result → { toolCallId, content, isError }
 *   done     → { sessionId, iterations }
 *   error    → { message }
 *
 * SSE event stream (v0.6 orchestration):
 *   orchestration_start → { planId, taskCount }
 *   agent_spawned → { agent: AgentNode }
 *   agent_completed → { agentId, result }
 *   agent_failed → { agentId, error }
 *   plan_created → { plan: TaskPlan }
 *   review_result → { approved, feedback, finalResponse }
 *   orchestration_done → { planId, finalResponse }
 */
chatRouter.post("/", async (c) => {
    const body = await c.req.json<{
        sessionId?: string;
        prompt: string;
        model?: string;
        noTools?: boolean;
        workingDir?: string;
        /** "auto" (default) = orchestrate complex tasks; true = always; false = never */
        orchestrate?: boolean | "auto";
        /** Max sub-tasks for the planner. Corresponds to --budget flag. Default: 3 */
        maxSubTasks?: number;
    }>();

    const {
        sessionId,
        prompt,
        model,
        noTools = false,
        workingDir = process.env["PANTHEON_WORKSPACE"] ?? process.cwd(),
        orchestrate = "auto",
        maxSubTasks = 3,
    } = body;

    if (!prompt?.trim()) {
        return c.json({ error: "prompt is required" }, 400);
    }

    return streamSSE(c, async (stream) => {
        const sendEvent = async (event: string, data: unknown) => {
            await stream.writeSSE({ event, data: JSON.stringify(data) });
        };

        try {
            const registry = new ModelRegistry();
            const gateway = new Gateway(registry);
            const sm = new SessionManager();

            // Resolve or create session
            let effectiveSessionId = sessionId;
            if (!effectiveSessionId) {
                effectiveSessionId = sm.create();
            }

            // Load existing messages for context
            let messages: ChatMessage[] = sm.getMessages(effectiveSessionId);

            // Append the new user message
            const userMsg: ChatMessage = { role: "user", content: prompt.trim(), timestamp: new Date() };
            sm.addMessage(effectiveSessionId, userMsg);
            messages = [...messages, userMsg];

            // Build episodic memory context
            const fastModelId = registry.getDefault()?.id ?? registry.list()[0]?.id;
            let episodicMemory = "";
            if (fastModelId && effectiveSessionId) {
                const summarizer = new SessionSummarizer(gateway, fastModelId);
                episodicMemory = summarizer.getEpisodicMemoryContext(effectiveSessionId, {
                    recentMessageCount: 10,
                    summaryLimit: 4,
                });
            }

            if (noTools) {
                // Pure chat mode — stream directly
                const { generator, decision } = await gateway.stream(messages, model);
                await sendEvent("routing", decision);

                let accumulated = "";
                for await (const chunk of generator) {
                    accumulated += chunk;
                    await sendEvent("text", { content: chunk });
                }

                const assistantMsg: ChatMessage = { role: "assistant", content: accumulated, timestamp: new Date() };
                sm.addMessage(effectiveSessionId, assistantMsg);

                await sendEvent("done", { sessionId: effectiveSessionId, iterations: 1 });
            } else {
                // Determine if we should use multi-agent orchestration
                let useOrchestration = false;

                if (orchestrate === true) {
                    useOrchestration = true;
                } else if (orchestrate === false) {
                    useOrchestration = false;
                } else {
                    // "auto" — classify the prompt and orchestrate if complex
                    const routingDecision = await gateway.resolveRouting(messages, model);
                    if (routingDecision.tier === "complex" && !model) {
                        const caps = getCapabilities();
                        if (caps.orchestrationEnabled) {
                            useOrchestration = true;
                        } else {
                            // DEEPSEEK_API_KEY not set — warn and fall back to llama-smart
                            await sendEvent("warning", {
                                message:
                                    "DEEPSEEK_API_KEY not set — complex task routed to llama-smart instead. " +
                                    "Add DEEPSEEK_API_KEY to .env to enable full orchestration.",
                            });
                            // Override the decision to use llama-smart (general tier)
                            routingDecision.tier = "general";
                            routingDecision.selectedModelId = registry.getRoutingConfig().tiers.general;
                            routingDecision.reason = "fallback: DEEPSEEK_API_KEY not set";
                            useOrchestration = false;
                        }
                    }
                    // Emit routing decision for the CLI
                    await sendEvent("routing", routingDecision);
                }

                const sandbox = Sandbox.create(workingDir);

                // Build codebase map at session start — injected into agent system prompt
                // as a ## Codebase Map section. Gives agents structural awareness without
                // any listDirectory/readFile exploration loops.
                let repoMapContent: string | undefined;
                try {
                    repoMapContent = await buildRepoMap(workingDir);
                } catch (e) {
                    process.stderr.write(
                        `[chat] repo map build failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`,
                    );
                }

                const permissionManager = new PermissionManager(
                    (toolName, args, safety) => {
                        return new Promise<PermissionDecision>((resolve) => {
                            const toolCallId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

                            const timer = setTimeout(() => {
                                if (pendingPermissions.has(toolCallId)) {
                                    pendingPermissions.delete(toolCallId);
                                    process.stderr.write(
                                        `[chat] permission for "${toolName}" timed out after ${PERMISSION_TIMEOUT_MS / 1000}s — auto-denying\n`
                                    );
                                    resolve("deny");
                                }
                            }, PERMISSION_TIMEOUT_MS);
                            timer.unref();

                            pendingPermissions.set(toolCallId, { resolve, timer });
                            sendEvent("tool_permission_required", { toolCallId, toolName, args, safety }).catch(() => {});
                        });
                    },
                    // Pre-approve read-only tools — no prompt needed for safe reads
                    ["read_file", "list_directory"]
                );

                const onToolCall = (call: import("@pantheon/shared").ToolCall, safety: "safe" | "destructive") => {
                    sendEvent("tool_call", { id: call.id, name: call.name, arguments: call.arguments, safety }).catch(() => {});
                };
                const onToolResult = (result: import("@pantheon/shared").ToolResult) => {
                    sendEvent("tool_result", { toolCallId: result.toolCallId, content: result.content, isError: result.isError }).catch(() => {});
                };

                if (useOrchestration) {
                    // ── Multi-agent orchestration path ──────────────────────────
                    const routingConfig = registry.getRoutingConfig();

                    const orchestrator = new Orchestrator({
                        gateway,
                        toolRegistry: new ToolRegistry(), // orchestrator creates its own per executor
                        sandbox,
                        permissionManager,
                        sessionId: effectiveSessionId,
                        plannerModelId: routingConfig.tiers.complex,   // deepseek-v4-pro
                        agentModelId: routingConfig.tiers.complex,     // deepseek-v4-pro (coder, debugger, executor)
                        reviewerModelId: routingConfig.tiers.complex,  // deepseek-v4-pro
                        maxConcurrency: 5,
                        maxSubTasks: Math.min(6, Math.max(1, maxSubTasks)),
                        ...(episodicMemory ? { episodicMemory } : {}),
                        onEvent: (event: OrchestrationEvent) => {
                            sendEvent(event.type, event).catch(() => {});
                        },
                        onToolCall,
                        onToolResult,
                    });

                    const result = await orchestrator.run(prompt.trim(), messages);

                    // Emit the final text as a standard text event for CLI rendering
                    await sendEvent("text", { content: result.finalResponse });

                    // Persist assistant message
                    const assistantMsg: ChatMessage = {
                        role: "assistant",
                        content: result.finalResponse,
                        timestamp: new Date(),
                    };
                    sm.addMessage(effectiveSessionId, assistantMsg);

                    // Background summarization
                    if (fastModelId) {
                        const allMsgs = sm.getMessages(effectiveSessionId);
                        const turnCount = allMsgs.filter((m) => m.role === "user" || m.role === "assistant").length;
                        if (turnCount >= 4) {
                            const summarizer = new SessionSummarizer(gateway, fastModelId);
                            summarizer.saveForSession(effectiveSessionId, allMsgs).catch(() => {});
                        }
                    }

                    await sendEvent("done", {
                        sessionId: effectiveSessionId,
                        iterations: 0,
                        orchestrated: true,
                        planId: result.planId,
                    });
                } else {
                    // ── Single-agent path (unchanged from v0.5) ──────────────────
                    const toolRegistry = new ToolRegistry();
                    registerBuiltinTools(toolRegistry);

                    // Wire plugins
                    const pluginCfg = loadConfig().plugins;
                    const pluginDir = pluginCfg?.directory ?? DEFAULT_PLUGINS_DIR;
                    const pluginReg = new PluginRegistry(toolRegistry, pluginDir);
                    try {
                        await pluginReg.loadFromDirectory(sandbox);
                    } catch (e) {
                        process.stderr.write(`[chat] plugin load error: ${e instanceof Error ? e.message : String(e)}\n`);
                    }

                    const agentRuntime = new AgentRuntime(gateway, toolRegistry, {
                        maxIterations: 20,
                        sandbox,
                        permissionManager,
                        sessionId: effectiveSessionId,
                        ...(episodicMemory ? { systemPrompt: episodicMemory } : {}),
                        ...(repoMapContent ? { repoMap: repoMapContent } : {}),
                        onToolCall,
                        onToolResult,
                    });

                    const turnResult = await agentRuntime.run(messages, model);

                    // Emit the routing decision (if we didn't emit it above during auto-detection)
                    if (orchestrate !== "auto") {
                        await sendEvent("routing", turnResult.decision);
                    }
                    await sendEvent("text", { content: turnResult.response });

                    // Persist assistant message
                    const assistantMsg: ChatMessage = { role: "assistant", content: turnResult.response, timestamp: new Date() };
                    sm.addMessage(effectiveSessionId, assistantMsg);

                    // Background summarization
                    if (fastModelId) {
                        const allMsgs = sm.getMessages(effectiveSessionId);
                        const turnCount = allMsgs.filter((m) => m.role === "user" || m.role === "assistant").length;
                        if (turnCount >= 4) {
                            const summarizer = new SessionSummarizer(gateway, fastModelId);
                            summarizer.saveForSession(effectiveSessionId, allMsgs).catch(() => {});
                        }
                    }

                    await sendEvent("done", {
                        sessionId: effectiveSessionId,
                        iterations: turnResult.iterations,
                    });
                }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await sendEvent("error", { message });
        }
    });
});

/**
 * POST /api/chat/respond — Submit a tool permission decision mid-turn.
 *
 * Body: { toolCallId: string, decision: "allow_once" | "always_allow" | "deny" }
 */
chatRouter.post("/respond", async (c) => {
    const body = await c.req.json<{ toolCallId: string; decision: PermissionDecision }>();
    const { toolCallId, decision } = body;

    const entry = pendingPermissions.get(toolCallId);
    if (!entry) {
        return c.json({ error: "No pending permission request for that toolCallId" }, 404);
    }

    clearTimeout(entry.timer);
    pendingPermissions.delete(toolCallId);
    entry.resolve(decision);
    return c.json({ ok: true });
});
