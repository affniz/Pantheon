import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { ABRunRecord, ABComparison } from "@pantheon/shared";
import { getDb } from "../db/client.js";
import { schema } from "../db/index.js";

/**
 * ABStore persists A/B run records and computes comparison analytics.
 */
export class ABStore {
    /** Hash a prompt for grouping (first 16 hex chars of SHA-256). */
    static hashPrompt(prompt: string): string {
        return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    }

    /** Save a new A/B run record. Returns the saved record with generated ID and timestamp. */
    save(record: Omit<ABRunRecord, "id" | "createdAt">): ABRunRecord {
        const id = randomUUID();
        const createdAt = new Date().toISOString();

        const db = getDb();
        db.insert(schema.abRuns).values({
            id,
            experimentId: record.experimentId,
            ...(record.sessionId ? { sessionId: record.sessionId } : {}),
            promptHash: record.promptHash,
            arm: record.arm,
            modelId: record.modelId,
            latencyMs: record.latencyMs,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            ...(record.qualityScore !== undefined ? { qualityScore: record.qualityScore } : {}),
            createdAt,
        }).run();

        return { ...record, id, createdAt };
    }

    /** Update the quality score for an existing run. */
    updateQualityScore(id: string, qualityScore: number): void {
        const db = getDb();
        db.update(schema.abRuns)
            .set({ qualityScore })
            .where(eq(schema.abRuns.id, id))
            .run();
    }

    /** Get all runs for an experiment. */
    getRuns(experimentId: string): ABRunRecord[] {
        const db = getDb();
        const rows = db
            .select()
            .from(schema.abRuns)
            .where(eq(schema.abRuns.experimentId, experimentId))
            .all();

        return rows.map((r) => ({
            id: r.id,
            experimentId: r.experimentId,
            ...(r.sessionId ? { sessionId: r.sessionId } : { sessionId: "" }),
            promptHash: r.promptHash,
            arm: r.arm as "control" | "variant",
            modelId: r.modelId,
            latencyMs: r.latencyMs,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            ...(r.qualityScore !== null && r.qualityScore !== undefined ? { qualityScore: r.qualityScore } : {}),
            createdAt: r.createdAt,
        }));
    }

    /** Compute comparison analytics for an experiment. */
    getComparison(experimentId: string): ABComparison {
        const runs = this.getRuns(experimentId);
        const controlRuns = runs.filter((r) => r.arm === "control");
        const variantRuns = runs.filter((r) => r.arm === "variant");

        const avg = (arr: number[]): number =>
            arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

        const avgOrNull = (arr: (number | undefined)[]): number | null => {
            const valid = arr.filter((n): n is number => n !== undefined);
            return valid.length === 0 ? null : avg(valid);
        };

        return {
            experimentId,
            runCount: runs.length,
            controlRunCount: controlRuns.length,
            variantRunCount: variantRuns.length,
            controlAvgLatencyMs: avg(controlRuns.map((r) => r.latencyMs)),
            variantAvgLatencyMs: avg(variantRuns.map((r) => r.latencyMs)),
            controlAvgQualityScore: avgOrNull(controlRuns.map((r) => r.qualityScore)),
            variantAvgQualityScore: avgOrNull(variantRuns.map((r) => r.qualityScore)),
        };
    }
}
