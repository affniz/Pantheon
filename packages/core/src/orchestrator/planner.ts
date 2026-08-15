import type { SubTask, TaskPlan, ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { Tracer } from "../tracing/tracer.js";
import { getDb } from "../db/client.js";
import { taskPlans, subTasks, agentNodes } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const PLANNER_SYSTEM_PROMPT = `You are a Planner agent for a multi-agent coding assistant system.
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
- Generate typically 2–6 tasks
- Only add dependencies when there is a genuine ordering requirement
- Tasks without dependencies can run in parallel
- Assign taskRole accurately — it determines which specialist agent is used`;

export interface PlannerConfig {
    gateway: Gateway;
    plannerModelId: string;
    sessionId: string;
    parentAgentId?: string;
}

/**
 * Planner agent — decomposes a user prompt into an ordered set of sub-tasks.
 * Uses the smart model (70B) for reasoning about task decomposition.
 */
export class PlannerAgent {
    private config: PlannerConfig;

    constructor(config: PlannerConfig) {
        this.config = config;
    }

    async plan(prompt: string): Promise<TaskPlan> {
        return Tracer.startSpan("planner.decompose", "planner", async (span) => {
            const db = getDb();
            const agentId = randomUUID();
            const now = new Date().toISOString();

            // Register the planner agent node
            db.insert(agentNodes).values({
                agentId,
                role: "planner",
                modelId: this.config.plannerModelId,
                parentAgentId: this.config.parentAgentId ?? null,
                sessionId: this.config.sessionId,
                status: "running",
                startTime: Date.now(),
                createdAt: now,
            }).run();

            try {
                // Call the LLM to decompose the prompt
                const messages: ChatMessage[] = [
                    { role: "system", content: PLANNER_SYSTEM_PROMPT },
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
                        dependencies: t.dependencies,
                        status: "pending" as const,
                        taskRole: t.taskRole ?? "general",
                    }));

                // If validation stripped everything, fall back to a single task
                if (validTasks.length === 0) {
                    validTasks.push({
                        id: "task-1",
                        title: "Complete the request",
                        description: prompt,
                        dependencies: [],
                        status: "pending",
                    });
                }

                // Build the task plan
                const planId = randomUUID();
                const plan: TaskPlan = {
                    planId,
                    sessionId: this.config.sessionId,
                    originalPrompt: prompt,
                    tasks: validTasks,
                    createdAt: now,
                };

                // Persist the plan
                db.insert(taskPlans).values({
                    planId,
                    sessionId: this.config.sessionId,
                    originalPrompt: prompt,
                    createdAt: now,
                }).run();

                // Persist each sub-task
                for (const task of validTasks) {
                    db.insert(subTasks).values({
                        id: `${planId}_${task.id}`, // globally unique
                        planId,
                        title: task.title,
                        description: task.description,
                        dependencies: JSON.stringify(task.dependencies),
                        status: "pending",
                        createdAt: now,
                    }).run();
                }

                // Mark planner agent as completed
                db.update(agentNodes)
                    .set({ status: "completed", endTime: Date.now() })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();

                span.attributes.taskCount = plan.tasks.length;
                span.attributes.agentId = agentId;

                return plan;
            } catch (error) {
                // Mark planner agent as failed
                db.update(agentNodes)
                    .set({
                        status: "failed",
                        error: error instanceof Error ? error.message : String(error),
                        endTime: Date.now(),
                    })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();
                throw error;
            }
        });
    }
}
