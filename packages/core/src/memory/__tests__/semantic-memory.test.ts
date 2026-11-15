import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BACKENDS, useBackend, type Backend } from "../../db/__tests__/backends.js";
import { createTestPgDb, dialectOf, rawExecutor, type PantheonDatabase } from "../../db/client.js";
import { SessionManager } from "../../session/session-manager.js";
import { AuthStore } from "../../auth/auth-store.js";
import { chunkText, cosineSimilarity } from "../embedder.js";
import { MemoryStore } from "../memory-store.js";
import { SemanticMemory } from "../semantic-memory.js";
import { FakeEmbedder } from "./fake-embedder.js";

/**
 * Backends × search path. PostgreSQL is exercised twice: with pgvector (search
 * inside the database) and with it disabled (same in-process path as SQLite).
 */
const VARIANTS: Array<{ name: string; backend: Backend; pgvector: boolean }> = [
    ...BACKENDS.map((backend) => ({ name: `${backend.name}, in-process search`, backend, pgvector: false })),
    {
        name: "postgres, pgvector search",
        backend: { name: "postgres-pgvector", dialect: "postgres", open: () => createTestPgDb() },
        pgvector: true,
    },
];

describe.each(VARIANTS)("semantic memory [$name]", ({ backend, pgvector }) => {
    const savedFlag = process.env["PANTHEON_DISABLE_PGVECTOR"];
    // Set before the database is opened: the capability is detected once per handle
    if (pgvector) delete process.env["PANTHEON_DISABLE_PGVECTOR"];
    else process.env["PANTHEON_DISABLE_PGVECTOR"] = "1";

    const getDb = useBackend(backend);
    let sessions: SessionManager;
    let embedder: FakeEmbedder;
    let memory: SemanticMemory;

    beforeEach(() => {
        if (pgvector) delete process.env["PANTHEON_DISABLE_PGVECTOR"];
        else process.env["PANTHEON_DISABLE_PGVECTOR"] = "1";
        sessions = new SessionManager(getDb());
        embedder = new FakeEmbedder();
        memory = new SemanticMemory(embedder, { minScore: 0.2 }, getDb());
    });
    afterEach(() => {
        if (savedFlag === undefined) delete process.env["PANTHEON_DISABLE_PGVECTOR"];
        else process.env["PANTHEON_DISABLE_PGVECTOR"] = savedFlag;
    });

    async function session(title: string, turns: Array<[role: "user" | "assistant" | "tool", content: string]>, userId?: string) {
        const id = await sessions.create(title, userId);
        for (const [role, content] of turns) await sessions.addMessage(id, { role, content });
        return id;
    }

    it("reports which search path is active", async () => {
        const status = await memory.status();
        expect(status.search).toBe(pgvector ? "pgvector" : "in-process");
        expect(status).toMatchObject({ chunks: 0, sessions: 0, models: [] });
    });

    it("indexes user and assistant messages, skipping tool output and trivia", async () => {
        const id = await session("Postgres tuning", [
            ["user", "How should I configure connection pooling for PostgreSQL?"],
            ["assistant", "Use pgbouncer in transaction mode and size the pool to the core count."],
            ["tool", "tool output that should never be embedded, however long it is"],
            ["user", "ok"],
        ]);
        expect(await memory.indexSession(id)).toBe(2);

        const status = await memory.status();
        expect(status).toMatchObject({ chunks: 2, sessions: 1 });
        expect(status.models).toEqual([{ embeddingModel: "fake-embed", dimensions: 512, chunks: 2 }]);
        expect(embedder.calls.flat().join(" ")).not.toContain("tool output");
    });

    it("is incremental and idempotent — only new messages are embedded", async () => {
        const id = await session("s", [["user", "first message about database indexes"]]);
        expect(await memory.indexSession(id)).toBe(1);
        expect(await memory.indexSession(id)).toBe(0);
        expect(embedder.calls).toHaveLength(1);

        await sessions.addMessage(id, { role: "assistant", content: "second message about query planning" });
        expect(await memory.indexSession(id)).toBe(1);
        expect(embedder.calls.at(-1)).toEqual(["second message about query planning"]);
        expect((await memory.status()).chunks).toBe(2);
    });

    it("splits long messages into several chunks and batches embedding calls", async () => {
        const paragraph = (n: number) => `Paragraph ${n} ` + "lorem ipsum dolor sit amet ".repeat(30);
        const long = Array.from({ length: 6 }, (_, i) => paragraph(i)).join("\n\n");
        const id = await session("long", [["user", long]]);
        for (let i = 0; i < 40; i++) await sessions.addMessage(id, { role: "user", content: `short distinct message number ${i}` });

        const added = await memory.indexSession(id);
        expect(added).toBeGreaterThan(41);
        expect(embedder.calls.every((batch) => batch.length <= 32)).toBe(true);
        expect(embedder.calls.length).toBeGreaterThan(1);
        expect(embedder.calls.flat().every((text) => text.length <= 1200)).toBe(true);
    });

    it("retrieves the most similar passages first, with the session title and a score", async () => {
        const pg = await session("Postgres tuning", [
            ["user", "How should I configure connection pooling for PostgreSQL databases?"],
            ["assistant", "Use pgbouncer for PostgreSQL connection pooling in transaction mode."],
        ]);
        const cooking = await session("Dinner", [["user", "What is a good recipe for mushroom risotto with parmesan?"]]);
        await memory.indexSession(pg);
        await memory.indexSession(cooking);

        const hits = await memory.search("postgresql connection pooling");
        expect(hits.length).toBeGreaterThanOrEqual(2);
        expect(hits[0]).toMatchObject({ sessionId: pg, sessionTitle: "Postgres tuning" });
        expect(hits.every((h) => h.sessionId === pg)).toBe(true); // risotto is below the threshold
        expect(hits[0]!.score).toBeGreaterThan(0.5);
        expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
        expect(typeof hits[0]!.createdAt).toBe("number");

        expect((await memory.search("mushroom risotto recipe"))[0]?.sessionId).toBe(cooking);
    });

    it("honours topK and minScore", async () => {
        const id = await session("many", Array.from({ length: 8 }, (_, i) => ["user", `kubernetes deployment rollout strategy note ${i}`] as ["user", string]));
        await memory.indexSession(id);

        expect(await memory.search("kubernetes deployment rollout", { topK: 3 })).toHaveLength(3);
        expect(await memory.search("kubernetes deployment rollout", { minScore: 0.999 })).toEqual([]);
        expect(await memory.search("completely unrelated zebra xylophone")).toEqual([]);
        expect(await memory.search("   ")).toEqual([]);
    });

    it("never returns passages from the excluded (current) session", async () => {
        const current = await session("current", [["user", "terraform state locking with dynamodb backend"]]);
        const past = await session("past", [["user", "terraform state locking explained in detail"]]);
        await memory.indexSession(current);
        await memory.indexSession(past);

        const hits = await memory.search("terraform state locking", { excludeSessionId: current });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.sessionId === past)).toBe(true);
    });

    it("scopes results to the user's own sessions (plus ownerless ones)", async () => {
        const auth = new AuthStore(getDb());
        const alice = await auth.upsertUser({ email: "alice@example.com", provider: "github", providerUserId: "a" });
        const bob = await auth.upsertUser({ email: "bob@example.com", provider: "github", providerUserId: "b" });
        const alices = await session("alice", [["user", "confidential merger negotiation timeline details"]], alice.id);
        const bobs = await session("bob", [["user", "confidential merger negotiation budget details"]], bob.id);
        const shared = await session("legacy", [["user", "confidential merger negotiation background notes"]]);
        for (const id of [alices, bobs, shared]) await memory.indexSession(id);

        const forBob = await memory.search("confidential merger negotiation", { userId: bob.id, topK: 10 });
        expect(forBob.map((h) => h.sessionId).sort()).toEqual([bobs, shared].sort());

        const unscoped = await memory.search("confidential merger negotiation", { topK: 10 });
        expect(unscoped).toHaveLength(3);
    });

    it("keeps vector spaces of different embedding models apart", async () => {
        const id = await session("s", [["user", "graphql schema stitching federation gateway"]]);
        await memory.indexSession(id);

        const other = new SemanticMemory(new FakeEmbedder("other-model", 32), { minScore: 0 }, getDb());
        expect(await other.search("graphql schema stitching")).toEqual([]);
        // …and it indexes the same session independently, without clashing
        await sessions.addMessage(id, { role: "user", content: "graphql subscriptions over websockets" });
        expect(await other.indexSession(id)).toBe(1);
    });

    it("buildContext produces a prompt block, or nothing when no memory is relevant", async () => {
        const id = await session("Release process", [
            ["user", "Our release process: tag the commit, run the changelog script, then publish to npm."],
        ]);
        await memory.indexSession(id);

        const block = await memory.buildContext("how does our release process publish to npm");
        expect(block).toMatch(/^## Relevant memory/);
        expect(block).toContain('"Release process" — user: Our release process: tag the commit');
        expect(block).toMatch(/- \[\d{4}-\d{2}-\d{2}\]/);

        expect(await memory.buildContext("zebra xylophone quantum")).toBe("");
    });

    it("truncates long memories in the prompt block", async () => {
        const id = await session("long", [["user", "elasticsearch " + "shard allocation awareness ".repeat(40)]]);
        const short = new SemanticMemory(embedder, { minScore: 0.2, snippetChars: 80 }, getDb());
        await short.indexSession(id);
        const line = (await short.buildContext("elasticsearch shard allocation")).split("\n").at(-1)!;
        expect(line.endsWith("…")).toBe(true);
        expect(line.length).toBeLessThan(160);
    });

    it("forgets a session's memories when the session is deleted", async () => {
        const id = await session("temp", [["user", "ephemeral note about redis cluster failover"]]);
        await memory.indexSession(id);
        await sessions.delete(id);
        expect((await memory.status()).chunks).toBe(0);
        expect(await memory.search("redis cluster failover")).toEqual([]);
    });

    it("indexAll covers every session and reports progress; clear removes the index", async () => {
        await session("a", [["user", "alpha topic about message queues"]]);
        await session("b", [["user", "beta topic about object storage"]]);
        await session("empty", []);
        const progress: Array<[number, number]> = [];

        expect(await memory.indexAll((done, total) => progress.push([done, total]))).toEqual({ sessions: 3, chunks: 2 });
        expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
        expect(await memory.indexAll()).toEqual({ sessions: 3, chunks: 0 });

        expect(await memory.clear()).toBe(2);
        expect((await memory.status()).chunks).toBe(0);
    });

    it("rejects an embedding model that returns the wrong number of vectors", async () => {
        const id = await session("s", [["user", "a perfectly ordinary message to embed"]]);
        const broken = new SemanticMemory({ modelId: "broken", embed: async () => [] }, {}, getDb());
        await expect(broken.indexSession(id)).rejects.toThrow(/returned 0 vectors for 1 texts/);
    });
});

