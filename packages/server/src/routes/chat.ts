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
    }>();

    const {
        sessionId,
        prompt,
        model,
        noTools = false,
        workingDir = process.env["PANTHEON_WORKSPACE"] ?? process.cwd(),
        orchestrate = "auto",
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
            if (fastModelId) {
                const summarizer = new SessionSummarizer(gateway, fastModelId);
                const summaries = summarizer.getRecentSummaries(5);
                if (summaries.length > 0) {
                    const lines = summaries.map((s) => `- "${s.title}" — ${s.summary}`);
                    episodicMemory = `\n\nYou have had these recent conversations with the user:\n${lines.join("\n")}`;
                }
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
                        useOrchestration = true;
                    }
                    // Emit routing decision for the CLI
                    await sendEvent("routing", routingDecision);
                }

                const sandbox = Sandbox.create(workingDir);

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

                    const agentRuntime = new AgentRuntime(gateway, toolRegistry, {
                        maxIterations: 20,
                        sandbox,
                        permissionManager,
                        sessionId: effectiveSessionId,
                        ...(episodicMemory ? { systemPrompt: episodicMemory } : {}),
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
