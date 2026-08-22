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

export interface DebuggerConfig {
    gateway: Gateway;
    /** Model for debugging tasks. Should be deepseek-v4-pro. */
    debuggerModelId: string;
    sessionId: string;
    parentAgentId: string;
    sandbox: Sandbox;
    permissionManager: PermissionManager;
    onToolCall?: (call: ToolCall, safety: "safe" | "destructive") => void;
    onToolResult?: (result: ToolResult) => void;
}

export interface DebuggerResult {
    taskId: string;
    agentId: string;
    result: string;
    toolCalls: ToolCall[];
    toolResults: ToolResult[];
    iterations: number;
}

/**
 * DebuggerAgent — specialised executor for debugging, error analysis, and fix generation.
 * Uses deepseek-v4-pro for deep reasoning about root causes.
 */
export class DebuggerAgent {
    private config: DebuggerConfig;

    constructor(config: DebuggerConfig) {
        this.config = config;
    }

    async execute(task: SubTask, contextMessages: ChatMessage[]): Promise<DebuggerResult> {
        return Tracer.startSpan("debugger.run", "executor", async (span) => {
            span.attributes.taskId = task.id;
            span.attributes.taskTitle = task.title;
            span.attributes.agentType = "debugger";

            const agentId = randomUUID();
            const db = getDb();
            const now = new Date().toISOString();

            db.insert(agentNodes).values({
                agentId,
                role: "debugger",
                modelId: this.config.debuggerModelId,
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

            const systemPrompt = `You are a Debugger agent — a specialist in diagnosing bugs, understanding errors, and generating precise fixes.

YOUR TASK:
Title: ${task.title}
Description: ${task.description}

Guidelines:
- Start by reading the relevant source files and error messages/logs
- Reason carefully about root causes before suggesting fixes
- Run tests or commands where needed to reproduce and confirm the bug
- Provide a clear explanation of the root cause before the fix
- Write the minimal, targeted fix — avoid unnecessary refactors
- After applying a fix, verify it resolves the issue (run tests if possible)
- Document any side effects or caveats of the fix
- Focus ONLY on this debugging task — do not attempt other tasks`;

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
                    agentRole: "debugger",
                    joinTrace: true,
                    ...(this.config.onToolCall ? { onToolCall: this.config.onToolCall } : {}),
                    ...(this.config.onToolResult ? { onToolResult: this.config.onToolResult } : {}),
                },
            );

            try {
                const turnResult = await agentRuntime.run(contextMessages, this.config.debuggerModelId);

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
                    toolResults: turnResult.toolResults,
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
