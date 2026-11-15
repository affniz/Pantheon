import type { SubTask, ChatMessage, ToolCall, ToolResult, AgentRole } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { AgentRuntime } from "../agent/agent-runtime.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { PermissionManager } from "../sandbox/permission-manager.js";
import type { FileCoordinator } from "../sandbox/file-coordinator.js";
import { Tracer } from "../tracing/tracer.js";
import { OrchestrationStore } from "./store.js";
import { randomUUID } from "node:crypto";
import { registerBuiltinTools } from "../tools/builtin/index.js";

export type SpecialistRole = Extract<AgentRole, "coder" | "debugger" | "executor">;

/** What distinguishes one kind of specialist from another. */
interface RoleProfile {
    spanName: string;
    /** Tool-call iterations allowed before the agent must wrap up. */
    maxIterations: number;
    heading: string;
    guidelines: string[];
}

const PROFILES: Record<SpecialistRole, RoleProfile> = {
    coder: {
        spanName: "coder.run",
        maxIterations: 15,
        heading: "You are a Coder agent — a specialist in writing, modifying, and implementing code.",
        guidelines: [
            "Write clean, well-structured, production-quality code",
            "Include appropriate error handling and edge cases",
            "Follow the language/framework conventions visible in the existing codebase",
            "Read relevant files before writing to understand the current structure",
            "Prefer precise, minimal changes over large rewrites unless explicitly asked",
            "Return the complete implementation with clear explanations of what you did",
        ],
    },
    debugger: {
        spanName: "debugger.run",
        maxIterations: 20,
        heading: "You are a Debugger agent — a specialist in root-cause analysis, error diagnosis, and targeted fixes.",
        guidelines: [
            "Start by reading the relevant source files and error messages/logs",
            "Reason carefully about root causes before suggesting fixes",
            "Run tests or commands where needed to reproduce and confirm the bug",
            "Provide a clear explanation of the root cause before the fix",
            "Write the minimal, targeted fix — avoid unnecessary refactors",
            "After applying a fix, verify it resolves the issue (run tests if possible)",
            "Document any side effects or caveats of the fix",
        ],
    },
    executor: {
        spanName: "executor.run",
        maxIterations: 10,
        heading: "You are an executor agent working on a specific sub-task within a larger plan.",
        guidelines: [
            "Complete this task thoroughly and return a clear, concise result",
            "Prefer reading and reporting over changing files unless the task asks for changes",
        ],
    },
};

export interface SpecialistConfig {
    role: SpecialistRole;
    gateway: Gateway;
    modelId: string;
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
    /**
     * Tools the agent may use — pass the session's registry so sub-agents get the
     * same plugin and MCP tools as a single agent would. Defaults to the built-ins.
     */
    toolRegistry?: ToolRegistry;
    /** Memory context (episodic / semantic) appended to the agent's instructions. */
    memory?: string;
    /** Shared by all agents of one orchestration run; coordinates their file writes. */
    fileCoordinator?: FileCoordinator;
}

export interface SpecialistResult {
    taskId: string;
    agentId: string;
    result: string;
    toolCalls: ToolCall[];
    toolResults: ToolResult[];
    iterations: number;
}

/**
 * A sub-agent that carries out one sub-task of a plan.
 *
 * The three roles (coder, debugger, executor) share this single implementation and
 * differ only in their profile above — instructions and iteration budget. The
 * lifecycle is the same for all: register the agent, mark the sub-task running,
 * run a ReAct loop, and record the outcome.
 */
export class SpecialistAgent {
    protected spec: SpecialistConfig;

    constructor(config: SpecialistConfig) {
        this.spec = config;
    }

    private systemPrompt(task: SubTask): string {
        const profile = PROFILES[this.spec.role];
        const parallel = this.spec.fileCoordinator
            ? [
                "Other agents are working on other sub-tasks of the same request at the same time, in the same project",
                "Only change files your own task requires. If a write is refused because another agent wrote the file, read it and apply your change with edit_file",
            ]
            : [];
        return [
            profile.heading,
            "",
            "YOUR TASK:",
            `Title: ${task.title}`,
            `Description: ${task.description}`,
            "",
            "Guidelines:",
            ...[...profile.guidelines, ...parallel, "Focus ONLY on this task — do not attempt other tasks"].map((g) => `- ${g}`),
            ...(this.spec.memory ? ["", this.spec.memory] : []),
        ].join("\n");
    }

    async execute(task: SubTask, contextMessages: ChatMessage[]): Promise<SpecialistResult> {
        const { role, modelId } = this.spec;
        const profile = PROFILES[role];

        return Tracer.startSpan(profile.spanName, "executor", async (span) => {
            span.attributes.taskId = task.id;
            span.attributes.taskTitle = task.title;
            span.attributes.agentType = role;

            const agentId = randomUUID();
            const store = new OrchestrationStore();

            await store.startAgent({
                agentId,
                role,
                modelId,
                parentAgentId: this.spec.parentAgentId,
                sessionId: this.spec.sessionId,
                taskId: task.id,
            });
            await store.updateSubTask(task.id, { status: "running", agentId });

            let toolRegistry = this.spec.toolRegistry;
            if (!toolRegistry || toolRegistry.list().length === 0) {
                toolRegistry = new ToolRegistry();
                registerBuiltinTools(toolRegistry);
            }

            const sandbox = this.spec.fileCoordinator
                ? this.spec.sandbox.forAgent(agentId, this.spec.fileCoordinator)
                : this.spec.sandbox;

            const agentRuntime = new AgentRuntime(this.spec.gateway, toolRegistry, {
                maxIterations: profile.maxIterations,
                systemPrompt: this.systemPrompt(task),
                sandbox,
                permissionManager: this.spec.permissionManager,
                sessionId: this.spec.sessionId,
                agentId,
                agentRole: role,
                joinTrace: true, // spans appear under the orchestrator's trace
                ...(this.spec.onToolCall ? { onToolCall: this.spec.onToolCall } : {}),
                ...(this.spec.onToolResult ? { onToolResult: this.spec.onToolResult } : {}),
                ...(this.spec.repoMap ? { repoMap: this.spec.repoMap } : {}),
                ...(this.spec.refreshRepoMap ? { refreshRepoMap: this.spec.refreshRepoMap } : {}),
            });

            try {
                const turnResult = await agentRuntime.run(contextMessages, modelId);

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

/** Options every role-specific wrapper shares (everything except the role and model id). */
export type SpecialistCommon = Omit<SpecialistConfig, "role" | "modelId">;
