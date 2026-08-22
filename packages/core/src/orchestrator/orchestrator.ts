import type {
    ChatMessage,
    SubTask,
    TaskPlan,
    AgentNode,
    OrchestrationEvent,
    ToolCall,
    ToolResult,
} from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { PermissionManager } from "../sandbox/permission-manager.js";
import { Tracer } from "../tracing/tracer.js";
import { getDb } from "../db/client.js";
import { agentNodes, subTasks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PlannerAgent } from "./planner.js";
import { ExecutorAgent } from "./executor.js";
import { CoderAgent } from "./coder.js";
import { DebuggerAgent } from "./debugger.js";
import { ReviewerAgent } from "./reviewer.js";
import type { AgentConfig } from "../agent/agent-runtime.js";

export interface OrchestratorConfig {
    gateway: Gateway;
    toolRegistry: ToolRegistry;
    sandbox: Sandbox;
    permissionManager: PermissionManager;
    sessionId: string;
    /** Model for the planner (reasoning-class). Uses deepseek-v4-pro. */
    plannerModelId: string;
    /**
     * Model for all specialised agents (coder, debugger, executor).
     * Uses deepseek-v4-pro for high-quality code and debug reasoning.
     */
    agentModelId: string;
    /** Model for the reviewer (reasoning-class). Uses deepseek-v4-pro. */
    reviewerModelId: string;
    /** Max concurrent executor agents. Default: 5 */
    maxConcurrency?: number;
    /** Max sub-tasks the Planner may generate. Default: 3. Range: 1–6. */
    maxSubTasks?: number;
    /** Callback for orchestration events (streamed as SSE to the CLI) */
    onEvent?: (event: OrchestrationEvent) => void;
    /** Forwarded to sub-agents for UI rendering */
    onToolCall?: AgentConfig["onToolCall"];
    /** Forwarded to sub-agents for UI rendering */
    onToolResult?: AgentConfig["onToolResult"];
    /** Episodic memory to append to system prompts */
    episodicMemory?: string;
}

export interface OrchestratorResult {
    planId: string;
    plan: TaskPlan;
    agentTree: AgentNode[];
    finalResponse: string;
    reviewApproved: boolean;
    reviewFeedback: string;
}

/**
 * Top-level multi-agent orchestrator.
 *
 * Lifecycle:
 * 1. Plan  — PlannerAgent (deepseek-v4-pro) decomposes the user prompt into sub-tasks,
 *            each annotated with a taskRole: "code" | "debug" | "general"
 * 2. Schedule — Topological sort produces execution waves by dependency
 * 3. Execute — Role-based dispatch:
 *              "code"    → CoderAgent    (deepseek-v4-pro, coding-optimised prompt)
 *              "debug"   → DebuggerAgent (deepseek-v4-pro, debug-optimised prompt)
 *              "general" → ExecutorAgent (deepseek-v4-pro, generic prompt)
 * 4. Review — ReviewerAgent (deepseek-v4-pro) synthesizes all results
 */
export class Orchestrator {
    private config: OrchestratorConfig;
    private maxConcurrency: number;

    constructor(config: OrchestratorConfig) {
        this.config = config;
        this.maxConcurrency = config.maxConcurrency ?? 5;
    }

