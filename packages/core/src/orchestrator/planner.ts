import type { SubTask, TaskPlan, ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { Tracer } from "../tracing/tracer.js";
import { OrchestrationStore } from "./store.js";
import { randomUUID } from "node:crypto";

const PLANNER_BASE_PROMPT = `You are a Planner agent for a multi-agent coding assistant system.
Your job is to decompose a user request into a set of actionable sub-tasks.

Output ONLY a valid JSON array of objects. Do NOT wrap it in markdown fences.
Each object must have:
- "id": a unique string identifier (e.g. "task-1", "task-2")
- "title": a short title for the task (under 80 chars)
- "description": a detailed description of what needs to be done
- "dependencies": an array of task IDs that must complete before this task starts (empty array if none)
- "taskRole": one of "code", "debug", or "general"
  - "code"    → use for writing new code, implementing features, modifications
  - "debug"   → use for bug investigation, error analysis, test failures, fixing
  - "general" → use for research, planning, documentation, Q&A

Guidelines:
- Keep tasks atomic — each one should be independently executable
- Generate AT MOST {MAX_SUB_TASKS} tasks (fewer is better if the task allows)
- Only add dependencies when there is a genuine ordering requirement
- Tasks without dependencies can run in parallel
- Assign taskRole accurately — it determines which specialist agent is used`;

function buildPlannerPrompt(maxSubTasks: number): string {
    return PLANNER_BASE_PROMPT.replace("{MAX_SUB_TASKS}", String(maxSubTasks));
}

export interface PlannerConfig {
    gateway: Gateway;
    plannerModelId: string;
    sessionId: string;
    parentAgentId?: string;
    /** Maximum number of sub-tasks to generate. Default: 3. Clamped to 1–6. */
    maxSubTasks?: number;
    /** Background the planner should know: repo map, memory of earlier sessions. */
    context?: string;
}

/**
 * Planner agent — decomposes a user prompt into an ordered set of sub-tasks.
 * Uses the complex-tier model (deepseek-v4-pro) for reasoning about task decomposition.
 *
 * Sub-task IDs returned by the LLM (e.g. "task-1") are only unique within one plan,
 * so they are rewritten to `${planId}_${id}` (dependencies included) before being
 * persisted. The specialist agents update `sub_tasks` rows by `task.id`, so the
 * in-memory ID and the DB primary key must be the same value.
 */
export class PlannerAgent {
    private config: PlannerConfig;

    constructor(config: PlannerConfig) {
        this.config = config;
    }

    async plan(prompt: string): Promise<TaskPlan> {
        return Tracer.startSpan("planner.decompose", "planner", async (span) => {
            const store = new OrchestrationStore();
            const agentId = randomUUID();
            const now = new Date().toISOString();

            await store.startAgent({
                agentId,
                role: "planner",
                modelId: this.config.plannerModelId,
                parentAgentId: this.config.parentAgentId,
                sessionId: this.config.sessionId,
            });

            try {
                // Call the LLM to decompose the prompt
                const messages: ChatMessage[] = [
                    { role: "system", content: buildPlannerPrompt(Math.min(6, Math.max(1, this.config.maxSubTasks ?? 3))) },
                    ...(this.config.context
                        ? [{ role: "system" as const, content: `Background (for planning only):\n${this.config.context}` }]
                        : []),
                    { role: "user", content: prompt },
                ];

                const response = await this.config.gateway.complete(
                    messages,
                    this.config.plannerModelId,
                );

                // Parse the JSON response
                let parsedTasks: Array<{
                    id: string;
                    title: string;
                    description: string;
                    dependencies: string[];
                    taskRole?: "code" | "debug" | "general";
                }>;

                try {
                    const raw = response.message.content.trim();
                    // Strip markdown fences if the model added them anyway
                    const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "");
                    const parsed = JSON.parse(cleaned);
                    if (!Array.isArray(parsed)) {
                        throw new Error("Response is not a JSON array");
                    }
                    parsedTasks = parsed;
                } catch {
                    // Fallback: treat the entire prompt as a single task
                    parsedTasks = [{
                        id: "task-1",
                        title: "Complete the request",
                        description: prompt,
                        dependencies: [],
                    }];
                }

                const VALID_ROLES = new Set(["code", "debug", "general"]);

                // Validate each task has the required fields
                const validTasks: SubTask[] = parsedTasks
                    .filter(
                        (t) =>
                            t.id && typeof t.id === "string" &&
                            t.title && typeof t.title === "string" &&
                            t.description && typeof t.description === "string" &&
                            Array.isArray(t.dependencies),
                    )
                    .map((t) => ({
                        id: t.id,
                        title: t.title,
                        description: t.description,
                        dependencies: t.dependencies.filter((d): d is string => typeof d === "string"),
                        status: "pending" as const,
                        taskRole: t.taskRole && VALID_ROLES.has(t.taskRole) ? t.taskRole : "general",
                    }));

                // If validation stripped everything, fall back to a single task
                if (validTasks.length === 0) {
                    validTasks.push({
                        id: "task-1",
                        title: "Complete the request",
                        description: prompt,
                        dependencies: [],
                        status: "pending",
                        taskRole: "general",
                    });
                }

                // Enforce the maxSubTasks cap
                const cap = Math.min(6, Math.max(1, this.config.maxSubTasks ?? 3));
                const planId = randomUUID();

                // Rewrite LLM-local IDs to globally unique IDs (and remap dependencies).
                // Dependencies on unknown or truncated tasks are dropped so a task is never
                // blocked forever on something that will not run.
                const keptLocalIds = new Set(validTasks.slice(0, cap).map((t) => t.id));
                const toGlobal = (localId: string) => `${planId}_${localId}`;
                const cappedTasks: SubTask[] = validTasks.slice(0, cap).map((t) => ({
                    ...t,
                    id: toGlobal(t.id),
                    dependencies: t.dependencies
                        .filter((d) => d !== t.id && keptLocalIds.has(d))
                        .map(toGlobal),
                }));

                // Build the task plan
                const plan: TaskPlan = {
                    planId,
                    sessionId: this.config.sessionId,
                    originalPrompt: prompt,
                    tasks: cappedTasks,
                    createdAt: now,
                };

                // Persist the plan and its sub-tasks (ids are already globally unique)
                await store.savePlan(plan);
                await store.completeAgent(agentId);

                span.attributes.taskCount = plan.tasks.length;
                span.attributes.agentId = agentId;

                return plan;
            } catch (error) {
                await store.failAgent(agentId, error);
                throw error;
            }
        });
    }
}
