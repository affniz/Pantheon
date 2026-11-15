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

export interface ExecutorConfig {
    gateway: Gateway;
    executorModelId: string;
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

export interface ExecutorResult {
    taskId: string;
    agentId: string;
    result: string;
    toolCalls: ToolCall[];
    toolResults: ToolResult[];
    iterations: number;
}

/**
 * Executor agent factory — creates a scoped AgentRuntime for a single sub-task.
 * Handles "general" tasks (research, documentation, Q&A) with tool access.
 */
export class ExecutorAgent {
    private config: ExecutorConfig;

    constructor(config: ExecutorConfig) {
        this.config = config;
    }

    /**
     * Execute a single sub-task. Creates a fresh AgentRuntime with an
     * executor-specific system prompt and runs it to completion.
     */
    async execute(task: SubTask, contextMessages: ChatMessage[]): Promise<ExecutorResult> {
        return Tracer.startSpan("executor.run", "executor", async (span) => {
            span.attributes.taskId = task.id;
            span.attributes.taskTitle = task.title;

            const agentId = randomUUID();
            const store = new OrchestrationStore();

            await store.startAgent({
                agentId,
                role: "executor",
                modelId: this.config.executorModelId,
                parentAgentId: this.config.parentAgentId,
                sessionId: this.config.sessionId,
                taskId: task.id,
            });
            await store.updateSubTask(task.id, { status: "running", agentId });

            // Each executor gets its own tool registry
            const toolRegistry = new ToolRegistry();
            registerBuiltinTools(toolRegistry);

            const systemPrompt = `You are an executor agent working on a specific sub-task within a larger plan.

YOUR TASK:
Title: ${task.title}
Description: ${task.description}

Complete this task thoroughly and return a clear, concise result.
Focus only on your assigned task — do not try to complete other tasks.`;

            const agentRuntime = new AgentRuntime(
                this.config.gateway,
                toolRegistry,
                {
                    maxIterations: 10,
                    systemPrompt,
                    sandbox: this.config.sandbox,
                    permissionManager: this.config.permissionManager,
                    sessionId: this.config.sessionId,
                    agentId,
                    agentRole: "executor",
                    joinTrace: true, // join the orchestrator's trace
                    ...(this.config.onToolCall ? { onToolCall: this.config.onToolCall } : {}),
                    ...(this.config.onToolResult ? { onToolResult: this.config.onToolResult } : {}),
                    ...(this.config.repoMap ? { repoMap: this.config.repoMap } : {}),
                    ...(this.config.refreshRepoMap ? { refreshRepoMap: this.config.refreshRepoMap } : {}),
                },
            );

            try {
                const turnResult = await agentRuntime.run(contextMessages, this.config.executorModelId);

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
