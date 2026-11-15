import type { SubTask, TaskPlan, ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import { Tracer } from "../tracing/tracer.js";
import { OrchestrationStore } from "./store.js";
import { runVerification, type VerificationResult } from "./verifier.js";
import { randomUUID } from "node:crypto";

const REVIEWER_SYSTEM_PROMPT = `You are a reviewer agent. Your job is to review the results of sub-tasks that were executed to fulfill a user request, then synthesize a final, coherent response.

Guidelines:
- Review each sub-task result for correctness and completeness
- If any results are incorrect or incomplete, note the issues clearly
- Synthesize all results into a single, well-structured response that directly addresses the user original request
- Do NOT include meta-commentary about the review process itself just provide the final answer
- If some tasks failed, work with what succeeded and note what could not be completed
- If verification checks (TypeScript compilation or tests) failed, include the failure details in your response so the user can take action`;

export interface ReviewerConfig {
    gateway: Gateway;
    reviewerModelId: string;
    sessionId: string;
    parentAgentId: string;
    /** Sandbox used to run tsc and the project test command during verification */
    sandbox: Sandbox;
    /** Receives the synthesized answer as it is generated (for streaming to the user). */
    onText?: (delta: string) => void;
}

export interface ReviewResult {
    /** True if all tasks succeeded and verification checks passed */
    approved: boolean;
    /** Reviewer assessment summary */
    feedback: string;
    /** The synthesized response for the user */
    finalResponse: string;
    /** This reviewer agent ID */
    agentId: string;
}

/**
 * Reviewer agent validates executor results, runs tsc + tests to verify
 * correctness, then synthesizes a final response.
 */
export class ReviewerAgent {
    private config: ReviewerConfig;

    constructor(config: ReviewerConfig) {
        this.config = config;
    }

    /**
     * @param verification Result of a verification that already ran (the orchestrator
     *   verifies — and attempts fixes — before review). When omitted, the reviewer
     *   runs the checks itself.
     * @param context Extra facts for the reviewer's judgement, e.g. that the project
     *   was already failing before this run.
     */
    async review(
        plan: TaskPlan,
        completedTasks: SubTask[],
        verification?: VerificationResult,
        context: { baselineFailing?: boolean; fixRounds?: number } = {},
    ): Promise<ReviewResult> {
        return Tracer.startSpan("reviewer.synthesize", "reviewer", async (span) => {
            const agentId = randomUUID();
            const store = new OrchestrationStore();

            await store.startAgent({
                agentId,
                role: "reviewer",
                modelId: this.config.reviewerModelId,
                parentAgentId: this.config.parentAgentId,
                sessionId: this.config.sessionId,
            });

            try {
                // Verification — reuse the orchestrator's result when there is one
                const checked = verification ?? await runVerification(this.config.sandbox);
                // Failures that were there before this run started are reported, but are
                // not held against the work that was just done.
                const verificationPassed = checked.passed || context.baselineFailing === true;
                if (!checked.passed) process.stderr.write("[reviewer] verification failed\n");

                const verificationNotes: string[] = [...checked.notes];
                if (checked.failures) verificationNotes.push(checked.failures);
                if (context.baselineFailing) {
                    verificationNotes.push(
                        "NOTE: these checks were already failing before this request was started; " +
                        "the failures are not necessarily caused by the changes made now.",
                    );
                }
                if (context.fixRounds) {
                    verificationNotes.push(
                        checked.passed
                            ? `Verification passed after ${context.fixRounds} automatic fix round(s).`
                            : `${context.fixRounds} automatic fix round(s) were attempted without resolving the failures.`,
                    );
                }

                // Format task results for the reviewer
                let tasksText = "";
                for (const task of completedTasks) {
                    tasksText += "\n## Task: " + task.title + "\nStatus: " + task.status + "\n";
                    if (task.result) tasksText += "Result: " + task.result + "\n";
                    if (task.error) tasksText += "Error: " + task.error + "\n";
                }

                const verificationSection = verificationNotes.length > 0
                    ? "\n\nVerification results:\n" + verificationNotes.join("\n")
                    : "";

                const userMessage =
                    "The user's original request:\n\"" + plan.originalPrompt + "\"\n\n" +
                    "The following sub-tasks were executed:\n" + tasksText +
                    verificationSection +
                    "\nReview these results and provide a final, synthesized response to the user.";

                const messages: ChatMessage[] = [
                    { role: "system", content: REVIEWER_SYSTEM_PROMPT },
                    { role: "user", content: userMessage },
                ];

                const response = await this.config.gateway.complete(
                    messages,
                    this.config.reviewerModelId,
                    undefined,
                    this.config.onText ? { onToken: this.config.onText } : {},
                );

                const failedCount = completedTasks.filter((t) => t.status === "failed").length;
                const approved = failedCount === 0 && verificationPassed;

                const parts: string[] = [];
                if (failedCount === 0) {
                    parts.push("All " + completedTasks.length + " tasks completed");
                } else {
                    parts.push((completedTasks.length - failedCount) + "/" + completedTasks.length + " tasks completed");
                }
                if (!verificationPassed) parts.push("verification failed (see response)");
                const feedback = parts.join("; ");

                const reviewResult: ReviewResult = {
                    approved,
                    feedback,
                    finalResponse: response.message.content,
                    agentId,
                };

                await store.completeAgent(agentId, reviewResult.finalResponse);

                span.attributes.approved = approved;
                span.attributes.taskCount = completedTasks.length;
                span.attributes.verificationPassed = verificationPassed;
                span.attributes.agentId = agentId;

                return reviewResult;
            } catch (error) {
                await store.failAgent(agentId, error);
                throw error;
            }
        });
    }
}
