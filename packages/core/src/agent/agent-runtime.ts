import type {
    ChatMessage,
    RoutingDecision,
    ToolCall,
    ToolResult,
} from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { PermissionManager } from "../sandbox/permission-manager.js";

const BASE_SYSTEM_PROMPT = `You are Pantheon, an AI assistant with access to tools for interacting with the local filesystem and shell.

When you need to read files, write files, list directories, or run commands, use the available tools.
Always prefer tools over guessing — if the user asks about a file, read it first.
When using tools, explain what you're doing and why.

IMPORTANT — tool discipline:
- ONLY call tools from the list provided in this conversation. NEVER invent or guess tool names.
- If a tool call is denied by the user, respect their decision immediately. Do NOT attempt alternative tools or shell workarounds to access the same resource — instead, ask the user what they would like you to do.
- If you cannot complete a task with the available tools, say so clearly rather than trying unlisted tools.
- File paths are relative to the project root unless specified as absolute.
- Keep tool output concise — summarize large outputs instead of repeating them verbatim.`;

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
}

export interface AgentTurnResult {
    /** The final assistant text response */
    response: string;
    /** All tool calls made during this turn */
    toolCalls: ToolCall[];
    /** All tool results received during this turn */
    toolResults: ToolResult[];
    /** The routing decision used */
    decision: RoutingDecision;
    /** Number of loop iterations used */
    iterations: number;
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
     */
    async run(
        messages: ChatMessage[],
        modelId?: string
    ): Promise<AgentTurnResult> {
        // Resolve routing once for the entire turn
        const decision = await this.gateway.resolveRouting(messages, modelId);
        const effectiveModelId = decision.selectedModelId;

        const systemPrompt = this.config.systemPrompt
            ? `${BASE_SYSTEM_PROMPT}\n\n${this.config.systemPrompt}`
            : BASE_SYSTEM_PROMPT;

        // Build the working message list with system prompt
        const workingMessages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            ...messages,
        ];

        const allToolCalls: ToolCall[] = [];
        const allToolResults: ToolResult[] = [];
        const tools = this.toolRegistry.toOpenAITools();

        let iterations = 0;

        while (iterations < this.config.maxIterations) {
            iterations++;

            // Send to LLM with tool definitions
            let message: import("@pantheon/shared").ChatMessage;
            try {
                const result = await this.gateway.complete(
                    workingMessages,
                    effectiveModelId,
                    tools.length > 0 ? tools : undefined
                );
                message = result.message;
            } catch (apiError) {
                // The LLM generated a malformed/hallucinated tool call that the API rejected.
                // Inject the error into the conversation and try to get a graceful text response.
                const errMsg = apiError instanceof Error ? apiError.message : String(apiError);
                workingMessages.push({
                    role: "user",
                    content:
                        `A tool call attempt failed with an API error: ${errMsg}\n` +
                        "Please summarize what you accomplished so far and provide a final response without calling any more tools.",
                });
                const fallback = await this.gateway.complete(
                    workingMessages,
                    effectiveModelId
                    // No tools — force plain text
                );
                return {
                    response: fallback.message.content,
                    toolCalls: allToolCalls,
                    toolResults: allToolResults,
                    decision,
                    iterations,
                };
            }

            // If no tool calls → this is the final response
            if (!message.toolCalls || message.toolCalls.length === 0) {
                return {
                    response: message.content,
                    toolCalls: allToolCalls,
                    toolResults: allToolResults,
                    decision,
                    iterations,
                };
            }

            // LLM wants to call tools — add the assistant message to history
            workingMessages.push(message);

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
                    continue;
                }

                // Execute the tool through the sandbox
                let content: string;
                let isError = false;
                try {
                    content = await tool.execute(toolCall.arguments, this.config.sandbox);
                } catch (error) {
                    content = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                    isError = true;
                }

                const result: ToolResult = {
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    content,
                    isError,
                };

                allToolResults.push(result);
                this.config.onToolResult?.(result);

                // Add tool result to message history for the next LLM turn
                workingMessages.push({
                    role: "tool",
                    content: result.content,
                    toolCallId: toolCall.id,
                });
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
            effectiveModelId
            // No tools — force a text response
        );

        return {
            response: finalMessage.content,
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            decision,
            iterations,
        };
    }
}