describe("MemoryStore — in-process search details", () => {
    const saved = process.env["PANTHEON_DISABLE_PGVECTOR"];
    let db: PantheonDatabase;
    let store: MemoryStore;
    let sessionId: string;

    beforeEach(async () => {
        process.env["PANTHEON_DISABLE_PGVECTOR"] = "1";
        const { createTestDb } = await import("../../db/client.js");
        db = createTestDb();
        store = new MemoryStore(db);
        sessionId = await new SessionManager(db).create("s");
    });
    afterEach(() => {
        if (saved === undefined) delete process.env["PANTHEON_DISABLE_PGVECTOR"];
        else process.env["PANTHEON_DISABLE_PGVECTOR"] = saved;
    });

    const chunk = (messageId: number, embedding: number[], content = `m${messageId}`) =>
        ({ sessionId, messageId, chunkIndex: 0, role: "user", content, embedding, embeddingModel: "m" });

    it("finds the exact nearest neighbours across more rows than one page", async () => {
        // 1,300 chunks pointing in slightly different directions; #777 is exactly the query
        const rows = Array.from({ length: 1300 }, (_, i) => chunk(i + 1, [Math.cos(i / 1300), Math.sin(i / 1300), 0.001 * (i % 7)]));
        rows[776] = chunk(777, [0.3, 0.4, 0.5], "the needle");
        expect(await store.insert(rows)).toBe(1300);

        const hits = await store.search([0.3, 0.4, 0.5], { embeddingModel: "m", topK: 3 });
        expect(hits[0]).toMatchObject({ content: "the needle", messageId: 777 });
        expect(hits[0]!.score).toBeCloseTo(1, 6);
        expect(hits).toHaveLength(3);
        expect(hits[1]!.score).toBeLessThan(1);
    });

    it("maxCandidates bounds how far back the scan goes", async () => {
        await store.insert([chunk(1, [1, 0], "oldest, perfect match")]);
        await new Promise((r) => setTimeout(r, 5));
        await store.insert([chunk(2, [0, 1], "newer"), chunk(3, [0.1, 1], "newest")]);

        const all = await store.search([1, 0], { embeddingModel: "m", topK: 1 });
        expect(all[0]!.content).toBe("oldest, perfect match");
        const recentOnly = await store.search([1, 0], { embeddingModel: "m", topK: 1, maxCandidates: 2 });
        expect(recentOnly[0]!.content).not.toBe("oldest, perfect match");
    });

    it("ignores chunks whose dimensions differ from the query and skips corrupt embeddings", async () => {
        await store.insert([chunk(1, [1, 0, 0]), chunk(2, [1, 0])]);
        await rawExecutor(db).exec("UPDATE memory_chunks SET embedding = 'not json' WHERE message_id = 2");
        await store.insert([chunk(3, [0.9, 0.1])]);

        expect((await store.search([1, 0], { embeddingModel: "m" })).map((h) => h.messageId)).toEqual([3]);
        expect((await store.search([1, 0, 0], { embeddingModel: "m" })).map((h) => h.messageId)).toEqual([1]);
        expect(await store.search([], { embeddingModel: "m" })).toEqual([]);
    });

    it("inserting the same chunk twice keeps the first", async () => {
        expect(await store.insert([chunk(1, [1, 0], "original")])).toBe(1);
        expect(await store.insert([chunk(1, [0, 1], "replacement")])).toBe(0);
        expect((await store.search([1, 0], { embeddingModel: "m" }))[0]!.content).toBe("original");
    });
});

