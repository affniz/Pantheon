/** The category of work a span represents */
export type SpanKind = "http" | "routing" | "llm" | "tool" | "agent" | "orchestrator" | "planner" | "reviewer" | "executor" | "internal";

/** Whether the span completed successfully or with an error */
export type SpanStatus = "ok" | "error";

/**
 * A single unit of work within a trace.
 * Spans form a tree — each span (except the root) has a parentSpanId.
 */
export interface Span {
    /** Unique span identifier (UUID) */
    spanId: string;
    /** The root trace this span belongs to */
    traceId: string;
    /** Parent span — absent on the root span */
    parentSpanId?: string;
    /** Associated chat session, if any */
    sessionId?: string;
    /**
     * Human-readable span name.
     * Convention: "<category>.<operation>", e.g. "llm.completion", "tool.readFile", "router.classify"
     */
    name: string;
    kind: SpanKind;
    /** Epoch millisecond timestamp of when the span started */
    startTime: number;
    /** Epoch millisecond timestamp of when the span ended */
    endTime?: number;
    durationMs?: number;
    status: SpanStatus;
    /** Error message — only present when status === "error" */
    errorMessage?: string;
    /** Structured metadata: tokens, model, tool args, etc. */
    attributes: Record<string, unknown>;
}

/**
 * A rolled-up summary of a full trace (one agent turn).
 * Derived from the root span of a trace.
 */
export interface Trace {
    traceId: string;
    sessionId?: string;
    /** Name of the root span */
    rootSpanName: string;
    startTime: number;
    endTime?: number;
    totalDurationMs?: number;
    spanCount: number;
    status: SpanStatus;
}
