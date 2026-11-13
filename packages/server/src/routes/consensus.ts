import { Hono } from "hono";
import { getDb, schema, desc, eq } from "@pantheon/core";

export const consensusRouter = new Hono();

/**
 * GET /api/consensus -- list recent consensus runs (summary), newest first
 */
consensusRouter.get("/", (c) => {
    const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? "20") || 20), 100);
    const db = getDb();
    const runs = db
        .select({
            id: schema.consensusRuns.id,
            sessionId: schema.consensusRuns.sessionId,
            promptHash: schema.consensusRuns.promptHash,
            synthesisLatencyMs: schema.consensusRuns.synthesisLatencyMs,
            qualityScore: schema.consensusRuns.qualityScore,
            createdAt: schema.consensusRuns.createdAt,
        })
        .from(schema.consensusRuns)
        .orderBy(desc(schema.consensusRuns.createdAt))
        .limit(limit)
        .all();

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
        .where(eq(schema.consensusRuns.id, id))
        .get();

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
