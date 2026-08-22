import type {
    ChatMessage,
    RoutingDecision,
    ToolCall,
    ToolResult,
    AgentRole,
} from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { PermissionManager } from "../sandbox/permission-manager.js";
import { Tracer } from "../tracing/tracer.js";

const BASE_SYSTEM_PROMPT = `You are Pantheon, an AI assistant with access to tools for interacting with the local filesystem and shell.

When you need to read files, write files, list directories, or run commands, use the available tools.
Always prefer tools over guessing — if the user asks about a file, read it first.
When using tools, explain what you're doing and why.

IMPORTANT — tool discipline:
- ONLY call tools from the list provided in this conversation. NEVER invent or guess tool names.
- If a tool call is denied by the user, respect their decision immediately. Do NOT attempt alternative tools or shell workarounds to access the same resource — instead, ask the user what they would like you to do.
- If you cannot complete a task with the available tools, say so clearly rather than trying unlisted tools.
- File paths are relative to the project root unless specified as absolute.
- Keep tool output concise — summarize large outputs instead of repeating them verbatim.

IMPORTANT — file editing discipline:
- To MODIFY an existing file: use \`edit_file\` with the exact targetContent to replace. Never rewrite the full file just to change a few lines.
- To CREATE a new file: use \`write_file\`.
- Always read a file with \`read_file\` before editing it if you are not 100% certain of its current content.

IMPORTANT — codebase search discipline:
- Use the \`grep\` tool to search for symbols, patterns, or text across files. It is auto-approved and fast.
- Avoid using \`shell\` with grep/find for codebase searches — the \`grep\` tool is purpose-built and does not require a permission prompt.`;


export interface AgentConfig {
    /** Maximum tool-call iterations per turn. Default: 10 */
    maxIterations: number;
    /** System prompt prepended to all conversations. Supplements (not replaces) the default. */
    systemPrompt?: string;
    /** Filesystem/shell sandbox */
    sandbox: Sandbox;
    /** Two-tier permission enforcement */
    permissionManager: PermissionManager;
    /** Called when the agent requests a tool call (for UI rendering) */
    onToolCall?: (call: ToolCall, safety: "safe" | "destructive") => void;
    /** Called when a tool returns a result (for UI rendering) */
    onToolResult?: (result: ToolResult) => void;
    /**
     * Optional traceId to associate this agent turn with an existing trace.
     * If provided, spans from this turn are recorded under that traceId.
     */
    traceId?: string;
    /**
     * Optional sessionId to attach to spans for cross-referencing with sessions.
     */
    sessionId?: string;
    /** Unique identifier for this agent instance (for multi-agent tracing) */
    agentId?: string;
    /** Role this agent plays in the orchestration graph */
    agentRole?: AgentRole;
    /**
     * If set, the agent joins this existing trace context instead of creating
     * a new trace. Used by sub-agents so their spans appear as children of the
     * orchestrator's trace.
     */
    joinTrace?: boolean;
    /**
     * Pre-built codebase symbol map produced by buildRepoMap().
     * When provided, injected into the system prompt as a `## Codebase Map` section
     * so the agent starts every session with structural awareness of the codebase.
     */
    repoMap?: string;
    /**
     * Maximum total character count of all messages in workingMessages before
     * mid-turn pruning is triggered. When exceeded, the oldest tool-result
     * messages are compressed into a single summary via an LLM call.
     * Default: 80,000 characters (~20,000 tokens for typical code content).
     */
    maxContextChars?: number;
}

export interface AgentTurnResult {
    /** The final assistant text response */
    response: string;
    /** All tool calls made during this turn */
    toolCalls: ToolCall[];
    /** All tool results received during this turn */
    toolResults: ToolResult[];
    /** The routing decision used (may differ from the initial decision if escalated) */
    decision: RoutingDecision;
    /** Number of loop iterations used */
    iterations: number;
    /** Whether the model was escalated mid-turn due to repeated errors */
    escalated: boolean;
}

/**
 * ReAct-style agent runtime.
 *
 * Orchestrates the observe→think→act loop:
 * 1. Send messages + tool definitions to LLM
 * 2. If LLM returns tool_calls → check permissions → execute → append results → loop
 * 3. If LLM returns text (no tool_calls) → return final response
 * 4. If max iterations reached → force a text response
 */
