import type { SubTask, ChatMessage, ToolCall, ToolResult } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { AgentRuntime } from "../agent/agent-runtime.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { PermissionManager } from "../sandbox/permission-manager.js";
import { Tracer } from "../tracing/tracer.js";
import { getDb } from "../db/client.js";
import { agentNodes, subTasks } from "../db/schema.js";
import { eq } from "drizzle-orm";
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
 * Uses the fast model (8B) for quick execution with tool access.
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
            const db = getDb();
            const now = new Date().toISOString();

            // Register the executor agent node
            db.insert(agentNodes).values({
                agentId,
                role: "executor",
                modelId: this.config.executorModelId,
                parentAgentId: this.config.parentAgentId,
                sessionId: this.config.sessionId,
                taskId: task.id,
                status: "running",
                startTime: Date.now(),
                createdAt: now,
            }).run();

            // Mark the sub-task as running
            db.update(subTasks)
                .set({ status: "running", agentId })
                .where(eq(subTasks.id, task.id))
                .run();

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
                },
            );

            try {
                const turnResult = await agentRuntime.run(contextMessages, this.config.executorModelId);

                // Mark agent and sub-task as completed
                db.update(agentNodes)
                    .set({
                        status: "completed",
                        result: turnResult.response,
                        endTime: Date.now(),
                    })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();

                db.update(subTasks)
                    .set({
                        status: "completed",
                        result: turnResult.response,
                    })
                    .where(eq(subTasks.id, task.id))
                    .run();

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
                const errorMessage = error instanceof Error ? error.message : String(error);

                db.update(agentNodes)
                    .set({
                        status: "failed",
                        error: errorMessage,
                        endTime: Date.now(),
                    })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();

                db.update(subTasks)
                    .set({
                        status: "failed",
                        error: errorMessage,
                    })
                    .where(eq(subTasks.id, task.id))
                    .run();

                throw error;
            }
        });
    }
}
