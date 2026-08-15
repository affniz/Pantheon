import { rateLimiter } from "hono-rate-limiter";

/** 100 req/IP/minute — applied globally to all endpoints */
export const globalRateLimiter = rateLimiter({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: "draft-6",
    keyGenerator: (c) =>
        c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "127.0.0.1",
    handler: (c) =>
        c.json({ error: "Too many requests. Please try again later." }, 429),
});

/** 15 req/IP/minute for external IPs; 60 req/minute for localhost — applied to LLM-backed /api/chat endpoint */
export const llmRateLimiter = rateLimiter({
    windowMs: 60 * 1000,
    limit: (c) => {
        const ip =
            c.req.header("x-forwarded-for") ??
            c.req.header("x-real-ip") ??
            "127.0.0.1";
        // CLI always connects from localhost — give it a generous limit
        return ip === "127.0.0.1" || ip === "::1" ? 60 : 15;
    },
    standardHeaders: "draft-6",
    keyGenerator: (c) =>
        c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "127.0.0.1",
    handler: (c) =>
        c.json({ error: "LLM rate limit exceeded. Please wait before sending another message." }, 429),
});
