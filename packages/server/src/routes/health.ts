import { Hono } from "hono";
import { PANTHEON_VERSION } from "@pantheon/shared";
import { getDb, getDatabaseStatus } from "@pantheon/core";

export const healthRouter = new Hono();

healthRouter.get("/", (c) => {
    return c.json({
        status: "ok",
        version: PANTHEON_VERSION,
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /api/health/db — storage backend, schema version and row counts.
 * Never includes credentials (connection URLs are redacted).
 */
healthRouter.get("/db", async (c) => {
    try {
        const status = await getDatabaseStatus(getDb());
        return c.json({ status: "ok", database: status });
    } catch (err) {
        return c.json({ status: "error", error: err instanceof Error ? err.message : String(err) }, 503);
    }
});
