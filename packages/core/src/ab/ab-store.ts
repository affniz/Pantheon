import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq, asc, desc } from "drizzle-orm";
import type { ABRunRecord, ABComparison } from "@pantheon/shared";
import { DbStore } from "../db/store.js";

/**
 * ABStore persists A/B run records and computes comparison analytics.
 */
export class ABStore extends DbStore {
    /** Hash a prompt for grouping (first 16 hex chars of SHA-256). */
    static hashPrompt(prompt: string): string {
        return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    }

    /** Save a new A/B run record. Returns the saved record with generated ID and timestamp. */
    async save(record: Omit<ABRunRecord, "id" | "createdAt">): Promise<ABRunRecord> {
        const { abRuns } = this.t;
        const id = randomUUID();
        const createdAt = new Date().toISOString();

        await this.db.insert(abRuns).values({
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
        });

        return { ...record, id, createdAt };
    }

    /** Update the quality score for an existing run. */
    async updateQualityScore(id: string, qualityScore: number): Promise<void> {
        const { abRuns } = this.t;
        await this.db.update(abRuns).set({ qualityScore }).where(eq(abRuns.id, id));
    }

    /**
     * Get runs for an experiment, oldest first.
     * With `limit`, returns only the most recent `limit` runs (still oldest first).
     */
    async getRuns(experimentId: string, limit?: number): Promise<ABRunRecord[]> {
        const { abRuns } = this.t;
        const base = this.db.select().from(abRuns).where(eq(abRuns.experimentId, experimentId));
        const rows = limit === undefined
            ? await base.orderBy(asc(abRuns.createdAt), asc(abRuns.id))
            : (await base.orderBy(desc(abRuns.createdAt), desc(abRuns.id)).limit(limit)).reverse();

        return rows.map((r) => ({
            id: r.id,
            experimentId: r.experimentId,
            sessionId: r.sessionId ?? "",
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
    async getComparison(experimentId: string): Promise<ABComparison> {
        const runs = await this.getRuns(experimentId);
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
