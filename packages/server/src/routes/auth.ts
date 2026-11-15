import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes } from "node:crypto";
import { AuthStore, NotAuthorizedError, safeEqual, type User } from "@pantheon/core";
import { getAuthConfig, type OAuthProviderName } from "../auth/config.js";
import { OAuthError, authorizeUrl, completeSignIn, isProviderName } from "../auth/oauth.js";
import { OAUTH_STATE_TTL_SECONDS, SESSION_TTL_SECONDS, signOAuthState, signSession, verifyOAuthState } from "../auth/jwt.js";
import { SESSION_COOKIE } from "../middleware/auth.js";
import { intParam } from "./params.js";

export const authRouter = new Hono();

const store = new AuthStore();
const STATE_COOKIE = "pantheon_oauth";

/**
 * Sign-ins started by `pantheon auth login`, waiting for the CLI to redeem them.
 * In-memory and short-lived by design: a code is useless after two minutes or one
 * use, and losing them on restart only means "run the login again".
 */
const CLI_CODE_TTL_MS = 2 * 60 * 1000;
const pendingCliLogins = new Map<string, { userId: string; challenge: string; expiresAt: number }>();

function sweepCliLogins(): void {
    const now = Date.now();
    for (const [code, entry] of pendingCliLogins) {
        if (entry.expiresAt <= now) pendingCliLogins.delete(code);
    }
}

function publicBase(c: Context): string {
    return getAuthConfig().publicUrl ?? new URL(c.req.url).origin;
}

function redirectUri(c: Context, provider: OAuthProviderName): string {
    return `${publicBase(c)}/api/auth/callback/${provider}`;
}

function isHttps(c: Context): boolean {
    return publicBase(c).startsWith("https://");
}

/** Only same-origin paths are accepted as post-login destinations (no open redirect). */
function safeRedirectPath(value: string | undefined): string | undefined {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
    return value;
}

function publicUser(user: User) {
    return { id: user.id, email: user.email, name: user.name, role: user.role, provider: user.provider };
}

function page(title: string, message: string): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    return `<!doctype html><meta charset="utf-8"><title>${esc(title)} · Pantheon</title>` +
        `<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
        `<h1 style="font-size:1.3rem">◆ ${esc(title)}</h1><p>${esc(message)}</p></body>`;
}

/** GET /api/auth/providers — what a client needs to offer a sign-in. Public. */
authRouter.get("/providers", (c) => {
    const cfg = getAuthConfig();
    return c.json({ mode: cfg.mode, providers: Object.keys(cfg.providers) });
});

/**
 * GET /api/auth/login/:provider — start a sign-in.
 *
 * Browser:  ?redirect=/some/path
 * CLI:      ?cli_port=<loopback port>&cli_challenge=<base64url SHA-256 of a verifier>
 */
authRouter.get("/login/:provider", async (c) => {
    const provider = c.req.param("provider");
    const cfg = getAuthConfig();
    if (!isProviderName(provider) || !cfg.providers[provider]) {
        return c.json({ error: `Sign-in with "${provider}" is not configured on this server.` }, 404);
    }

    const cliPort = c.req.query("cli_port");
    const cliChallenge = c.req.query("cli_challenge");
    let cli: { port: number; challenge: string } | undefined;
    if (cliPort !== undefined || cliChallenge !== undefined) {
        const port = Number(cliPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || !cliChallenge || !/^[A-Za-z0-9_-]{43}$/.test(cliChallenge)) {
            return c.json({ error: "Invalid cli_port or cli_challenge." }, 400);
        }
        cli = { port, challenge: cliChallenge };
    }

    // The nonce ties the eventual callback to the browser that started the flow,
    // so an attacker cannot trick someone into finishing the attacker's sign-in.
    const nonce = randomBytes(24).toString("base64url");
    const redirect = safeRedirectPath(c.req.query("redirect"));
    const state = await signOAuthState({
        provider,
        nonce,
        ...(redirect ? { redirect } : {}),
        ...(cli ? { cli } : {}),
    });

    setCookie(c, STATE_COOKIE, nonce, {
        httpOnly: true,
        sameSite: "Lax", // must survive the top-level redirect back from the provider
        secure: isHttps(c),
        path: "/api/auth",
        maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return c.redirect(
        authorizeUrl(provider, {
            clientId: cfg.providers[provider]!.clientId,
            redirectUri: redirectUri(c, provider),
            state,
        }),
    );
});

/** GET /api/auth/callback/:provider — the provider sends the browser back here. */
authRouter.get("/callback/:provider", async (c) => {
    const provider = c.req.param("provider");
    const cfg = getAuthConfig();
    if (!isProviderName(provider) || !cfg.providers[provider]) {
        return c.html(page("Sign-in failed", "This sign-in provider is not configured."), 404);
    }

    const nonceCookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/auth" });

    if (c.req.query("error")) {
        return c.html(page("Sign-in cancelled", "The provider did not complete the sign-in. You can close this tab and try again."), 400);
    }

    const code = c.req.query("code");
    const state = await verifyOAuthState(c.req.query("state") ?? "");
    if (!code || !state || state.provider !== provider || !nonceCookie || !safeEqual(nonceCookie, state.nonce)) {
        return c.html(page("Sign-in failed", "This sign-in link is invalid or has expired. Please start again."), 400);
    }

    let user: User;
    try {
        const identity = await completeSignIn(provider, {
            code,
            clientId: cfg.providers[provider]!.clientId,
            clientSecret: cfg.providers[provider]!.clientSecret,
            redirectUri: redirectUri(c, provider),
        });
        user = await store.signIn({ ...identity, provider }, cfg.allowedEmails);
    } catch (err) {
        if (err instanceof NotAuthorizedError) {
            return c.html(page("Not authorised", err.message), 403);
        }
        if (err instanceof OAuthError) {
            return c.html(page("Sign-in failed", err.message), 502);
        }
        throw err;
    }

    if (state.cli) {
        // Hand the CLI a single-use code rather than a token: the code travels
        // through the browser's address bar and history, and is worthless without
        // the verifier only the CLI process knows.
        sweepCliLogins();
        const cliCode = randomBytes(32).toString("base64url");
        pendingCliLogins.set(cliCode, {
            userId: user.id,
            challenge: state.cli.challenge,
            expiresAt: Date.now() + CLI_CODE_TTL_MS,
        });
        return c.redirect(`http://127.0.0.1:${state.cli.port}/callback?code=${cliCode}`);
    }

    setCookie(c, SESSION_COOKIE, await signSession(user.id), {
        httpOnly: true,
        sameSite: "Lax",
        secure: isHttps(c),
        path: "/",
        maxAge: SESSION_TTL_SECONDS,
    });
    return state.redirect
        ? c.redirect(state.redirect)
        : c.html(page("Signed in", `You are signed in to Pantheon as ${user.email}.`));
});

