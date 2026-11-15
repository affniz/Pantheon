import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { AuthStore, TOKEN_PREFIX, type User } from "@pantheon/core";
import { getAuthConfig } from "../auth/config.js";
import { verifySession } from "../auth/jwt.js";

export const SESSION_COOKIE = "pantheon_session";

export type AuthMethod = "token" | "session";

declare module "hono" {
    interface ContextVariableMap {
        /** The authenticated user. Undefined when auth is off or the route is public. */
        user: User | undefined;
        authMethod: AuthMethod | undefined;
    }
}

const store = new AuthStore();

/** Routes reachable without credentials even when auth is required. */
const PUBLIC_ROUTES: Array<{ method?: string; test: (path: string) => boolean }> = [
    { method: "GET", test: (p) => p === "/api/health" || p === "/api/health/" },
    { method: "GET", test: (p) => p === "/api/auth/providers" },
    { method: "GET", test: (p) => p.startsWith("/api/auth/login/") },
    { method: "GET", test: (p) => p.startsWith("/api/auth/callback/") },
    { method: "POST", test: (p) => p === "/api/auth/cli/exchange" },
];

function isPublic(method: string, path: string): boolean {
    return PUBLIC_ROUTES.some((r) => (!r.method || r.method === method) && r.test(path));
}

/**
 * Identify the caller from, in order: an `Authorization: Bearer` API token, a
 * bearer session JWT, the session cookie, or (WebSocket upgrades only, where
 * browsers cannot set headers) an `access_token` query parameter.
 */
export async function authenticate(c: Context): Promise<{ user: User; method: AuthMethod } | undefined> {
    const header = c.req.header("authorization");
    const bearer = header && /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : undefined;
    const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const presented = bearer ?? (isUpgrade ? c.req.query("access_token") : undefined);

    if (presented) {
        if (presented.startsWith(TOKEN_PREFIX)) {
            const verified = await store.verifyToken(presented);
            return verified ? { user: verified.user, method: "token" } : undefined;
        }
        const claims = await verifySession(presented);
        const user = claims ? await store.getUser(claims.sub) : undefined;
        // An explicit but invalid credential is a failure — do not fall back to the cookie.
        return user ? { user, method: "session" } : undefined;
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
        const claims = await verifySession(cookie);
        const user = claims ? await store.getUser(claims.sub) : undefined;
        if (user) return { user, method: "session" };
    }
    return undefined;
}

/**
 * Cookie-authenticated requests that change state must come from our own origin.
 * (SameSite=Lax already stops cross-site POSTs in current browsers; this covers
 * the rest. Token-authenticated requests are immune to CSRF and are not checked.)
 */
function crossSiteWrite(c: Context): boolean {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return false;
    const origin = c.req.header("origin");
    if (!origin) return false; // non-browser client
    const expected = getAuthConfig().publicUrl ?? new URL(c.req.url).origin;
    return origin !== new URL(expected).origin;
}

/**
 * Enforces authentication when `auth.mode` is `required`; a no-op otherwise.
 * When a valid credential is presented it is attached to the context even in
 * `off` mode, so `/api/auth/me` and session ownership keep working.
 */
export const authMiddleware = createMiddleware(async (c, next) => {
    const { mode } = getAuthConfig();
    const path = c.req.path;

    let identity: Awaited<ReturnType<typeof authenticate>>;
    try {
        identity = await authenticate(c);
    } catch (err) {
        if (mode === "off") {
            identity = undefined;
        } else {
            process.stderr.write(`[auth] credential check failed: ${err instanceof Error ? err.message : String(err)}\n`);
            return c.json({ error: "Authentication is temporarily unavailable." }, 503);
        }
    }

    c.set("user", identity?.user);
    c.set("authMethod", identity?.method);

    if (mode === "required" && !identity && !isPublic(c.req.method, path)) {
        c.header("WWW-Authenticate", 'Bearer realm="pantheon"');
        return c.json({ error: "Authentication required" }, 401);
    }
    if (identity?.method === "session" && crossSiteWrite(c)) {
        return c.json({ error: "Cross-site request blocked" }, 403);
    }
    return next();
});

/**
 * The user whose data a request may see, or undefined for "everything".
 * Scoping only applies when auth is required — with auth off the instance has a
 * single local user and all sessions are theirs.
 */
export function scopeUserId(c: Context): string | undefined {
    return getAuthConfig().mode === "required" ? c.get("user")?.id : undefined;
}
