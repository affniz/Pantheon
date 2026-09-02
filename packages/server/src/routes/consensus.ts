import { Hono } from "hono";
import { getDb, schema } from "@pantheon/core";

export const consensusRouter = new Hono();

/**
 * GET /api/consensus -- list recent consensus runs (summary), newest first
 */
consensusRouter.get("/", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? "20"), 100);
    const db = getDb();
    const runs = db
        .select({
            id: schema.consensusRuns.id,
            sessionId: schema.consensusRuns.sessionId,
            promptHash: schema.consensusRuns.promptHash,
            synthesisLatencyMs: schema.consensusRuns.synthesisLatencyMs,
            createdAt: schema.consensusRuns.createdAt,
        })
        .from(schema.consensusRuns)
        .all()
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
        .slice(0, limit);

    return c.json({ runs });
});

/**
 * GET /api/consensus/:id -- full detail of one run including per-model responses
 */
consensusRouter.get("/:id", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const run = db
        .select()
        .from(schema.consensusRuns)
        .all()
        .find((r) => r.id === id);

    if (!run) {
        return c.json({ error: "Consensus run not found" }, 404);
    }

    let modelResponses: unknown[] = [];
    try {
        modelResponses = JSON.parse(run.modelResponses) as unknown[];
    } catch {
        // ignore parse error
    }

    return c.json({
        run: {
            ...run,
            modelResponses,
        },
    });
});
