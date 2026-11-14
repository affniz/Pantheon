import { Hono } from "hono";
import { CostTracker } from "@pantheon/core";
import { intParam } from "./params.js";

export const costRouter = new Hono();

const tracker = new CostTracker();

/** GET /api/cost — total usage summary */
costRouter.get("/", async (c) => {
    const [summary, byModel] = await Promise.all([tracker.getSummary(), tracker.getByModel()]);
    return c.json({ summary, byModel });
});

/** GET /api/cost/recent — last N records */
costRouter.get("/recent", async (c) => {
    const records = await tracker.getRecent(intParam(c.req.query("n"), 10, 1, 1000));
    return c.json({ records });
});

/** DELETE /api/cost — reset all usage data */
costRouter.delete("/", async (c) => {
    await tracker.reset();
    return c.json({ ok: true });
});
