import type { SubTask, TaskPlan, ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { Tracer } from "../tracing/tracer.js";
import { getDb } from "../db/client.js";
import { agentNodes } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const REVIEWER_SYSTEM_PROMPT = `You are a reviewer agent. Your job is to review the results of sub-tasks that were executed to fulfill a user's request, then synthesize a final, coherent response.

Guidelines:
- Review each sub-task result for correctness and completeness
- If any results are incorrect or incomplete, note the issues clearly
- Synthesize all results into a single, well-structured response that directly addresses the user's original request
- Do NOT include meta-commentary about the review process itself — just provide the final answer
- If some tasks failed, work with what succeeded and note what couldn't be completed`;

export interface ReviewerConfig {
    gateway: Gateway;
    reviewerModelId: string;
    sessionId: string;
    parentAgentId: string;
}

export interface ReviewResult {
    /** True if all tasks succeeded adequately */
    approved: boolean;
    /** Reviewer's assessment summary */
    feedback: string;
    /** The synthesized response for the user */
    finalResponse: string;
    /** This reviewer's agent ID */
    agentId: string;
}

/**
 * Reviewer agent — validates executor results and synthesizes a final response.
 * Uses the smart model (70B) for reasoning quality.
 */
export class ReviewerAgent {
    private config: ReviewerConfig;

    constructor(config: ReviewerConfig) {
        this.config = config;
    }

    async review(plan: TaskPlan, completedTasks: SubTask[]): Promise<ReviewResult> {
        return Tracer.startSpan("reviewer.synthesize", "reviewer", async (span) => {
            const agentId = randomUUID();
            const db = getDb();
            const now = new Date().toISOString();

            // Register the reviewer agent node
            db.insert(agentNodes).values({
                agentId,
                role: "reviewer",
                modelId: this.config.reviewerModelId,
                parentAgentId: this.config.parentAgentId,
                sessionId: this.config.sessionId,
                status: "running",
                startTime: Date.now(),
                createdAt: now,
            }).run();

            try {
                // Format task results for the reviewer
                let tasksText = "";
                for (const task of completedTasks) {
                    tasksText += `\n## Task: ${task.title}\nStatus: ${task.status}\n`;
                    if (task.result) {
                        tasksText += `Result: ${task.result}\n`;
                    }
                    if (task.error) {
                        tasksText += `Error: ${task.error}\n`;
                    }
                }

                const userMessage = `The user's original request:\n"${plan.originalPrompt}"\n\nThe following sub-tasks were executed:\n${tasksText}\nReview these results and provide a final, synthesized response to the user.`;

                const messages: ChatMessage[] = [
                    { role: "system", content: REVIEWER_SYSTEM_PROMPT },
                    { role: "user", content: userMessage },
                ];

                const response = await this.config.gateway.complete(
                    messages,
                    this.config.reviewerModelId,
                );

                // Determine approval based on task statuses
                const failedCount = completedTasks.filter((t) => t.status === "failed").length;
                const approved = failedCount === 0;

                const feedback = approved
                    ? `All ${completedTasks.length} tasks completed successfully`
                    : `${completedTasks.length - failedCount} of ${completedTasks.length} tasks completed, ${failedCount} failed`;

                const reviewResult: ReviewResult = {
                    approved,
                    feedback,
                    finalResponse: response.message.content,
                    agentId,
                };

                // Mark reviewer agent as completed
                db.update(agentNodes)
                    .set({
                        status: "completed",
                        result: reviewResult.finalResponse,
                        endTime: Date.now(),
                    })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();

                span.attributes.approved = approved;
                span.attributes.taskCount = completedTasks.length;
                span.attributes.agentId = agentId;

                return reviewResult;
            } catch (error) {
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
