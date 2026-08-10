import { createMiddleware } from "hono/factory";

/** Simple request logger — logs method, path, status, and duration. */
export const requestLogger = createMiddleware(async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    const status = c.res.status;
    // Only log errors and slow requests in production; log everything in dev
    if (process.env.NODE_ENV !== "production" || status >= 400 || ms > 1000) {
        process.stdout.write(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} ${status} ${ms}ms\n`);
    }
});