    async run(prompt: string, messages: ChatMessage[]): Promise<OrchestratorResult> {
        return Tracer.startTrace(this.config.sessionId, async (_traceId) => {
            return Tracer.startSpan("orchestrator.run", "orchestrator", async (span) => {
                const db = getDb();
                const orchestratorAgentId = randomUUID();
                const now = new Date().toISOString();

                // Register the root orchestrator agent node
                db.insert(agentNodes).values({
                    agentId: orchestratorAgentId,
                    role: "orchestrator",
                    modelId: this.config.plannerModelId,
                    sessionId: this.config.sessionId,
                    status: "running",
                    startTime: Date.now(),
                    createdAt: now,
                }).run();

                span.attributes.agentId = orchestratorAgentId;

                try {
                    // ── 1. Plan ──────────────────────────────────────
                    const planner = new PlannerAgent({
                        gateway: this.config.gateway,
                        plannerModelId: this.config.plannerModelId,
                        sessionId: this.config.sessionId,
                        parentAgentId: orchestratorAgentId,
                        maxSubTasks: this.config.maxSubTasks ?? 3,
                    });

                    const plan = await planner.plan(prompt);

                    this.emit({ type: "plan_created", plan });
                    this.emit({
                        type: "orchestration_start",
                        planId: plan.planId,
                        taskCount: plan.tasks.length,
                    });

                    span.attributes.planId = plan.planId;
                    span.attributes.taskCount = plan.tasks.length;

                    // ── 2. Schedule — topological sort into execution waves ──
                    const waves = this.topologicalSort(plan.tasks);
                    span.attributes.waveCount = waves.length;

                    // ── 3. Execute — run each wave in parallel (role-based dispatch) ──
                    const allAgentNodes: AgentNode[] = [];
                    const taskResults = new Map<string, SubTask>();

                    for (const wave of waves) {
                        const results = await this.executeWave(
                            wave,
                            plan,
                            messages,
                            orchestratorAgentId,
                            taskResults,
                        );

                        for (const result of results) {
                            taskResults.set(result.id, result);
                        }
                    }

                    // Collect final task states
                    const completedTasks = plan.tasks.map((t) =>
                        taskResults.get(t.id) ?? { ...t, status: "cancelled" as const },
                    );

                    // ── 4. Review ────────────────────────────────────
                    const reviewer = new ReviewerAgent({
                        gateway: this.config.gateway,
                        reviewerModelId: this.config.reviewerModelId,
                        sessionId: this.config.sessionId,
                        parentAgentId: orchestratorAgentId,
                        sandbox: this.config.sandbox,
                    });

                    const reviewResult = await reviewer.review(plan, completedTasks);

                    this.emit({
                        type: "review_result",
                        approved: reviewResult.approved,
                        feedback: reviewResult.feedback,
                        finalResponse: reviewResult.finalResponse,
                    });

                    // Mark orchestrator as completed
                    db.update(agentNodes)
                        .set({
                            status: "completed",
                            result: reviewResult.finalResponse,
                            endTime: Date.now(),
                        })
                        .where(eq(agentNodes.agentId, orchestratorAgentId))
                        .run();

                    this.emit({
                        type: "orchestration_done",
                        planId: plan.planId,
                        finalResponse: reviewResult.finalResponse,
                    });

                    // Collect agent nodes for the result
                    const agentNodeRows = db
                        .select()
                        .from(agentNodes)
                        .where(eq(agentNodes.sessionId, this.config.sessionId))
                        .all();

                    const agentTree: AgentNode[] = agentNodeRows.map((row) => ({
                        agentId: row.agentId,
                        role: row.role as AgentNode["role"],
                        modelId: row.modelId,
                        sessionId: row.sessionId,
                        status: row.status as AgentNode["status"],
                        startTime: row.startTime,
                        ...(row.parentAgentId ? { parentAgentId: row.parentAgentId } : {}),
                        ...(row.taskId ? { taskId: row.taskId } : {}),
                        ...(row.result ? { result: row.result } : {}),
                        ...(row.error ? { error: row.error } : {}),
                        ...(row.endTime !== null && row.endTime !== undefined ? { endTime: row.endTime } : {}),
                    }));

                    return {
                        planId: plan.planId,
                        plan,
                        agentTree,
                        finalResponse: reviewResult.finalResponse,
                        reviewApproved: reviewResult.approved,
                        reviewFeedback: reviewResult.feedback,
                    };
                } catch (error) {
                    db.update(agentNodes)
                        .set({
                            status: "failed",
                            error: error instanceof Error ? error.message : String(error),
                            endTime: Date.now(),
                        })
                        .where(eq(agentNodes.agentId, orchestratorAgentId))
                        .run();
                    throw error;
                }
            });
        });
    }

