import type { Span } from "@pantheon/shared";
import { getDb } from "../db/client.js";
import { spans as spansTable } from "../db/schema.js";

/**
 * Batches completed spans and flushes them to SQLite asynchronously.
 * Using queueMicrotask keeps the critical path (LLM calls, tool execution)
 * unblocked — the DB write happens after the current JS task completes.
 */
export class TraceCollector {
    private static queue: Span[] = [];
    private static flushing = false;

    /** Enqueue a completed span for persistence. Non-blocking. */
    static record(span: Span): void {
        TraceCollector.queue.push(span);
        queueMicrotask(() => TraceCollector.flush());
    }

    /** Flush all queued spans to the database. */
    private static flush(): void {
        if (TraceCollector.flushing || TraceCollector.queue.length === 0) return;
        TraceCollector.flushing = true;

        const batch = TraceCollector.queue.splice(0);

        try {
            const db = getDb();
            db.insert(spansTable)
                .values(
                    batch.map((s) => ({
                        id: s.spanId,
                        traceId: s.traceId,
                        parentSpanId: s.parentSpanId ?? null,
                        sessionId: s.sessionId ?? null,
                        name: s.name,
                        kind: s.kind,
                        startTime: s.startTime,
                        endTime: s.endTime ?? Date.now(),
                        durationMs: s.durationMs ?? 0,
                        status: s.status,
                        errorMessage: s.errorMessage ?? null,
                        attributes: s.attributes ? JSON.stringify(s.attributes) : null,
                        createdAt: Date.now(),
                    }))
                )
                .run();
        } catch (err) {
            // Best-effort — tracing must never crash the main request path
            process.stderr.write(`[tracer] failed to persist ${batch.length} span(s): ${err}\n`);
        } finally {
            TraceCollector.flushing = false;
        }
    }
}
