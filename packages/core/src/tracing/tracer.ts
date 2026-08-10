import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Span, SpanKind } from "@pantheon/shared";
import { TraceCollector } from "./collector.js";

interface TraceContext {
    traceId: string;
    parentSpanId?: string;
    sessionId?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Lightweight OpenTelemetry-style tracer using AsyncLocalStorage for implicit
 * context propagation. No manual passing of traceId/parentSpanId is needed —
 * child spans automatically inherit context from their parent's async scope.
 *
 * Usage:
 *
 *   // Start a root trace (one per agent turn)
 *   await Tracer.startTrace(sessionId, async (traceId) => {
 *     // All spans started inside this callback are children of the root
 *     await Tracer.startSpan("router.classify", "routing", async (span) => {
 *       // ... do work ...
 *       span.attributes.tier = "standard";
 *     });
 *   });
 */
export class Tracer {
    /**
     * Start a root trace. Runs `fn` inside a new async context with a fresh traceId.
     * All spans opened within `fn` will belong to this trace.
     */
    static async startTrace<T>(
        sessionId: string | undefined,
        fn: (traceId: string) => Promise<T>
    ): Promise<T> {
        const traceId = randomUUID();
        const context: TraceContext = {
            traceId,
            ...(sessionId !== undefined ? { sessionId } : {}),
        };
        return traceStorage.run(context, () => fn(traceId));
    }

    /**
     * Instrument an operation with a span.
     *
     * - Automatically inherits traceId and sets parentSpanId from the current context.
     * - Records the span (via TraceCollector) when `fn` completes or throws.
     * - Re-throws any error after recording the error span.
     */
    static async startSpan<T>(
        name: string,
        kind: SpanKind,
        fn: (span: Span) => Promise<T>,
        initialAttributes: Record<string, unknown> = {}
    ): Promise<T> {
        const parentCtx = traceStorage.getStore();

        // If called outside a startTrace context, create an ad-hoc trace ID
        const traceId = parentCtx?.traceId ?? randomUUID();
        const parentSpanId = parentCtx?.parentSpanId;
        const spanId = randomUUID();

        const span: Span = {
            spanId,
            traceId,
            ...(parentSpanId !== undefined ? { parentSpanId } : {}),
            ...(parentCtx?.sessionId !== undefined ? { sessionId: parentCtx.sessionId } : {}),
            name,
            kind,
            startTime: Date.now(),
            status: "ok",
            attributes: { ...initialAttributes },
        };

        // Push this span as the new parent for any nested spans
        const childCtx: TraceContext = {
            traceId,
            parentSpanId: spanId,
            ...(parentCtx?.sessionId !== undefined ? { sessionId: parentCtx.sessionId } : {}),
        };

        return traceStorage.run(childCtx, async () => {
            try {
                const result = await fn(span);
                span.endTime = Date.now();
                span.durationMs = span.endTime - span.startTime;
                TraceCollector.record(span);
                return result;
            } catch (err) {
                span.endTime = Date.now();
                span.durationMs = span.endTime - span.startTime;
                span.status = "error";
                span.errorMessage = err instanceof Error ? err.message : String(err);
                TraceCollector.record(span);
                throw err;
            }
        });
    }

    /** Returns the active traceId, or undefined if called outside a trace context. */
    static currentTraceId(): string | undefined {
        return traceStorage.getStore()?.traceId;
    }
}
