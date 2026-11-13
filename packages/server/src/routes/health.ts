import { Hono } from "hono";
import { PANTHEON_VERSION } from "@pantheon/shared";

export const healthRouter = new Hono();

healthRouter.get("/", (c) => {
    return c.json({
        status: "ok",
        version: PANTHEON_VERSION,
        timestamp: new Date().toISOString(),
    });
});