    /**
     * Execute a wave of tasks in parallel, respecting maxConcurrency.
     * Dispatches each task to the appropriate specialist agent based on taskRole:
     *   "code"    → CoderAgent
     *   "debug"   → DebuggerAgent
     *   "general" → ExecutorAgent (fallback)
     */
    private async executeWave(
        wave: SubTask[],
        plan: TaskPlan,
        messages: ChatMessage[],
        orchestratorAgentId: string,
        previousResults: Map<string, SubTask>,
    ): Promise<SubTask[]> {
        // Filter out tasks whose dependencies failed
        const runnableTasks = wave.filter((task) => {
            for (const depId of task.dependencies) {
                const dep = previousResults.get(depId);
                if (!dep || dep.status === "failed" || dep.status === "cancelled") {
                    this.emit({
                        type: "agent_failed",
                        agentId: task.id,
                        error: `Cancelled: dependency "${depId}" was not completed`,
                    });
                    return false;
                }
            }
            return true;
        });

        // Map from task id → toolResults from the agent that executed it
        const taskToolResults = new Map<string, ToolResult[]>();

        // Build context from previous task results
        const buildContextSuffix = (): string => {
            if (previousResults.size === 0) return "";

            const lines: string[] = ["\n\nContext from previously completed tasks:"];
            for (const t of previousResults.values()) {
                if (t.status !== "completed") continue;
                lines.push(`\n### Task: ${t.title} [${t.status}]`);
                if (t.result) {
                    lines.push(`Summary: ${t.result}`);
                }
                // Extract files written or modified by this task's agent
                const tResults = taskToolResults.get(t.id) ?? [];
                const writtenFiles = tResults
                    .filter(
                        (r) =>
                            !r.isError &&
                            (r.name === "write_file" || r.name === "edit_file") &&
                            typeof r.content === "string",
                    )
                    .map((r) => {
                        // Output format: "Successfully wrote N lines to /abs/path/file.ts"
                        //               "Successfully edited /abs/path: replaced ..."
                        const match = r.content.match(/(?:wrote \d+ lines to|edited)\s+(\S+)/);
                        return match ? match[1] : null;
                    })
                    .filter((p): p is string => p !== null);

                if (writtenFiles.length > 0) {
                    lines.push(`Files written/modified:\n${writtenFiles.map((f) => `  - ${f}`).join("\n")}`);
                }
            }
            return lines.join("\n");
        };

        const contextSuffix = buildContextSuffix();

        // Execute in batches of maxConcurrency
        const results: SubTask[] = [];
        for (let i = 0; i < runnableTasks.length; i += this.maxConcurrency) {
            const batch = runnableTasks.slice(i, i + this.maxConcurrency);

            const settled = await Promise.allSettled(
                batch.map(async (task) => {
                    const taskRole = task.taskRole ?? "general";

                    this.emit({
                        type: "agent_spawned",
                        agent: {
                            agentId: task.id,
                            role: taskRole === "code" ? "coder" : taskRole === "debug" ? "debugger" : "executor",
                            modelId: this.config.agentModelId,
                            parentAgentId: orchestratorAgentId,
                            sessionId: this.config.sessionId,
                            taskId: task.id,
                            status: "running",
                            startTime: Date.now(),
                        },
                    });

                    // Build context messages for the agent
                    const contextMessages: ChatMessage[] = [
                        {
                            role: "user",
                            content: plan.originalPrompt + contextSuffix,
                        },
                    ];

                    const commonConfig = {
                        gateway: this.config.gateway,
                        sessionId: this.config.sessionId,
                        parentAgentId: orchestratorAgentId,
                        sandbox: this.config.sandbox,
                        // Each sub-agent gets its own PermissionManager forked from the parent,
                        // pre-seeded with the session's existing grants so previously approved
                        // tools don't re-prompt — but concurrent agents don't race on shared state.
                        permissionManager: this.config.permissionManager.fork(),
                        ...(this.config.onToolCall ? { onToolCall: this.config.onToolCall } : {}),
                        ...(this.config.onToolResult ? { onToolResult: this.config.onToolResult } : {}),
                    };

                    let execResult: { taskId: string; agentId: string; result: string; toolCalls: ToolCall[]; toolResults: ToolResult[]; iterations: number };

                    // Role-based dispatch
                    if (taskRole === "code") {
                        const agent = new CoderAgent({ ...commonConfig, coderModelId: this.config.agentModelId });
                        execResult = await agent.execute(task, contextMessages);
                    } else if (taskRole === "debug") {
                        const agent = new DebuggerAgent({ ...commonConfig, debuggerModelId: this.config.agentModelId });
                        execResult = await agent.execute(task, contextMessages);
                    } else {
                        const agent = new ExecutorAgent({ ...commonConfig, executorModelId: this.config.agentModelId });
                        execResult = await agent.execute(task, contextMessages);
                    }

                    // Stash tool results so the context builder can extract file paths
                    taskToolResults.set(task.id, execResult.toolResults);

                    this.emit({
                        type: "agent_completed",
                        agentId: execResult.agentId,
                        result: execResult.result,
                    });

                    return {
                        ...task,
                        status: "completed" as const,
                        result: execResult.result,
                        agentId: execResult.agentId,
                    };
                }),
            );

            for (let j = 0; j < settled.length; j++) {
                const settlement = settled[j]!;
                const task = batch[j]!;

                if (settlement.status === "fulfilled") {
                    results.push(settlement.value);
                } else {
                    const errorMessage = settlement.reason instanceof Error
                        ? settlement.reason.message
                        : String(settlement.reason);

                    this.emit({
                        type: "agent_failed",
                        agentId: task.id,
                        error: errorMessage,
                    });

                    results.push({
                        ...task,
                        status: "failed",
                        error: errorMessage,
                    });
                }
            }
        }

        // Include cancelled tasks from failed dependencies
        const cancelledTasks = wave
            .filter((t) => !runnableTasks.includes(t))
            .map((t) => ({
                ...t,
                status: "cancelled" as const,
                error: "Cancelled: dependency not met",
            }));

        return [...results, ...cancelledTasks];
    }

