import { Hono } from "hono";
import { ConsensusStore } from "@pantheon/core";

export const consensusRouter = new Hono();

const store = new ConsensusStore();

/**
 * GET /api/consensus -- list recent consensus runs (summary), newest first
 */
consensusRouter.get("/", async (c) => {
    const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? "20") || 20), 100);
    const runs = await store.list(limit);
    return c.json({ runs });
});

/**
 * GET /api/consensus/:id -- full detail of one run including per-model responses
 */
consensusRouter.get("/:id", async (c) => {
    const run = await store.get(c.req.param("id"));
    if (!run) {
        return c.json({ error: "Consensus run not found" }, 404);
    }
    return c.json({ run });
});
