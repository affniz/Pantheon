import { eq, desc, sql } from "drizzle-orm";
import type { Span, Trace } from "@pantheon/shared";
import { getDb, type PantheonDatabase } from "../db/client.js";
import { spans as spansTable } from "../db/schema.js";

/**
 * Read-only query layer for traces and spans.
 * Used by the API server to serve /api/traces endpoints.
 */
export class TraceStore {
    private db: PantheonDatabase;

    constructor(db?: PantheonDatabase) {
        this.db = db ?? getDb();
    }

    /**
     * List recent traces — one entry per distinct traceId.
     * Returns the root span (no parentSpanId) for each trace, rolled up into a Trace summary.
     */
    listTraces(limit = 20): Trace[] {
        // Get the most recent root spans (one per trace)
        const rows = this.db
            .select()
            .from(spansTable)
            .where(sql`${spansTable.parentSpanId} IS NULL`)
            .orderBy(desc(spansTable.startTime))
            .limit(limit)
            .all();

        return rows.map((row) => {
            // Count all spans belonging to this trace
            const countResult = this.db
                .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
                .from(spansTable)
                .where(eq(spansTable.traceId, row.traceId))
                .get();

            const trace: Trace = {
                traceId: row.traceId,
                ...(row.sessionId ? { sessionId: row.sessionId } : {}),
                rootSpanName: row.name,
                startTime: row.startTime,
                ...(row.endTime !== null ? { endTime: row.endTime } : {}),
                ...(row.durationMs !== null ? { totalDurationMs: row.durationMs } : {}),
                spanCount: countResult?.count ?? 1,
                status: row.status as Trace["status"],
            };
            return trace;
        });
    }

    /** Return all spans for a given traceId, ordered by startTime. */
    getSpans(traceId: string): Span[] {
        const rows = this.db
            .select()
            .from(spansTable)
            .where(eq(spansTable.traceId, traceId))
            .orderBy(spansTable.startTime)
            .all();

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
            attributes: row.attributes ? JSON.parse(row.attributes as string) : {},
        }));
    }

    /** Delete all spans from the database. */
    clearAll(): void {
        this.db.delete(spansTable).run();
    }

    /**
     * Delete spans older than `olderThanDays` days.
     * Uses the `created_at` epoch-ms column for the cutoff.
     * Safe to call on every startup — the query is a no-op when there is nothing to prune.
     */
    pruneOldSpans(olderThanDays = 7): number {
        const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
        const result = this.db
            .delete(spansTable)
            .where(sql`${spansTable.createdAt} < ${cutoff}`)
            .run();
        return result.changes;
    }
}
