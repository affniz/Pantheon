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
}

export interface CoderResult {
    taskId: string;
    agentId: string;
    result: string;
    toolCalls: ToolCall[];
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
            const db = getDb();
            const now = new Date().toISOString();

            db.insert(agentNodes).values({
                agentId,
                role: "coder",
                modelId: this.config.coderModelId,
                parentAgentId: this.config.parentAgentId,
                sessionId: this.config.sessionId,
                taskId: task.id,
                status: "running",
                startTime: Date.now(),
                createdAt: now,
            }).run();

            db.update(subTasks)
                .set({ status: "running", agentId })
                .where(eq(subTasks.id, task.id))
                .run();

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
                },
            );

            try {
                const turnResult = await agentRuntime.run(contextMessages, this.config.coderModelId);

                db.update(agentNodes)
                    .set({ status: "completed", result: turnResult.response, endTime: Date.now() })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();

                db.update(subTasks)
                    .set({ status: "completed", result: turnResult.response })
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
                    iterations: turnResult.iterations,
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);

                db.update(agentNodes)
                    .set({ status: "failed", error: errorMessage, endTime: Date.now() })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();

                db.update(subTasks)
                    .set({ status: "failed", error: errorMessage })
                    .where(eq(subTasks.id, task.id))
                    .run();

                throw error;
            }
        });
    }
}