export class AgentRuntime {
    private gateway: Gateway;
    private toolRegistry: ToolRegistry;
    private config: AgentConfig;

    constructor(
        gateway: Gateway,
        toolRegistry: ToolRegistry,
        config: AgentConfig
    ) {
        this.gateway = gateway;
        this.toolRegistry = toolRegistry;
        this.config = config;
    }

    /**
     * Run a single agent turn. Handles the full ReAct loop.
     * Wraps the entire turn in an "agent.turn" span; each tool execution
     * gets a child "tool.<name>" span.
     */
    async run(
        messages: ChatMessage[],
        modelId?: string
    ): Promise<AgentTurnResult> {
        const runFn = async (): Promise<AgentTurnResult> => {
            // Resolve routing once for the entire turn
            const decision = await this.gateway.resolveRouting(messages, modelId);

            const systemPromptBase = this.config.systemPrompt
                ? `${BASE_SYSTEM_PROMPT}\n\n${this.config.systemPrompt}`
                : BASE_SYSTEM_PROMPT;

            // Append the codebase repo map if provided (built at session start)
            const systemPrompt = this.config.repoMap
                ? `${systemPromptBase}\n\n## Codebase Map\n${this.config.repoMap}`
                : systemPromptBase;

            // Build the working message list with system prompt
            const workingMessages: ChatMessage[] = [
                { role: "system", content: systemPrompt },
                ...messages,
            ];

            const allToolCalls: ToolCall[] = [];
            const allToolResults: ToolResult[] = [];
            const tools = this.toolRegistry.toOpenAITools();

            let iterations = 0;
            let errorIterations = 0; // consecutive iterations ending in tool errors/denials
            const ESCALATION_THRESHOLD = 3; // escalate after this many error iterations
            let escalated = false;
            let currentDecision = decision; // may be updated mid-turn on escalation

            const MAX_CONTEXT_CHARS = this.config.maxContextChars ?? 80_000;

            while (iterations < this.config.maxIterations) {
                iterations++;

                // ── Context window pruning ─────────────────────────────────────────
                // Guard against hitting model context limits silently on long turns.
                // When workingMessages exceeds maxContextChars, compress the oldest
                // tool-result messages into a single summary via the fast model.
                const totalChars = workingMessages.reduce(
                    (sum, m) => sum + (m.content?.length ?? 0),
                    0,
                );
                if (totalChars > MAX_CONTEXT_CHARS) {
                    // Find the oldest "tool" role messages beyond the first 3 messages
                    // (system prompt + initial user message + first assistant reply).
                    const PRESERVE_HEAD = 3;
                    const pruneTargets = workingMessages
                        .slice(PRESERVE_HEAD)
                        .map((m, i) => ({ m, i: i + PRESERVE_HEAD }))
                        .filter(({ m }) => m.role === "tool");

                    if (pruneTargets.length > 0) {
                        // Collect the oldest half for compression
                        const half = Math.max(1, Math.floor(pruneTargets.length / 2));
                        const toCompress = pruneTargets.slice(0, half);

                        const combinedContent = toCompress
                            .map(({ m }) => m.content ?? "")
                            .join("\n---\n")
                            .slice(0, 8_000); // cap input to the summary call

                        try {
                            const summaryResp = await this.gateway.complete(
                                [
                                    {
                                        role: "system",
                                        content:
                                            "You are a summarizer. Condense the following tool results " +
                                            "into 1-3 sentences preserving key facts (file paths, errors, values). " +
                                            "Be extremely concise.",
                                    },
                                    { role: "user", content: combinedContent },
                                ],
                                "llama-smart", // fast, cheap summarization model
                            );

                            const summary = summaryResp.message.content;
                            // Replace the targeted messages' content in-place with the summary
                            // (replace the first one, delete the rest)
                            const firstIdx = toCompress[0]!.i;
                            workingMessages[firstIdx] = {
                                ...workingMessages[firstIdx]!,
                                content: `[Context pruned] ${summary}`,
                            };
                            // Remove the rest from back to front to preserve indices
                            for (let k = toCompress.length - 1; k >= 1; k--) {
                                workingMessages.splice(toCompress[k]!.i, 1);
                            }
                            process.stderr.write(
                                `[agent] context pruned: compressed ${toCompress.length} tool results (total was ${totalChars} chars)\n`,
                            );
                        } catch {
                            // If summary fails, just truncate content of the oldest messages
                            for (const { i } of toCompress) {
                                if (workingMessages[i]) {
                                    workingMessages[i] = {
                                        ...workingMessages[i]!,
                                        content: "[Context pruned — output too large to retain]",
                                    };
                                }
                            }
                        }
                    }
                }
                // ──────────────────────────────────────────────────────────────────

                // Mid-turn escalation: if repeated errors, re-route to the complex tier
                if (!escalated && errorIterations >= ESCALATION_THRESHOLD) {
                    try {
                        const escalatedDecision = await this.gateway.resolveRouting(messages, undefined);
                        // Only escalate if the complex tier gives us a different (better) model
                        const routingConfig = (this.gateway as any).registry?.getRoutingConfig?.();
                        const complexModelId = routingConfig?.tiers?.complex;
                        if (complexModelId && complexModelId !== currentDecision.selectedModelId) {
                            currentDecision = {
                                tier: "complex",
                                selectedModelId: complexModelId,
                                reason: `auto-escalated after ${errorIterations} error iterations`,
                            };
                            escalated = true;
                            process.stderr.write(
                                `[agent] escalating to ${complexModelId} after ${errorIterations} error iterations\n`
                            );
                        }
                    } catch {
                        // If escalation routing fails, continue with current model
                    }
                    errorIterations = 0; // reset counter after escalation attempt
                }

                // Send to LLM with tool definitions
                let message: import("@pantheon/shared").ChatMessage;
                try {
                    const result = await this.gateway.complete(
                        workingMessages,
                        currentDecision.selectedModelId,
                        tools.length > 0 ? tools : undefined
                    );
                    message = result.message;
                } catch (apiError) {
                    // The LLM generated a malformed/hallucinated tool call that the API rejected.
                    // Inject the error as role:"tool" with a synthetic toolCallId so the
                    // conversation history stays semantically correct (not as role:"user").
                    const errMsg = apiError instanceof Error ? apiError.message : String(apiError);
                    const syntheticId = `api_error_${Date.now()}`;
                    workingMessages.push({
                        role: "tool",
                        content:
                            `API error: ${errMsg}. ` +
                            "Please summarize what you accomplished so far and provide a final response without calling any more tools.",
                        toolCallId: syntheticId,
                    });
                    const fallback = await this.gateway.complete(
                        workingMessages,
                        currentDecision.selectedModelId
                        // No tools — force plain text
                    );
                    return {
                        response: fallback.message.content,
                        toolCalls: allToolCalls,
                        toolResults: allToolResults,
                        decision: currentDecision,
                        iterations,
                        escalated,
                    };
                }

                // If no tool calls → this is the final response
                if (!message.toolCalls || message.toolCalls.length === 0) {
                    return {
                        response: message.content,
                        toolCalls: allToolCalls,
                        toolResults: allToolResults,
                        decision: currentDecision,
                        iterations,
                        escalated,
                    };
                }

                // LLM wants to call tools — add the assistant message to history
                workingMessages.push(message);

                // Track whether this iteration produced any errors
                let iterationHadErrors = false;

                // Execute each tool call
                for (const toolCall of message.toolCalls) {
                    allToolCalls.push(toolCall);

                    const tool = this.toolRegistry.get(toolCall.name);
                    if (!tool) {
                        // Unknown tool — return error to LLM
                        const result: ToolResult = {
                            toolCallId: toolCall.id,
                            name: toolCall.name,
                            content: `Error: Unknown tool "${toolCall.name}". Available tools: ${this.toolRegistry.list().map((t) => t.definition.name).join(", ")}`,
                            isError: true,
                        };
                        allToolResults.push(result);
                        this.config.onToolResult?.(result);
                        workingMessages.push({
                            role: "tool",
                            content: result.content,
                            toolCallId: toolCall.id,
                        });
                        iterationHadErrors = true;
                        continue;
                    }

                    const safety = tool.definition.safety;

                    // Notify UI about the tool call
                    this.config.onToolCall?.(toolCall, safety);

                    // Check permissions
                    const permitted = await this.config.permissionManager.check(
                        toolCall.name,
                        toolCall.arguments,
                        safety
                    );

                    if (!permitted) {
                        // User denied — tell the LLM
                        const result: ToolResult = {
                            toolCallId: toolCall.id,
                            name: toolCall.name,
                            content: "Tool call denied by user. Please try a different approach or ask the user for guidance.",
                            isError: true,
                        };
                        allToolResults.push(result);
                        this.config.onToolResult?.(result);
                        workingMessages.push({
                            role: "tool",
                            content: result.content,
                            toolCallId: toolCall.id,
                        });
                        iterationHadErrors = true;
                        continue;
                    }

                    // Execute the tool through the sandbox — wrapped in a tracing span
                    let content: string;
                    let isError = false;
                    await Tracer.startSpan(
                        `tool.${toolCall.name}`,
                        "tool",
                        async (toolSpan) => {
                            toolSpan.attributes.toolName = toolCall.name;
                            toolSpan.attributes.safety = safety;
                            toolSpan.attributes.args = toolCall.arguments;
                            try {
                                content = await tool.execute(toolCall.arguments, this.config.sandbox);
                                toolSpan.attributes.outputLength = content.length;
                                // Builtin tools return error messages as strings (e.g.
                                // "Error writing file: ...") instead of throwing. Detect
                                // them here so isError is set correctly and the model gets
                                // an accurate signal to retry or report the failure.
                                if (content.startsWith("Error:") || content.startsWith("Error ")) {
                                    isError = true;
                                    toolSpan.attributes["error"] = content;
                                }
                            } catch (error) {
                                content = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                                isError = true;
                                throw error; // Let Tracer mark span as error
                            }
                        }
                    ).catch(() => {
                        // Error already captured in span; isError already set
                    });

                    const result: ToolResult = {
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        content: content!,
                        isError,
                    };

                    if (isError) iterationHadErrors = true;

                    allToolResults.push(result);
                    this.config.onToolResult?.(result);

                    // Add tool result to message history for the next LLM turn
                    workingMessages.push({
                        role: "tool",
                        content: result.content,
                        toolCallId: toolCall.id,
                    });
                }

                // Track consecutive error iterations for escalation
                if (iterationHadErrors) {
                    errorIterations++;
                } else {
                    errorIterations = 0; // reset on a clean iteration
                }
            }

            // Max iterations reached — ask the LLM for a final summary
            workingMessages.push({
                role: "user",
                content:
                    "You have reached the maximum number of tool-call iterations. " +
                    "Please provide your final response based on the information gathered so far.",
            });

            const { message: finalMessage } = await this.gateway.complete(
                workingMessages,
                currentDecision.selectedModelId
                // No tools — force a text response
            );

            return {
                response: finalMessage.content,
                toolCalls: allToolCalls,
                toolResults: allToolResults,
                decision: currentDecision,
                iterations,
                escalated,
            };
        }; // end runFn


        // Wrap the entire agent turn in a trace context + root span.
        // Sub-agents (joinTrace=true) use startSpan directly so their spans
        // appear as children of the orchestrator's existing trace.
        const wrapInSpan = async (): Promise<AgentTurnResult> => {
            return Tracer.startSpan(
                "agent.turn",
                "agent",
                async (span) => {
                    span.attributes.modelId = modelId ?? "auto";
                    if (this.config.agentId) span.attributes.agentId = this.config.agentId;
                    if (this.config.agentRole) span.attributes.agentRole = this.config.agentRole;
                    const result = await runFn();
                    span.attributes.iterations = result.iterations;
                    span.attributes.toolCallCount = result.toolCalls.length;
                    span.attributes.selectedModelId = result.decision.selectedModelId;
                    span.attributes.routingTier = result.decision.tier;
                    span.attributes.escalated = result.escalated;
                    return result;
                }
            );
        };

        if (this.config.joinTrace) {
            // Sub-agent: join the existing trace context (set by the orchestrator)
            return wrapInSpan();
        }

        // Top-level agent: create a new trace
        return Tracer.startTrace(
            this.config.sessionId,
            async (_traceId) => wrapInSpan()
        );
    }
}
