import { eq, desc, asc, lt, isNull, inArray, count } from "drizzle-orm";
import type { Span, Trace } from "@pantheon/shared";
import { DbStore } from "../db/store.js";

/**
 * Query layer for traces and spans.
 * Used by the API server to serve /api/traces endpoints.
 */
export class TraceStore extends DbStore {
    /**
     * List recent traces — one entry per distinct traceId.
     * Returns the root span (no parentSpanId) for each trace, rolled up into a Trace summary.
     */
    async listTraces(limit = 20): Promise<Trace[]> {
        const { spans } = this.t;

        // Get the most recent root spans (one per trace)
        const rows = await this.db
            .select()
            .from(spans)
            .where(isNull(spans.parentSpanId))
            .orderBy(desc(spans.startTime))
            .limit(limit);
        if (rows.length === 0) return [];

        // Span counts for all listed traces in one grouped query (was one query per trace)
        const counts = await this.db
            .select({ traceId: spans.traceId, n: count() })
            .from(spans)
            .where(inArray(spans.traceId, [...new Set(rows.map((r) => r.traceId))]))
            .groupBy(spans.traceId);
        const countByTrace = new Map(counts.map((c) => [c.traceId, Number(c.n)]));

        return rows.map((row): Trace => ({
            traceId: row.traceId,
            ...(row.sessionId ? { sessionId: row.sessionId } : {}),
            rootSpanName: row.name,
            startTime: row.startTime,
            ...(row.endTime !== null ? { endTime: row.endTime } : {}),
            ...(row.durationMs !== null ? { totalDurationMs: row.durationMs } : {}),
            spanCount: countByTrace.get(row.traceId) ?? 1,
            status: row.status as Trace["status"],
        }));
    }

    /** Return all spans for a given traceId, ordered by startTime. */
    async getSpans(traceId: string): Promise<Span[]> {
        const { spans } = this.t;
        const rows = await this.db
            .select()
            .from(spans)
            .where(eq(spans.traceId, traceId))
            .orderBy(asc(spans.startTime));

        return rows.map((row): Span => ({
            spanId: row.id,
            traceId: row.traceId,
            ...(row.parentSpanId ? { parentSpanId: row.parentSpanId } : {}),
            ...(row.sessionId ? { sessionId: row.sessionId } : {}),
            name: row.name,
            kind: row.kind as Span["kind"],
            startTime: row.startTime,
            ...(row.endTime !== null ? { endTime: row.endTime } : {}),
            ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
            status: row.status as Span["status"],
            ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
            attributes: parseAttributes(row.attributes),
        }));
    }

    /** Delete all spans from the database. */
    async clearAll(): Promise<void> {
        const { spans } = this.t;
        await this.db.delete(spans);
    }

    /**
     * Delete spans older than `olderThanDays` days; returns how many were removed.
     * Uses the `created_at` epoch-ms column for the cutoff.
     */
    async pruneOldSpans(olderThanDays = 7): Promise<number> {
        const { spans } = this.t;
        const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
        const removed = await this.db
            .delete(spans)
            .where(lt(spans.createdAt, cutoff))
            .returning({ id: spans.id });
        return removed.length;
    }
}

function parseAttributes(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
}
