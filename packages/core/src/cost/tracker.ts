import { desc, sql } from "drizzle-orm";
import type { UsageRecord } from "@pantheon/shared";
import { getDb, type PantheonDatabase } from "../db/client.js";
import { usageRecords } from "../db/schema.js";

export class CostTracker {
    private db: PantheonDatabase;

    constructor(db?: PantheonDatabase) {
        this.db = db ?? getDb();
    }

    record(usage: Omit<UsageRecord, "id">): void {
        this.db
            .insert(usageRecords)
            .values({
                timestamp: usage.timestamp,
                modelId: usage.modelId,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costUsd: usage.costUsd,
                promptPreview: usage.promptPreview,
            })
            .run();
    }

    getSummary(): { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number } {
        const result = this.db
            .select({
                totalCalls: sql<number>`CAST(COUNT(*) AS INTEGER)`,
                totalInputTokens: sql<number>`CAST(COALESCE(SUM(${usageRecords.inputTokens}), 0) AS INTEGER)`,
                totalOutputTokens: sql<number>`CAST(COALESCE(SUM(${usageRecords.outputTokens}), 0) AS INTEGER)`,
                totalCostUsd: sql<number>`CAST(COALESCE(SUM(${usageRecords.costUsd}), 0) AS REAL)`,
            })
            .from(usageRecords)
            .get();
        return result || { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 };
    }

    getByModel(): Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> {
        const rows = this.db
            .select({
                modelId: usageRecords.modelId,
                calls: sql<number>`CAST(COUNT(*) AS INTEGER)`,
                inputTokens: sql<number>`CAST(COALESCE(SUM(${usageRecords.inputTokens}), 0) AS INTEGER)`,
                outputTokens: sql<number>`CAST(COALESCE(SUM(${usageRecords.outputTokens}), 0) AS INTEGER)`,
                costUsd: sql<number>`CAST(COALESCE(SUM(${usageRecords.costUsd}), 0) AS REAL)`,
            })
            .from(usageRecords)
            .groupBy(usageRecords.modelId)
            .all();

        return Object.fromEntries(
            rows.map((r) => [
                r.modelId,
                {
                    calls: r.calls,
                    inputTokens: r.inputTokens,
                    outputTokens: r.outputTokens,
                    costUsd: r.costUsd,
                },
            ])
        );
    }

    getRecent(n = 10): UsageRecord[] {
        return this.db
            .select()
            .from(usageRecords)
            .orderBy(desc(usageRecords.id))
            .limit(n)
            .all();
    }

    reset(): void {
        this.db.delete(usageRecords).run();
    }
}