describe("pgvector lifecycle", () => {
    it("backfills the native column for rows that arrived without it (e.g. via db migrate)", async () => {
        const saved = process.env["PANTHEON_DISABLE_PGVECTOR"];
        delete process.env["PANTHEON_DISABLE_PGVECTOR"];
        try {
            const db = await createTestPgDb();
            expect(dialectOf(db)).toBe("postgres");
            const sessionId = await new SessionManager(db).create("s");
            // Written straight into the portable JSON column, as copyDatabase does
            await rawExecutor(db).exec(
                `INSERT INTO memory_chunks (id, session_id, message_id, chunk_index, role, content, embedding, embedding_model, dimensions, created_at)
                 VALUES ('1:0', '${sessionId}', 1, 0, 'user', 'copied row', '[1,0,0]', 'm', 3, 1)`,
            );

            const store = new MemoryStore(db);
            expect((await store.status()).search).toBe("pgvector");
            const hits = await store.search([1, 0, 0], { embeddingModel: "m" });
            expect(hits).toHaveLength(1);
            expect(hits[0]).toMatchObject({ content: "copied row" });
            expect(hits[0]!.score).toBeCloseTo(1, 6);
        } finally {
            if (saved === undefined) delete process.env["PANTHEON_DISABLE_PGVECTOR"];
            else process.env["PANTHEON_DISABLE_PGVECTOR"] = saved;
        }
    });
});

