import { Hono } from "hono";
import { MemoryStore } from "@pantheon/core";
import { scopeUserId } from "../middleware/auth.js";
import { semanticMemory } from "../semantic.js";
import { intParam } from "./params.js";

export const memoryRouter = new Hono();

const NOT_ENABLED =
    "Semantic memory is not enabled. Set memory.semantic in config.yml (or PANTHEON_EMBEDDING_MODEL) — see README → Semantic Memory.";

/** GET /api/memory/status — is semantic memory on, how it searches, and what is indexed. */
memoryRouter.get("/status", async (c) => {
    const status = await new MemoryStore().status();
    return c.json({ enabled: semanticMemory() !== undefined, ...status });
});

/** GET /api/memory/search?q=…&limit=5&minScore=0.3 — passages from past conversations similar to `q`. */
memoryRouter.get("/search", async (c) => {
    const memory = semanticMemory();
    if (!memory) return c.json({ error: NOT_ENABLED }, 409);

    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ error: "q is required" }, 400);

    const minScore = Number(c.req.query("minScore"));
    try {
        const results = await memory.search(q, {
            userId: scopeUserId(c),
            topK: intParam(c.req.query("limit"), 5, 1, 50),
            ...(c.req.query("minScore") !== undefined && Number.isFinite(minScore) ? { minScore } : {}),
        });
        return c.json({ results });
    } catch (err) {
        return c.json({ error: `Embedding request failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
});

/** POST /api/memory/reindex — embed every message that is not indexed yet. */
memoryRouter.post("/reindex", async (c) => {
    const memory = semanticMemory();
    if (!memory) return c.json({ error: NOT_ENABLED }, 409);
    try {
        return c.json(await memory.indexAll());
    } catch (err) {
        return c.json({ error: `Embedding request failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
});

/** DELETE /api/memory — drop the whole index (conversations themselves are untouched). */
memoryRouter.delete("/", async (c) => {
    return c.json({ ok: true, removed: await new MemoryStore().clear() });
});
