import { rateLimiter } from "hono-rate-limiter";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function trustProxy(): boolean {
    const value = process.env["PANTHEON_TRUST_PROXY"]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
}

/**
 * The address a request really came from.
 *
 * `X-Forwarded-For` / `X-Real-IP` are set by whoever sends the request, so by
 * default they are ignored and the TCP peer address is used: otherwise a client
 * could dodge the limit by sending a new value with every request, or claim to be
 * 127.0.0.1 to get the local quota. Behind a reverse proxy the peer is the proxy
 * itself; set `PANTHEON_TRUST_PROXY=1` there, and the proxy-supplied address is
 * used instead (the left-most entry, i.e. the original client).
 */
export function clientAddress(c: Context): string {
    if (trustProxy()) {
        const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")?.trim();
        if (forwarded) return forwarded;
    }
    try {
        const address = getConnInfo(c).remote.address;
        if (address) return address;
    } catch {
        // No socket (in-process requests made by tests)
    }
    return "local";
}

export function isLoopback(address: string): boolean {
    return LOOPBACK.has(address) || address === "local";
}

/** 100 requests per client per minute — applied to every endpoint. */
export const globalRateLimiter = rateLimiter({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: "draft-6",
    keyGenerator: clientAddress,
    handler: (c) =>
        c.json({ error: "Too many requests. Please try again later." }, 429),
});

/**
 * LLM-backed `/api/chat`: 15 requests per minute for remote clients, 60 for a
 * client on this machine (the CLI).
 */
export const llmRateLimiter = rateLimiter({
    windowMs: 60 * 1000,
    limit: (c) => (isLoopback(clientAddress(c)) ? 60 : 15),
    standardHeaders: "draft-6",
    keyGenerator: clientAddress,
    handler: (c) =>
        c.json({ error: "LLM rate limit exceeded. Please wait before sending another message." }, 429),
});
