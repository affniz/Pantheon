import type { SubTask, ChatMessage, ToolCall, ToolResult } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { AgentRuntime } from "../agent/agent-runtime.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { PermissionManager } from "../sandbox/permission-manager.js";
import { Tracer } from "../tracing/tracer.js";
import { OrchestrationStore } from "./store.js";
import { randomUUID } from "node:crypto";
import { registerBuiltinTools } from "../tools/builtin/index.js";

export interface CoderConfig {
    gateway: Gateway;
    /** Model for coding tasks. Should be deepseek-v4-pro. */
    coderModelId: string;
    sessionId: string;
    parentAgentId: string;
    sandbox: Sandbox;
    permissionManager: PermissionManager;
    onToolCall?: (call: ToolCall, safety: "safe" | "destructive") => void;
    onToolResult?: (result: ToolResult) => void;
    /** Codebase map injected into the agent's system prompt. */
    repoMap?: string;
    /** Rebuilds the map after the agent writes source files (see AgentConfig.refreshRepoMap). */
    refreshRepoMap?: () => Promise<string>;
}

export interface CoderResult {
    taskId: string;
    agentId: string;
    result: string;
    toolCalls: ToolCall[];
    toolResults: ToolResult[];
    iterations: number;
}

/**
 * CoderAgent — specialised executor for code generation and implementation tasks.
 * Uses deepseek-v4-pro for high-quality code output.
 */
export class CoderAgent {
    private config: CoderConfig;

    constructor(config: CoderConfig) {
        this.config = config;
    }

    async execute(task: SubTask, contextMessages: ChatMessage[]): Promise<CoderResult> {
        return Tracer.startSpan("coder.run", "executor", async (span) => {
            span.attributes.taskId = task.id;
            span.attributes.taskTitle = task.title;
            span.attributes.agentType = "coder";

            const agentId = randomUUID();
            const store = new OrchestrationStore();

            await store.startAgent({
                agentId,
                role: "coder",
                modelId: this.config.coderModelId,
                parentAgentId: this.config.parentAgentId,
                sessionId: this.config.sessionId,
                taskId: task.id,
            });
            await store.updateSubTask(task.id, { status: "running", agentId });

            const toolRegistry = new ToolRegistry();
            registerBuiltinTools(toolRegistry);

            const systemPrompt = `You are a Coder agent — a specialist in writing, modifying, and implementing code.

YOUR TASK:
Title: ${task.title}
Description: ${task.description}

Guidelines:
- Write clean, well-structured, production-quality code
- Include appropriate error handling and edge cases
- Follow the language/framework conventions visible in the existing codebase
- Read relevant files before writing to understand the current structure
- Prefer precise, minimal changes over large rewrites unless explicitly asked
- Return the complete implementation with clear explanations of what you did
- Focus ONLY on this task — do not attempt other tasks`;

            const agentRuntime = new AgentRuntime(
                this.config.gateway,
                toolRegistry,
                {
                    maxIterations: 15,
                    systemPrompt,
                    sandbox: this.config.sandbox,
                    permissionManager: this.config.permissionManager,
                    sessionId: this.config.sessionId,
                    agentId,
                    agentRole: "coder",
                    joinTrace: true,
                    ...(this.config.onToolCall ? { onToolCall: this.config.onToolCall } : {}),
                    ...(this.config.onToolResult ? { onToolResult: this.config.onToolResult } : {}),
                    ...(this.config.repoMap ? { repoMap: this.config.repoMap } : {}),
                    ...(this.config.refreshRepoMap ? { refreshRepoMap: this.config.refreshRepoMap } : {}),
                },
            );

            try {
                const turnResult = await agentRuntime.run(contextMessages, this.config.coderModelId);

                await store.completeAgent(agentId, turnResult.response);
                await store.updateSubTask(task.id, { status: "completed", result: turnResult.response });

                span.attributes.iterations = turnResult.iterations;
                span.attributes.toolCallCount = turnResult.toolCalls.length;
                span.attributes.agentId = agentId;

                return {
                    taskId: task.id,
                    agentId,
                    result: turnResult.response,
                    toolCalls: turnResult.toolCalls,
                    toolResults: turnResult.toolResults,
                    iterations: turnResult.iterations,
                };
            } catch (error) {
                await store.failAgent(agentId, error);
                await store.failSubTask(task.id, error);
                throw error;
            }
        });
    }
}
