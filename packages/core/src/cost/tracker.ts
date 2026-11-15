import { desc, eq, count, sum } from "drizzle-orm";
import type { UsageRecord } from "@pantheon/shared";
import { DbStore } from "../db/store.js";

export class CostTracker extends DbStore {
    async record(usage: Omit<UsageRecord, "id">): Promise<void> {
        const { usageRecords } = this.t;
        await this.db.insert(usageRecords).values({
            timestamp: usage.timestamp,
            modelId: usage.modelId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: usage.costUsd,
            promptPreview: usage.promptPreview,
            ...(usage.sessionId ? { sessionId: usage.sessionId } : {}),
        });
    }

    /**
     * Totals for all usage, or for a single session when `sessionId` is given.
     */
    async getSummary(sessionId?: string): Promise<{ totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number }> {
        const { usageRecords } = this.t;
        // Aggregates come back as numbers on SQLite but as strings on PostgreSQL
        // (COUNT/SUM are bigint/numeric there), hence the Number() coercion.
        const [row] = await this.db
            .select({
                totalCalls: count(),
                totalInputTokens: sum(usageRecords.inputTokens),
                totalOutputTokens: sum(usageRecords.outputTokens),
                totalCostUsd: sum(usageRecords.costUsd),
            })
            .from(usageRecords)
            .where(sessionId ? eq(usageRecords.sessionId, sessionId) : undefined);
        return {
            totalCalls: Number(row?.totalCalls ?? 0),
            totalInputTokens: Number(row?.totalInputTokens ?? 0),
            totalOutputTokens: Number(row?.totalOutputTokens ?? 0),
            totalCostUsd: Number(row?.totalCostUsd ?? 0),
        };
    }

    async getByModel(sessionId?: string): Promise<Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>> {
        const { usageRecords } = this.t;
        const rows = await this.db
            .select({
                modelId: usageRecords.modelId,
                calls: count(),
                inputTokens: sum(usageRecords.inputTokens),
                outputTokens: sum(usageRecords.outputTokens),
                costUsd: sum(usageRecords.costUsd),
            })
            .from(usageRecords)
            .where(sessionId ? eq(usageRecords.sessionId, sessionId) : undefined)
            .groupBy(usageRecords.modelId);

        return Object.fromEntries(
            rows.map((r) => [
                r.modelId,
                {
                    calls: Number(r.calls),
                    inputTokens: Number(r.inputTokens ?? 0),
                    outputTokens: Number(r.outputTokens ?? 0),
                    costUsd: Number(r.costUsd ?? 0),
                },
            ])
        );
    }

    async getRecent(n = 10, sessionId?: string): Promise<UsageRecord[]> {
        const { usageRecords } = this.t;
        return this.db
            .select()
            .from(usageRecords)
            .where(sessionId ? eq(usageRecords.sessionId, sessionId) : undefined)
            .orderBy(desc(usageRecords.id))
            .limit(n);
    }

    async reset(): Promise<void> {
        const { usageRecords } = this.t;
        await this.db.delete(usageRecords);
    }
}
