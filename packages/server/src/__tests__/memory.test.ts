import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "@pantheon/shared";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-mem-"));
const ENV = ["HOME", "PANTHEON_DB_PATH", "DATABASE_URL", "NODE_ENV", "PANTHEON_AUTH", "PANTHEON_EMBEDDING_MODEL"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
process.env["HOME"] = tmpHome;
process.env["PANTHEON_DB_PATH"] = path.join(tmpHome, "mem-test.db");
process.env["NODE_ENV"] = "production";
// Each request below names its own client address (x-forwarded-for) to stay clear of the rate limiter
process.env["PANTHEON_TRUST_PROXY"] = "1";

/** Messages the fake gateway was asked to answer, per call. */
const streamed: ChatMessage[][] = [];
const embedState = { fail: false };

/** Bag-of-words vector — texts sharing words are similar. */
function embedText(text: string): number[] {
    const v = new Array<number>(256).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
        v[(h >>> 0) % 256]! += 1;
    }
    return v;
}

vi.mock("@pantheon/core", async (importOriginal) => {
    const original = await importOriginal<typeof import("@pantheon/core")>();
    class FakeGateway {
        async stream(messages: ChatMessage[], model?: string) {
            streamed.push(messages);
            return {
                decision: { tier: "general", selectedModelId: model ?? "llama-smart", reason: "test" },
                generator: (async function* () {
                    yield "Rotate the signing keys with the rotate-keys script every ninety days.";
                })(),
            };
        }
        embedder(modelId: string) {
            return {
                modelId,
                embed: async (texts: string[]) => {
                    if (embedState.fail) throw new Error("embedding provider unavailable");
                    return texts.map(embedText);
                },
            };
        }
    }
    return { ...original, Gateway: FakeGateway };
});

const core = await import("@pantheon/core");
const { app } = await import("../app.js");

let n = 0;
async function api(method: string, url: string, body?: unknown) {
    return app.request(url, {
        method,
        headers: { "x-forwarded-for": `10.5.0.${n++ % 250}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

async function chat(prompt: string, sessionId?: string): Promise<string> {
    const text = await (await api("POST", "/api/chat", { prompt, noTools: true, ...(sessionId ? { sessionId } : {}) })).text();
    // Indexing runs after the response; give it a moment
    await new Promise((r) => setTimeout(r, 40));
    return /"sessionId":"([^"]+)"/.exec(text)?.[1] ?? "";
}

beforeAll(async () => {
    await core.initDb();
});
beforeEach(async () => {
    const db = core.getDb();
    const t = core.tablesFor(db);
    for (const table of [t.memoryChunks, t.usageRecords, t.messages, t.sessions]) await db.delete(table);
    streamed.length = 0;
    embedState.fail = false;
    process.env["PANTHEON_EMBEDDING_MODEL"] = "pantheon-embed";
});
afterAll(async () => {
    await core.TraceCollector.flush();
    await core.closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe("semantic memory — disabled (default)", () => {
    beforeEach(() => {
        delete process.env["PANTHEON_EMBEDDING_MODEL"];
    });

    it("reports disabled, refuses search/reindex, and chat neither retrieves nor indexes", async () => {
        expect(await json(await api("GET", "/api/memory/status"))).toMatchObject({ enabled: false, chunks: 0, search: "in-process" });
        expect((await api("GET", "/api/memory/search?q=anything")).status).toBe(409);
        expect((await api("POST", "/api/memory/reindex")).status).toBe(409);

        await chat("How do we rotate the signing keys in production?");
        expect((await json(await api("GET", "/api/memory/status"))).chunks).toBe(0);
        expect(streamed[0]!.some((m) => m.role === "system")).toBe(false);
    });
});

describe("semantic memory — enabled", () => {
    it("indexes each turn and recalls it in a later, different session", async () => {
        const first = await chat("How do we rotate the signing keys in production?");
        const status = await json(await api("GET", "/api/memory/status"));
        expect(status).toMatchObject({ enabled: true, chunks: 2, sessions: 1 });
        expect(status.models).toEqual([{ embeddingModel: "pantheon-embed", dimensions: 256, chunks: 2 }]);

        const second = await chat("remind me about rotating the signing keys");
        expect(second).not.toBe(first);

        const system = streamed[1]!.find((m) => m.role === "system");
        expect(system?.content).toContain("## Relevant memory");
        expect(system?.content).toContain("rotate-keys script every ninety days");
        // The first turn had nothing to recall
        expect(streamed[0]!.some((m) => m.role === "system" && m.content.includes("Relevant memory"))).toBe(false);
    });

    it("does not feed a session its own earlier messages as 'memory'", async () => {
        const sessionId = await chat("How do we rotate the signing keys in production?");
        await chat("and how often should the signing keys be rotated?", sessionId);
        const system = streamed[1]!.find((m) => m.role === "system");
        expect(system?.content ?? "").not.toContain("Relevant memory");
    });

    it("does not inject unrelated memories", async () => {
        await chat("How do we rotate the signing keys in production?");
        await chat("suggest a vegetarian lasagne recipe");
        expect(streamed[1]!.some((m) => m.role === "system" && m.content.includes("Relevant memory"))).toBe(false);
    });

    it("a failing embedding provider never breaks the chat", async () => {
        embedState.fail = true;
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const res = await api("POST", "/api/chat", { prompt: "still works?", noTools: true });
            const text = await res.text();
            expect(text).toContain("event: done");
            expect(text).not.toContain("event: error");
            await new Promise((r) => setTimeout(r, 40));
            expect(stderr.mock.calls.some((c) => String(c[0]).includes("[memory] retrieval failed"))).toBe(true);
            expect(stderr.mock.calls.some((c) => String(c[0]).includes("[memory] indexing failed"))).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });

    it("GET /api/memory/search returns scored passages and validates input", async () => {
        const sessionId = await chat("How do we rotate the signing keys in production?");

        const { results } = await json(await api("GET", "/api/memory/search?q=rotate%20signing%20keys&limit=1"));
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ sessionId, sessionTitle: "How do we rotate the signing keys in production?" });
        expect(results[0].score).toBeGreaterThan(0.5);

        expect((await json(await api("GET", "/api/memory/search?q=zebra%20xylophone"))).results).toEqual([]);
        expect((await api("GET", "/api/memory/search")).status).toBe(400);
        expect((await api("GET", "/api/memory/search?q=%20")).status).toBe(400);

        embedState.fail = true;
        const failed = await api("GET", "/api/memory/search?q=rotate");
        expect(failed.status).toBe(502);
        expect((await json(failed)).error).toContain("embedding provider unavailable");
    });

    it("reindex picks up conversations from before memory was enabled; clear drops the index only", async () => {
        delete process.env["PANTHEON_EMBEDDING_MODEL"];
        const sessionId = await chat("An older conversation about database connection pooling");
        process.env["PANTHEON_EMBEDDING_MODEL"] = "pantheon-embed";
        expect((await json(await api("GET", "/api/memory/status"))).chunks).toBe(0);

        expect(await json(await api("POST", "/api/memory/reindex"))).toEqual({ sessions: 1, chunks: 2 });
        expect(await json(await api("POST", "/api/memory/reindex"))).toEqual({ sessions: 1, chunks: 0 });

        expect(await json(await api("DELETE", "/api/memory"))).toEqual({ ok: true, removed: 2 });
        expect((await json(await api("GET", "/api/memory/status"))).chunks).toBe(0);
        expect(await new core.SessionManager().getMessages(sessionId)).toHaveLength(2);
    });
});