describe("embedding helpers", () => {
    it("cosineSimilarity", () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
        expect(cosineSimilarity([2, 2], [5, 5])).toBeCloseTo(1); // magnitude-independent
        expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
        expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
        expect(cosineSimilarity([], [])).toBe(0);
    });

    it("chunkText keeps short text whole and splits long text on natural boundaries", () => {
        expect(chunkText("  hello  ")).toEqual(["hello"]);
        expect(chunkText("   ")).toEqual([]);

        const text = ["First paragraph. ".repeat(40), "Second paragraph. ".repeat(40), "Third paragraph. ".repeat(40)].join("\n\n");
        const chunks = chunkText(text, 800);
        expect(chunks.length).toBeGreaterThan(2);
        expect(chunks.every((c) => c.length <= 800)).toBe(true);
        // Nothing is lost or reordered
        expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
        // Cuts land on sentence/paragraph ends, not mid-word
        expect(chunks.slice(0, -1).every((c) => c.endsWith("."))).toBe(true);
    });

    it("chunkText hard-cuts text with no boundaries and caps the number of chunks", () => {
        expect(chunkText("x".repeat(2500), 1000)).toEqual(["x".repeat(1000), "x".repeat(1000), "x".repeat(500)]);
        expect(chunkText("word ".repeat(5000), 100, 4)).toHaveLength(4);
    });
});
