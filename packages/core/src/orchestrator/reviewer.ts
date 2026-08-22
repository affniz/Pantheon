import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { SubTask, TaskPlan, ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import { Tracer } from "../tracing/tracer.js";
import { getDb } from "../db/client.js";
import { agentNodes } from "../db/schema.js";
import { eq } from "drizzle-orm";
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

/** Run a command and return { success, output } */
async function runCheck(
    bin: string,
    args: string[],
    cwd: string,
    timeoutMs = 60_000,
): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
        execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
            const output = [stdout, stderr].filter(Boolean).join("\n").trim();
            resolve({ success: !err, output });
        });
    });
}

/**
 * Detect the project test command from package.json.
 * Returns null if no recognisable test script is found.
 */
function detectTestCommand(projectRoot: string): { bin: string; args: string[] } | null {
    try {
        const pkgPath = path.join(projectRoot, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
            scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};

        if (scripts["vitest"]) return { bin: "pnpm", args: ["vitest", "run"] };
        if (scripts["test"]) {
            const cmd = scripts["test"];
            if (cmd.includes("vitest")) return { bin: "pnpm", args: ["vitest", "run"] };
            if (cmd.includes("jest")) return { bin: "pnpm", args: ["jest", "--passWithNoTests"] };
            return { bin: "pnpm", args: ["test"] };
        }
        return null;
    } catch {
        return null;
    }
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

    async review(plan: TaskPlan, completedTasks: SubTask[]): Promise<ReviewResult> {
        return Tracer.startSpan("reviewer.synthesize", "reviewer", async (span) => {
            const agentId = randomUUID();
            const db = getDb();
            const now = new Date().toISOString();

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
                // Verification pass
                const verificationNotes: string[] = [];
                let verificationPassed = true;

                // 1. TypeScript compilation check
                const tscResult = await runCheck(
                    "npx",
                    ["tsc", "--noEmit"],
                    this.config.sandbox.projectRoot,
                    60_000,
                );
                if (!tscResult.success) {
                    verificationPassed = false;
                    verificationNotes.push(
                        "TypeScript compilation FAILED:\n" + tscResult.output.slice(0, 3000),
                    );
                    process.stderr.write("[reviewer] tsc --noEmit failed\n");
                } else {
                    verificationNotes.push("TypeScript compilation: PASSED");
                }

                // 2. Test suite
                const testCmd = detectTestCommand(this.config.sandbox.projectRoot);
                if (testCmd) {
                    const testResult = await runCheck(
                        testCmd.bin,
                        testCmd.args,
                        this.config.sandbox.projectRoot,
                        120_000,
                    );
                    if (!testResult.success) {
                        verificationPassed = false;
                        verificationNotes.push(
                            "Test suite FAILED:\n" + testResult.output.slice(0, 3000),
                        );
                        process.stderr.write("[reviewer] test suite failed\n");
                    } else {
                        verificationNotes.push("Test suite: PASSED");
                    }
                } else {
                    verificationNotes.push("Test suite: no test command detected in package.json");
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

                db.update(agentNodes)
                    .set({ status: "completed", result: reviewResult.finalResponse, endTime: Date.now() })
                    .where(eq(agentNodes.agentId, agentId))
                    .run();

                span.attributes.approved = approved;
                span.attributes.taskCount = completedTasks.length;
                span.attributes.verificationPassed = verificationPassed;
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
