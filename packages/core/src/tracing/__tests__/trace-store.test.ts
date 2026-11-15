import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Span } from "@pantheon/shared";
import { BACKENDS, useBackend, type Backend } from "../../db/__tests__/backends.js";
import type { PantheonDatabase } from "../../db/client.js";

// TraceCollector always writes to the singleton; point it at the backend under test.
let _activeDb: PantheonDatabase | null = null;
vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_activeDb) throw new Error("no active test database");
            return _activeDb;
        },
    };
});

const { tablesFor } = await import("../../db/client.js");
const { TraceStore } = await import("../store.js");
const { TraceCollector } = await import("../collector.js");
const { Tracer } = await import("../tracer.js");

function makeSpan(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
    return {
        name: "op",
        kind: "internal",
        startTime: 1_800_000_000_000,
        endTime: 1_800_000_000_100,
        durationMs: 100,
        status: "ok",
        attributes: {},
        ...overrides,
    };
}

describe.each(BACKENDS)("TraceStore + TraceCollector [$name]", (backend: Backend) => {
    const getDb = useBackend(backend);
    let store: InstanceType<typeof TraceStore>;

    beforeEach(async () => {
        await TraceCollector.flush();
        _activeDb = getDb();
        store = new TraceStore(getDb());
    });

    it("the collector persists recorded spans, including attributes and errors", async () => {
        TraceCollector.record(makeSpan({ spanId: "root", traceId: "t1", name: "agent.run", kind: "agent", sessionId: "s1", attributes: { tier: "complex", n: 3 } }));
        TraceCollector.record(makeSpan({ spanId: "child", traceId: "t1", parentSpanId: "root", name: "llm.completion", kind: "llm", status: "error", errorMessage: "rate limited", startTime: 1_800_000_000_010 }));
        await TraceCollector.flush();

        const spans = await store.getSpans("t1");
        expect(spans.map((s) => s.spanId)).toEqual(["root", "child"]);
        expect(spans[0]).toMatchObject({ name: "agent.run", kind: "agent", sessionId: "s1", status: "ok", durationMs: 100, attributes: { tier: "complex", n: 3 } });
        expect(spans[0]).not.toHaveProperty("parentSpanId");
        expect(spans[1]).toMatchObject({ parentSpanId: "root", status: "error", errorMessage: "rate limited" });
        // epoch-ms values survive unchanged (they exceed int4)
        expect(spans[0]!.startTime).toBe(1_800_000_000_000);
    });

    it("flush() resolves only after every queued span is written, including ones queued mid-flush", async () => {
        for (let i = 0; i < 25; i++) TraceCollector.record(makeSpan({ spanId: `s${i}`, traceId: "bulk" }));
        const flushing = TraceCollector.flush();
        TraceCollector.record(makeSpan({ spanId: "late", traceId: "bulk" }));
        await flushing;
        await TraceCollector.flush();
        expect(await store.getSpans("bulk")).toHaveLength(26);
    });

    it("recording the same span twice does not fail the batch", async () => {
        TraceCollector.record(makeSpan({ spanId: "dup", traceId: "t1" }));
        await TraceCollector.flush();
        TraceCollector.record(makeSpan({ spanId: "dup", traceId: "t1" }));
        TraceCollector.record(makeSpan({ spanId: "fresh", traceId: "t1" }));
        await TraceCollector.flush();
        expect((await store.getSpans("t1")).map((s) => s.spanId).sort()).toEqual(["dup", "fresh"]);
    });

    it("a database failure is logged, never thrown, and later spans still persist", async () => {
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            _activeDb = null; // getDb() now throws
            TraceCollector.record(makeSpan({ spanId: "lost", traceId: "t1" }));
            await expect(TraceCollector.flush()).resolves.toBeUndefined();
            expect(String(stderr.mock.calls[0]?.[0])).toMatch(/failed to persist 1 span/);
        } finally {
            stderr.mockRestore();
        }

        _activeDb = getDb();
        TraceCollector.record(makeSpan({ spanId: "kept", traceId: "t1" }));
        await TraceCollector.flush();
        expect((await store.getSpans("t1")).map((s) => s.spanId)).toEqual(["kept"]);
    });

    it("listTraces returns one entry per trace, newest first, with span counts", async () => {
        TraceCollector.record(makeSpan({ spanId: "a-root", traceId: "A", name: "first", startTime: 1000, sessionId: "s1" }));
        TraceCollector.record(makeSpan({ spanId: "a-1", traceId: "A", parentSpanId: "a-root", startTime: 1001 }));
        TraceCollector.record(makeSpan({ spanId: "a-2", traceId: "A", parentSpanId: "a-root", startTime: 1002 }));
        TraceCollector.record(makeSpan({ spanId: "b-root", traceId: "B", name: "second", startTime: 2000, status: "error" }));
        await TraceCollector.flush();

        const traces = await store.listTraces();
        expect(traces).toEqual([
            { traceId: "B", rootSpanName: "second", startTime: 2000, endTime: 1_800_000_000_100, totalDurationMs: 100, spanCount: 1, status: "error" },
            { traceId: "A", sessionId: "s1", rootSpanName: "first", startTime: 1000, endTime: 1_800_000_000_100, totalDurationMs: 100, spanCount: 3, status: "ok" },
        ]);
        expect((await store.listTraces(1)).map((t) => t.traceId)).toEqual(["B"]);
    });

    it("listTraces is empty when there are no spans", async () => {
        expect(await store.listTraces()).toEqual([]);
        expect(await store.getSpans("nothing")).toEqual([]);
    });

    it("clearAll removes every span", async () => {
        TraceCollector.record(makeSpan({ spanId: "x", traceId: "t1" }));
        await TraceCollector.flush();
        await store.clearAll();
        expect(await store.listTraces()).toEqual([]);
    });

    it("pruneOldSpans deletes only spans past the retention window and reports the count", async () => {
        const { spans } = tablesFor(getDb());
        const day = 24 * 60 * 60 * 1000;
        const row = (id: string, ageDays: number) => ({
            id, traceId: id, parentSpanId: null, sessionId: null, name: "n", kind: "internal",
            startTime: 1, endTime: 2, durationMs: 1, status: "ok", errorMessage: null, attributes: null,
            createdAt: Date.now() - ageDays * day,
        });
        await getDb().insert(spans).values([row("fresh", 1), row("week-old", 8), row("ancient", 400)]);

        expect(await store.pruneOldSpans(7)).toBe(2);
        expect((await store.listTraces()).map((t) => t.traceId)).toEqual(["fresh"]);
        expect(await store.pruneOldSpans(7)).toBe(0);
    });

    it("getSpans tolerates corrupt attributes JSON", async () => {
        const { spans } = tablesFor(getDb());
        await getDb().insert(spans).values({
            id: "bad", traceId: "t-bad", name: "n", kind: "internal", startTime: 1, endTime: 2,
            durationMs: 1, status: "ok", attributes: "{oops", createdAt: Date.now(),
        });
        expect((await store.getSpans("t-bad"))[0]!.attributes).toEqual({});
    });

    it("Tracer spans end up in the database with parent/child links and session id", async () => {
        const result = await Tracer.startTrace("session-9", async (traceId) => {
            await Tracer.startSpan("outer", "agent", async (outer) => {
                outer.attributes.step = 1;
                await Tracer.startSpan("inner", "tool", async () => "ok");
                await expect(
                    Tracer.startSpan("failing", "llm", async () => {
                        throw new Error("kaput");
                    }),
                ).rejects.toThrow("kaput");
            });
            return traceId;
        });
        await TraceCollector.flush();

        const spans = await store.getSpans(result);
        expect(spans).toHaveLength(3);
        const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
        expect(byName["outer"]).toMatchObject({ sessionId: "session-9", attributes: { step: 1 }, status: "ok" });
        expect(byName["outer"]).not.toHaveProperty("parentSpanId");
        expect(byName["inner"]!.parentSpanId).toBe(byName["outer"]!.spanId);
        expect(byName["failing"]).toMatchObject({ status: "error", errorMessage: "kaput", parentSpanId: byName["outer"]!.spanId });

        const [trace] = await store.listTraces();
        expect(trace).toMatchObject({ traceId: result, rootSpanName: "outer", spanCount: 3, sessionId: "session-9" });
    });
});
