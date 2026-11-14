import { Hono } from "hono";
import { ABStore, loadConfig } from "@pantheon/core";
import { intParam } from "./params.js";

export const abRouter = new Hono();

const store = new ABStore();

/**
 * GET /api/ab/experiments — list configured experiments
 */
abRouter.get("/experiments", async (c) => {
    const config = loadConfig();
    const experiments = config.ab?.experiments ?? [];
    return c.json({ experiments });
});

/**
 * GET /api/ab/experiments/:id/comparison — comparison analytics
 */
abRouter.get("/experiments/:id/comparison", async (c) => {
    const experimentId = c.req.param("id");
    try {
        const comparison = await store.getComparison(experimentId);
        return c.json({ comparison });
    } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
});

/**
 * GET /api/ab/experiments/:id/runs — all runs for an experiment
 */
abRouter.get("/experiments/:id/runs", async (c) => {
    const experimentId = c.req.param("id");
    const runs = await store.getRuns(experimentId, intParam(c.req.query("limit"), 50, 1, 200));
    return c.json({ runs });
});
