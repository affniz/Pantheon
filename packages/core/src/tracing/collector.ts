import type { Span } from "@pantheon/shared";
import { getDb, tablesFor } from "../db/client.js";

/**
 * Batches completed spans and writes them to the database off the critical path:
 * `record()` only enqueues, and the write is started from a microtask so LLM calls
 * and tool execution never wait on tracing.
 */
export class TraceCollector {
    private static queue: Span[] = [];
    private static draining: Promise<void> | null = null;

    /** Enqueue a completed span for persistence. Non-blocking. */
    static record(span: Span): void {
        TraceCollector.queue.push(span);
        queueMicrotask(() => {
            void TraceCollector.flush();
        });
    }

    /**
     * Write every queued span and resolve once the queue is empty.
     * Called automatically; await it explicitly before shutdown or in tests.
     */
    static flush(): Promise<void> {
        if (!TraceCollector.draining) {
            TraceCollector.draining = TraceCollector.drain().finally(() => {
                TraceCollector.draining = null;
            });
        }
        return TraceCollector.draining;
    }

    private static async drain(): Promise<void> {
        // Spans recorded while a batch is being written are picked up by the next pass.
        while (TraceCollector.queue.length > 0) {
            const batch = TraceCollector.queue.splice(0);
            try {
                const db = getDb();
                const { spans } = tablesFor(db);
                await db
                    .insert(spans)
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
                    .onConflictDoNothing();
            } catch (err) {
                // Best-effort — tracing must never crash the main request path
                process.stderr.write(`[tracer] failed to persist ${batch.length} span(s): ${err}\n`);
            }
        }
    }
}
