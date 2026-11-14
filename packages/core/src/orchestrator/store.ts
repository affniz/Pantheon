import { eq, desc, and, lte } from "drizzle-orm";
import type { AgentNode, AgentRole, AgentStatus, TaskPlan } from "@pantheon/shared";
import { DbStore } from "../db/store.js";
import type { Tables } from "../db/client.js";

/** Raw `agent_nodes` row, as served by `/api/agents`. */
export type AgentNodeRow = Tables["agentNodes"]["$inferSelect"];
/** Raw `task_plans` row. */
export type TaskPlanRow = Tables["taskPlans"]["$inferSelect"];
/** `sub_tasks` row with `dependencies` decoded from JSON. */
export type SubTaskRow = Omit<Tables["subTasks"]["$inferSelect"], "dependencies"> & { dependencies: string[] };

/**
 * Persistence for multi-agent orchestration: the agent tree (`agent_nodes`), task
 * plans and their sub-tasks. Every orchestration agent goes through this one class
 * instead of issuing its own queries.
 */
export class OrchestrationStore extends DbStore {
    // ── Agent nodes ──────────────────────────────────────────────────────────

    /** Record a new agent in the `running` state. */
    async startAgent(agent: {
        agentId: string;
        role: AgentRole;
        modelId: string;
        sessionId: string;
        parentAgentId?: string | undefined;
        taskId?: string | undefined;
    }): Promise<void> {
        const { agentNodes } = this.t;
        await this.db.insert(agentNodes).values({
            agentId: agent.agentId,
            role: agent.role,
            modelId: agent.modelId,
            parentAgentId: agent.parentAgentId ?? null,
            sessionId: agent.sessionId,
            taskId: agent.taskId ?? null,
            status: "running",
            startTime: Date.now(),
            createdAt: new Date().toISOString(),
        });
    }

    async completeAgent(agentId: string, result?: string): Promise<void> {
        const { agentNodes } = this.t;
        await this.db
            .update(agentNodes)
            .set({ status: "completed", ...(result !== undefined ? { result } : {}), endTime: Date.now() })
            .where(eq(agentNodes.agentId, agentId));
    }

    /**
     * Mark an agent as failed. Never throws: this runs inside `catch` blocks, where
     * a secondary database error would otherwise replace the original failure.
     */
    async failAgent(agentId: string, error: unknown): Promise<void> {
        try {
            const { agentNodes } = this.t;
            await this.db
                .update(agentNodes)
                .set({ status: "failed", error: errorMessage(error), endTime: Date.now() })
                .where(eq(agentNodes.agentId, agentId));
        } catch (dbErr) {
            process.stderr.write(`[orchestration] could not record failure of agent ${agentId}: ${errorMessage(dbErr)}\n`);
        }
    }

    async getAgent(agentId: string): Promise<AgentNodeRow | undefined> {
        const { agentNodes } = this.t;
        const [row] = await this.db.select().from(agentNodes).where(eq(agentNodes.agentId, agentId)).limit(1);
        return row;
    }

    /** Agent rows, newest first, optionally restricted to one session. */
    async listAgents(options: { sessionId?: string | undefined; limit?: number } = {}): Promise<AgentNodeRow[]> {
        const { agentNodes } = this.t;
        return this.db
            .select()
            .from(agentNodes)
            .where(options.sessionId ? eq(agentNodes.sessionId, options.sessionId) : undefined)
            .orderBy(desc(agentNodes.startTime))
            .limit(options.limit ?? 20);
    }

    /** All agents that took part in one orchestration run (the root plus its descendants). */
    async getAgentTree(rootAgentId: string): Promise<AgentNode[]> {
        const root = await this.getAgent(rootAgentId);
        if (!root) return [];
        const { agentNodes } = this.t;
        // Sub-agents are direct children of the orchestrator; fetch them in one query.
        const children = await this.db
            .select()
            .from(agentNodes)
            .where(eq(agentNodes.parentAgentId, rootAgentId))
            .orderBy(agentNodes.startTime);
        return [root, ...children].map(toAgentNode);
    }

    // ── Plans & sub-tasks ────────────────────────────────────────────────────

    /** Persist a plan together with its (pending) sub-tasks. */
    async savePlan(plan: TaskPlan): Promise<void> {
        const { taskPlans, subTasks } = this.t;
        await this.db.insert(taskPlans).values({
            planId: plan.planId,
            sessionId: plan.sessionId,
            originalPrompt: plan.originalPrompt,
            createdAt: plan.createdAt,
        });
        if (plan.tasks.length === 0) return;
        await this.db.insert(subTasks).values(
            plan.tasks.map((task) => ({
                id: task.id,
                planId: plan.planId,
                title: task.title,
                description: task.description,
                dependencies: JSON.stringify(task.dependencies),
                taskRole: task.taskRole ?? "general",
                status: task.status,
                createdAt: plan.createdAt,
            })),
        );
    }

    /** Update a sub-task's lifecycle fields. Only the provided fields are written. */
    async updateSubTask(
        taskId: string,
        patch: { status: AgentStatus; agentId?: string; result?: string; error?: string },
    ): Promise<void> {
        const { subTasks } = this.t;
        await this.db.update(subTasks).set(patch).where(eq(subTasks.id, taskId));
    }

    /** Like `updateSubTask`, but never throws — for use while already handling an error. */
    async failSubTask(taskId: string, error: unknown): Promise<void> {
        try {
            await this.updateSubTask(taskId, { status: "failed", error: errorMessage(error) });
        } catch (dbErr) {
            process.stderr.write(`[orchestration] could not record failure of task ${taskId}: ${errorMessage(dbErr)}\n`);
        }
    }

    async getSubTasks(planId: string): Promise<SubTaskRow[]> {
        const { subTasks } = this.t;
        const rows = await this.db.select().from(subTasks).where(eq(subTasks.planId, planId)).orderBy(subTasks.id);
        return rows.map((t) => ({ ...t, dependencies: parseDependencies(t.dependencies) }));
    }

    /**
     * The plan an agent belongs to. A session can be orchestrated several times, so
     * this picks the plan created most recently at or before the agent started
     * (falling back to the session's newest plan).
     */
    async getPlanForAgent(agent: Pick<AgentNodeRow, "sessionId" | "startTime">): Promise<TaskPlanRow | undefined> {
        const { taskPlans } = this.t;
        // created_at is an ISO-8601 UTC string, so string comparison is chronological.
        const startedAt = new Date(agent.startTime + 1000).toISOString();
        const [before] = await this.db
            .select()
            .from(taskPlans)
            .where(and(eq(taskPlans.sessionId, agent.sessionId), lte(taskPlans.createdAt, startedAt)))
            .orderBy(desc(taskPlans.createdAt))
            .limit(1);
        if (before) return before;

        const [latest] = await this.db
            .select()
            .from(taskPlans)
            .where(eq(taskPlans.sessionId, agent.sessionId))
            .orderBy(desc(taskPlans.createdAt))
            .limit(1);
        return latest;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseDependencies(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
    } catch {
        return [];
    }
}

function toAgentNode(row: AgentNodeRow): AgentNode {
    return {
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
    };
}

