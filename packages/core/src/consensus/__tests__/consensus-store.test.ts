import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { BACKENDS, useBackend } from "../../db/__tests__/backends.js";
import { tablesFor } from "../../db/client.js";
import { SessionManager } from "../../session/session-manager.js";
import { ConsensusStore } from "../consensus-store.js";

const RESPONSES = [
    { modelId: "a", content: "answer A", latencyMs: 10, inputTokens: 1, outputTokens: 2 },
    { modelId: "b", content: "", latencyMs: 0, inputTokens: 0, outputTokens: 0, error: "timeout" },
];

describe.each(BACKENDS)("ConsensusStore [$name]", (backend) => {
    const getDb = useBackend(backend);
    let store: ConsensusStore;

    beforeEach(() => {
        store = new ConsensusStore(getDb());
    });

    const run = (id: string, extra: { sessionId?: string } = {}) => ({
        id,
        promptHash: "hash-" + id,
        synthesizedContent: "synth " + id,
        responses: RESPONSES,
        synthesisLatencyMs: 42,
        ...extra,
    });

    it("save + get round-trips a run, decoding per-model responses", async () => {
        await store.save(run("r1"));
        const saved = await store.get("r1");
        expect(saved).toMatchObject({
            id: "r1", sessionId: null, promptHash: "hash-r1", synthesizedContent: "synth r1",
            synthesisLatencyMs: 42, qualityScore: null,
        });
        expect(saved!.modelResponses).toEqual(RESPONSES);
        expect(new Date(saved!.createdAt).toString()).not.toBe("Invalid Date");
    });

    it("get returns undefined for an unknown run", async () => {
        expect(await store.get("missing")).toBeUndefined();
    });

    it("links a run to an existing session and rejects an unknown one", async () => {
        const sessionId = await new SessionManager(getDb()).create("s");
        await store.save(run("r1", { sessionId }));
        expect((await store.get("r1"))?.sessionId).toBe(sessionId);
        await expect(store.save(run("r2", { sessionId: "no-such-session" }))).rejects.toThrow();
    });

    it("updateQualityScore stores fractional scores", async () => {
        await store.save(run("r1"));
        await store.updateQualityScore("r1", 8.5);
        expect((await store.get("r1"))?.qualityScore).toBe(8.5);
    });

    it("list returns summaries newest-first, without response bodies, honouring the limit", async () => {
        const { consensusRuns } = tablesFor(getDb());
        for (const [id, createdAt] of [["old", "2026-01-01T00:00:00.000Z"], ["new", "2026-03-01T00:00:00.000Z"], ["mid", "2026-02-01T00:00:00.000Z"]] as const) {
            await store.save(run(id));
            await getDb().update(consensusRuns).set({ createdAt }).where(eq(consensusRuns.id, id));
        }

        const all = await store.list();
        expect(all.map((r) => r.id)).toEqual(["new", "mid", "old"]);
        expect(all[0]).not.toHaveProperty("modelResponses");
        expect(all[0]).not.toHaveProperty("synthesizedContent");
        expect((await store.list(2)).map((r) => r.id)).toEqual(["new", "mid"]);
    });

    it("get survives a corrupt model_responses blob", async () => {
        const { consensusRuns } = tablesFor(getDb());
        await store.save(run("r1"));
        await getDb().update(consensusRuns).set({ modelResponses: "not json" }).where(eq(consensusRuns.id, "r1"));
        expect((await store.get("r1"))?.modelResponses).toEqual([]);
    });

    it("runs are removed when their session is deleted", async () => {
        const sessions = new SessionManager(getDb());
        const sessionId = await sessions.create("s");
        await store.save(run("r1", { sessionId }));
        await sessions.delete(sessionId);
        expect(await store.get("r1")).toBeUndefined();
    });
});
