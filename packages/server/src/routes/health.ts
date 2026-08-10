import { Hono } from "hono";

export const healthRouter = new Hono();

healthRouter.get("/", (c) => {
    return c.json({
        status: "ok",
        version: "0.5.0",
        timestamp: new Date().toISOString(),
    });
});