/**
 * POST /api/auth/cli/exchange — the CLI redeems its one-time code for an API token.
 * Body: { code, verifier, name? }
 */
authRouter.post("/cli/exchange", async (c) => {
    const body = await c.req.json<{ code?: string; verifier?: string; name?: string }>().catch(() => ({}) as never);
    sweepCliLogins();

    const entry = typeof body.code === "string" ? pendingCliLogins.get(body.code) : undefined;
    // Single use, whatever happens next
    if (typeof body.code === "string") pendingCliLogins.delete(body.code);

    const challenge = typeof body.verifier === "string"
        ? createHash("sha256").update(body.verifier).digest("base64url")
        : "";
    if (!entry || !safeEqual(challenge, entry.challenge)) {
        return c.json({ error: "Invalid or expired login code." }, 400);
    }

    const user = await store.getUser(entry.userId);
    if (!user) return c.json({ error: "Invalid or expired login code." }, 400);

    const { token } = await store.createToken(user.id, (body.name ?? "").trim() || "pantheon CLI");
    return c.json({ token, user: publicUser(user) });
});

/** GET /api/auth/me — who am I? */
authRouter.get("/me", (c) => {
    const user = c.get("user");
    const mode = getAuthConfig().mode;
    if (!user) return c.json({ authenticated: false, mode });
    return c.json({ authenticated: true, mode, method: c.get("authMethod"), user: publicUser(user) });
});

/** POST /api/auth/logout — end the browser session. (API tokens are revoked via DELETE /tokens/:id.) */
authRouter.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
});

// ── API tokens ───────────────────────────────────────────────────────────────

function requireUser(c: Context): User | undefined {
    return c.get("user");
}

/** GET /api/auth/tokens — the caller's tokens (metadata only). */
authRouter.get("/tokens", async (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "Authentication required" }, 401);
    return c.json({ tokens: await store.listTokens(user.id) });
});

/** POST /api/auth/tokens — mint a token. Body: { name, expiresInDays? }. The secret is returned once. */
authRouter.post("/tokens", async (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json<{ name?: string; expiresInDays?: number }>().catch(() => ({}) as never);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);

    const expiresInDays = body.expiresInDays === undefined
        ? undefined
        : intParam(String(body.expiresInDays), 0, 1, 3650);
    if (body.expiresInDays !== undefined && !expiresInDays) {
        return c.json({ error: "expiresInDays must be a number between 1 and 3650" }, 400);
    }

    const { token, info } = await store.createToken(user.id, name, { expiresInDays });
    return c.json({ token, info }, 201);
});

/** DELETE /api/auth/tokens/:id — revoke one of the caller's tokens. */
authRouter.delete("/tokens/:id", async (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "Authentication required" }, 401);
    const revoked = await store.revokeToken(user.id, c.req.param("id"));
    return revoked ? c.json({ ok: true }) : c.json({ error: "Token not found" }, 404);
});
