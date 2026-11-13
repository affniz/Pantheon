import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import { ABStore } from "../ab-store.js";

// ── DB mock ───────────────────────────────────────────────────────────────────
let _testDb: ReturnType<typeof createTestDb> | null = null;

vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_testDb) {
                _testDb = createTestDb(new Database(":memory:"));
            }
            return _testDb;
        },
    };
});

type SaveInput = Parameters<ABStore["save"]>[0];

function makeRecord(overrides: Partial<SaveInput> = {}): SaveInput {
    return {
        experimentId: "exp-1",
        // Note: sessionId is omitted by default — it has a FK constraint on sessions.id
        promptHash: ABStore.hashPrompt("test prompt"),
        arm: "control" as const,
        modelId: "deepseek-v4-flash",
        latencyMs: 250,
        inputTokens: 100,
        outputTokens: 200,
        // sessionId is required by the ABRunRecord type; empty string = "no session"
        // (ABStore.save() omits falsy sessionIds so the FK is not violated).
        sessionId: "",
        ...overrides,
    } as SaveInput;
}

describe("ABStore", () => {
    let store: ABStore;

    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
        store = new ABStore();
    });

    // ── hashPrompt ────────────────────────────────────────────────────────────

    describe("hashPrompt()", () => {
        it("returns a 16-char hex string", () => {
            const hash = ABStore.hashPrompt("hello");
            expect(hash).toHaveLength(16);
            expect(hash).toMatch(/^[0-9a-f]+$/);
        });

        it("is deterministic for the same prompt", () => {
            expect(ABStore.hashPrompt("prompt")).toBe(ABStore.hashPrompt("prompt"));
        });

        it("produces different hashes for different prompts", () => {
            expect(ABStore.hashPrompt("prompt A")).not.toBe(ABStore.hashPrompt("prompt B"));
        });
    });

    // ── save ──────────────────────────────────────────────────────────────────

    describe("save()", () => {
        it("returns a record with a generated UUID id", () => {
            const saved = store.save(makeRecord());
            expect(typeof saved.id).toBe("string");
            expect(saved.id.length).toBeGreaterThan(0);
        });

        it("returns a record with a createdAt ISO timestamp", () => {
            const saved = store.save(makeRecord());
            expect(() => new Date(saved.createdAt)).not.toThrow();
            expect(new Date(saved.createdAt).getTime()).toBeGreaterThan(0);
        });

        it("preserves all supplied fields", () => {
            const record = makeRecord({ arm: "variant", modelId: "deepseek-v4-pro", latencyMs: 800 });
            const saved = store.save(record);
            expect(saved.arm).toBe("variant");
            expect(saved.modelId).toBe("deepseek-v4-pro");
            expect(saved.latencyMs).toBe(800);
        });

        it("saves a run with qualityScore", () => {
            const saved = store.save(makeRecord({ qualityScore: 8 }));
            expect(saved.qualityScore).toBe(8);
        });

        it("generates different IDs for separate saves", () => {
            const a = store.save(makeRecord());
            const b = store.save(makeRecord());
            expect(a.id).not.toBe(b.id);
        });
    });

    // ── getRuns ───────────────────────────────────────────────────────────────

    describe("getRuns()", () => {
        it("returns empty array when no runs exist", () => {
            expect(store.getRuns("exp-none")).toEqual([]);
        });

        it("returns all runs for the experiment", () => {
            store.save(makeRecord({ experimentId: "exp-X" }));
            store.save(makeRecord({ experimentId: "exp-X" }));
            store.save(makeRecord({ experimentId: "exp-Y" }));
            const runs = store.getRuns("exp-X");
            expect(runs).toHaveLength(2);
        });

        it("does not return runs from a different experiment", () => {
            store.save(makeRecord({ experimentId: "exp-A" }));
            store.save(makeRecord({ experimentId: "exp-B" }));
            expect(store.getRuns("exp-A")).toHaveLength(1);
            expect(store.getRuns("exp-B")).toHaveLength(1);
        });

        it("returns correct arm values", () => {
            store.save(makeRecord({ arm: "control" }));
            store.save(makeRecord({ arm: "variant" }));
            const runs = store.getRuns("exp-1");
            const arms = runs.map((r) => r.arm);
            expect(arms).toContain("control");
            expect(arms).toContain("variant");
        });

        it("returns run without qualityScore when not set", () => {
            store.save(makeRecord());
            const runs = store.getRuns("exp-1");
            expect(runs[0]!.qualityScore).toBeUndefined();
        });

        it("returns run with qualityScore when set", () => {
            store.save(makeRecord({ qualityScore: 7 }));
            const runs = store.getRuns("exp-1");
            expect(runs[0]!.qualityScore).toBe(7);
        });
    });

    // ── updateQualityScore ────────────────────────────────────────────────────

    describe("updateQualityScore()", () => {
        it("sets quality score on an existing run", () => {
            const saved = store.save(makeRecord());
            store.updateQualityScore(saved.id, 9);
            const runs = store.getRuns("exp-1");
            const updated = runs.find((r) => r.id === saved.id);
            expect(updated?.qualityScore).toBe(9);
        });

        it("does not affect other runs in the experiment", () => {
            const a = store.save(makeRecord());
            const b = store.save(makeRecord());
            store.updateQualityScore(a.id, 5);
            const runs = store.getRuns("exp-1");
            const bRun = runs.find((r) => r.id === b.id);
            expect(bRun?.qualityScore).toBeUndefined();
        });

        it("can update quality score multiple times", () => {
            const saved = store.save(makeRecord());
            store.updateQualityScore(saved.id, 3);
            store.updateQualityScore(saved.id, 9);
            const runs = store.getRuns("exp-1");
            expect(runs[0]!.qualityScore).toBe(9);
        });
    });

    // ── getComparison ─────────────────────────────────────────────────────────

    describe("getComparison()", () => {
        it("returns zero counts for empty experiment", () => {
            const c = store.getComparison("exp-empty");
            expect(c.runCount).toBe(0);
            expect(c.controlRunCount).toBe(0);
            expect(c.variantRunCount).toBe(0);
            expect(c.controlAvgLatencyMs).toBe(0);
            expect(c.variantAvgLatencyMs).toBe(0);
            expect(c.controlAvgQualityScore).toBeNull();
            expect(c.variantAvgQualityScore).toBeNull();
        });

        it("correctly counts control and variant runs", () => {
            store.save(makeRecord({ arm: "control" }));
            store.save(makeRecord({ arm: "control" }));
            store.save(makeRecord({ arm: "variant" }));
            const c = store.getComparison("exp-1");
            expect(c.runCount).toBe(3);
            expect(c.controlRunCount).toBe(2);
            expect(c.variantRunCount).toBe(1);
        });

        it("computes correct average latency per arm", () => {
            store.save(makeRecord({ arm: "control", latencyMs: 100 }));
            store.save(makeRecord({ arm: "control", latencyMs: 300 }));
            store.save(makeRecord({ arm: "variant", latencyMs: 200 }));
            const c = store.getComparison("exp-1");
            expect(c.controlAvgLatencyMs).toBe(200);
            expect(c.variantAvgLatencyMs).toBe(200);
        });

        it("computes average quality score when scores are set", () => {
            const r1 = store.save(makeRecord({ arm: "control" }));
            const r2 = store.save(makeRecord({ arm: "control" }));
            store.save(makeRecord({ arm: "variant" }));
            store.updateQualityScore(r1.id, 6);
            store.updateQualityScore(r2.id, 8);
            const c = store.getComparison("exp-1");
            expect(c.controlAvgQualityScore).toBe(7);
            expect(c.variantAvgQualityScore).toBeNull();
        });

        it("includes experimentId in result", () => {
            const c = store.getComparison("my-exp");
            expect(c.experimentId).toBe("my-exp");
        });

        it("only includes runs from the specified experiment", () => {
            store.save(makeRecord({ experimentId: "exp-1", arm: "control", latencyMs: 100 }));
            store.save(makeRecord({ experimentId: "exp-2", arm: "control", latencyMs: 9999 }));
            const c = store.getComparison("exp-1");
            expect(c.runCount).toBe(1);
            expect(c.controlAvgLatencyMs).toBe(100);
        });
    });
});
