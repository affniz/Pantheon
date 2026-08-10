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
} from "@pantheon/core";
import type { PermissionDecision } from "@pantheon/core";
import type { ChatMessage } from "@pantheon/shared";

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
 *   { sessionId?: string, prompt: string, model?: string, noTools?: boolean, workingDir?: string }
 *
 * SSE event stream:
 *   routing  → { tier, selectedModelId, reason }
 *   text     → { content: string }              (streaming text chunks)
 *   tool_call → { id, name, arguments, safety }
 *   tool_permission_required → { toolCallId, toolName, safety }
 *   tool_result → { toolCallId, content, isError }
 *   done     → { traceId?, iterations }
 *   error    → { message }
 */
chatRouter.post("/", async (c) => {
    const body = await c.req.json<{
        sessionId?: string;
        prompt: string;
        model?: string;
        noTools?: boolean;
        workingDir?: string;
    }>();

    const { sessionId, prompt, model, noTools = false, workingDir = process.cwd() } = body;

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
                // Agentic mode
                const sandbox = Sandbox.create(workingDir);
                const toolRegistry = new ToolRegistry();
                registerBuiltinTools(toolRegistry);

                const permissionManager = new PermissionManager(
                    (toolName, args, safety) => {
                        return new Promise<PermissionDecision>((resolve) => {
                            // Emit an SSE event so the CLI can render the permission prompt
                            const toolCallId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

                            // Auto-deny if no response arrives within the timeout
                            const timer = setTimeout(() => {
                                if (pendingPermissions.has(toolCallId)) {
                                    pendingPermissions.delete(toolCallId);
                                    process.stderr.write(
                                        `[chat] permission for "${toolName}" timed out after ${PERMISSION_TIMEOUT_MS / 1000}s — auto-denying\n`
                                    );
                                    resolve("deny");
                                }
                            }, PERMISSION_TIMEOUT_MS);
                            timer.unref(); // Don't keep the process alive for this timer alone

                            pendingPermissions.set(toolCallId, { resolve, timer });
                            // Fire-and-forget — the client will POST back
                            sendEvent("tool_permission_required", { toolCallId, toolName, args, safety }).catch(() => {});
                        });
                    }
                );

                const agentRuntime = new AgentRuntime(gateway, toolRegistry, {
                    maxIterations: 10,
                    sandbox,
                    permissionManager,
                    sessionId: effectiveSessionId,
                    ...(episodicMemory ? { systemPrompt: episodicMemory } : {}),
                    onToolCall: (call, safety) => {
                        sendEvent("tool_call", { id: call.id, name: call.name, arguments: call.arguments, safety }).catch(() => {});
                    },
                    onToolResult: (result) => {
                        sendEvent("tool_result", { toolCallId: result.toolCallId, content: result.content, isError: result.isError }).catch(() => {});
                    },
                });

                const turnResult = await agentRuntime.run(messages, model);

                // Emit the final text response
                await sendEvent("routing", turnResult.decision);
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
