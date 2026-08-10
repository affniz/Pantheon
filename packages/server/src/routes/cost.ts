import { Hono } from "hono";
import { CostTracker } from "@pantheon/core";

export const costRouter = new Hono();

const tracker = new CostTracker();

/** GET /api/cost — total usage summary */
costRouter.get("/", (c) => {
    const summary = tracker.getSummary();
    const byModel = tracker.getByModel();
    return c.json({ summary, byModel });
});

/** GET /api/cost/recent — last N records */
costRouter.get("/recent", (c) => {
    const n = Number(c.req.query("n") ?? "10");
    const records = tracker.getRecent(n);
    return c.json({ records });
});

/** DELETE /api/cost — reset all usage data */
costRouter.delete("/", (c) => {
    tracker.reset();
    return c.json({ ok: true });
});