    /**
     * Topological sort of tasks by dependency graph.
     * Produces execution "waves" — all tasks in a wave can run in parallel.
     */
    private topologicalSort(tasks: SubTask[]): SubTask[][] {
        const taskMap = new Map(tasks.map((t) => [t.id, t]));
        const remaining = new Set(tasks.map((t) => t.id));
        const completed = new Set<string>();
        const waves: SubTask[][] = [];

        while (remaining.size > 0) {
            const wave: SubTask[] = [];
            for (const id of remaining) {
                const task = taskMap.get(id)!;
                const depsReady = task.dependencies.every((dep) => completed.has(dep));
                if (depsReady) {
                    wave.push(task);
                }
            }

            if (wave.length === 0) {
                process.stderr.write(
                    `[orchestrator] breaking dependency cycle: ${[...remaining].join(", ")}\n`,
                );
                const forced = [...remaining].map((id) => taskMap.get(id)!);
                waves.push(forced);
                break;
            }

            waves.push(wave);
            for (const task of wave) {
                remaining.delete(task.id);
                completed.add(task.id);
            }
        }

        return waves;
    }

    /** Emit an orchestration event via the configured callback. */
    private emit(event: OrchestrationEvent): void {
        try {
            this.config.onEvent?.(event);
        } catch {
            // Events must never crash the orchestration
        }
    }
}
