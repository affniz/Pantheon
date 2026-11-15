import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "@pantheon/shared";

// ── Isolated environment ─────────────────────────────────────────────────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-auth-"));
const ENV = [
    "HOME", "PANTHEON_DB_PATH", "DATABASE_URL", "NODE_ENV", "PANTHEON_AUTH", "PANTHEON_JWT_SECRET",
    "PANTHEON_PUBLIC_URL", "PANTHEON_ALLOWED_EMAILS", "PANTHEON_GITHUB_CLIENT_ID", "PANTHEON_GITHUB_CLIENT_SECRET",
    "PANTHEON_GOOGLE_CLIENT_ID", "PANTHEON_GOOGLE_CLIENT_SECRET",
] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
process.env["HOME"] = tmpHome;
process.env["PANTHEON_DB_PATH"] = path.join(tmpHome, "auth-test.db");
process.env["NODE_ENV"] = "production";
process.env["PANTHEON_AUTH"] = "required";
process.env["PANTHEON_PUBLIC_URL"] = "https://pantheon.test";
process.env["PANTHEON_GITHUB_CLIENT_ID"] = "gh-client";
process.env["PANTHEON_GITHUB_CLIENT_SECRET"] = "gh-secret";
process.env["PANTHEON_GOOGLE_CLIENT_ID"] = "goog-client";
process.env["PANTHEON_GOOGLE_CLIENT_SECRET"] = "goog-secret";

vi.mock("@pantheon/core", async (importOriginal) => {
    const original = await importOriginal<typeof import("@pantheon/core")>();
    class FakeGateway {
        async stream(_messages: ChatMessage[], model?: string) {
            return {
                decision: { tier: "general", selectedModelId: model ?? "llama-smart", reason: "test" },
                generator: (async function* () {
                    yield "ok";
                })(),
            };
        }
    }
    return { ...original, Gateway: FakeGateway };
});

const core = await import("@pantheon/core");
const { app } = await import("../app.js");
const { signSession, signOAuthState, verifySession, jwtSecret, resetJwtSecretCache } = await import("../auth/jwt.js");
const { getAuthConfig } = await import("../auth/config.js");

// ── Helpers ──────────────────────────────────────────────────────────────────
let n = 0;
interface Opts { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> }
async function api(method: string, url: string, opts: Opts = {}) {
    return app.request(url, {
        method,
        redirect: "manual",
        headers: {
            "x-forwarded-for": `10.9.${Math.floor(n / 250)}.${n++ % 250}`,
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.cookie ? { cookie: opts.cookie } : {}),
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
            ...opts.headers,
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const cookieOf = (res: Response, name: string): string | undefined => {
    for (const header of res.headers.getSetCookie()) {
        const [pair] = header.split(";");
        if (pair?.startsWith(`${name}=`)) return pair;
    }
    return undefined;
};

const auth = new core.AuthStore();
async function makeUser(email: string) {
    const user = await auth.upsertUser({ email, name: email.split("@")[0], provider: "github", providerUserId: `id-${email}` });
    const { token, info } = await auth.createToken(user.id, "test");
    return { user, token, tokenId: info.id };
}

/** Stand-in for github.com / googleapis.com. */
function mockProviders(overrides: Partial<{
    githubToken: unknown; githubUser: unknown; githubEmails: unknown; googleToken: unknown; googleUser: unknown;
}> = {}) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init ? { init } : {}) });
        if (url === "https://github.com/login/oauth/access_token") return reply(overrides.githubToken ?? { access_token: "gh-access" });
        if (url === "https://api.github.com/user") return reply(overrides.githubUser ?? { id: 4242, login: "octo", name: "Octo Cat" });
        if (url === "https://api.github.com/user/emails") {
            return reply(overrides.githubEmails ?? [
                { email: "unverified@example.com", primary: false, verified: false },
                { email: "Octo@Example.com", primary: true, verified: true },
            ]);
        }
        if (url === "https://oauth2.googleapis.com/token") return reply(overrides.googleToken ?? { access_token: "goog-access" });
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
            return reply(overrides.googleUser ?? { sub: "g-777", email: "gina@example.com", email_verified: true, name: "Gina" });
        }
        return reply({ error: "unexpected url " + url }, 500);
    });
    return { calls, spy };
}

/** Run /login and return what the browser would carry to the callback. */
async function startLogin(provider: string, query = "") {
    const res = await api("GET", `/api/auth/login/${provider}${query}`);
    const location = new URL(res.headers.get("location") ?? "http://invalid");
    return { res, location, state: location.searchParams.get("state") ?? "", cookie: cookieOf(res, "pantheon_oauth") ?? "" };
}

async function wipe() {
    const db = core.getDb();
    const t = core.tablesFor(db);
    for (const table of [t.messages, t.usageRecords, t.sessions, t.apiTokens, t.users]) await db.delete(table);
}

beforeAll(async () => {
    await core.initDb();
});
beforeEach(async () => {
    await wipe();
    delete process.env["PANTHEON_ALLOWED_EMAILS"];
    process.env["PANTHEON_AUTH"] = "required";
});
afterEach(() => {
    vi.restoreAllMocks();
});
afterAll(async () => {
    await core.TraceCollector.flush();
    await core.closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

// ─────────────────────────────────────────────────────────────────────────────

describe("auth required — access control", () => {
    it("rejects unauthenticated requests on every protected route", async () => {
        for (const [method, url] of [
            ["GET", "/api/sessions"], ["GET", "/api/cost"], ["GET", "/api/traces"], ["GET", "/api/agents"],
            ["GET", "/api/models"], ["GET", "/api/plugins"], ["GET", "/api/consensus"], ["GET", "/api/ab/experiments"],
            ["GET", "/api/health/db"], ["DELETE", "/api/cost"], ["GET", "/api/auth/me"], ["GET", "/api/auth/tokens"],
            ["POST", "/api/chat/respond"],
        ] as const) {
            const res = await api(method, url);
            expect(res.status, `${method} ${url}`).toBe(401);
            expect(res.headers.get("www-authenticate")).toContain("Bearer");
        }
    });

    it("rejects an unauthenticated chat before doing any work", async () => {
        const res = await api("POST", "/api/chat", { body: { prompt: "hi", noTools: true } });
        expect(res.status).toBe(401);
        expect(await new core.SessionManager().list()).toEqual([]);
    });

    it("keeps health and the sign-in entry points public", async () => {
        expect((await api("GET", "/api/health")).status).toBe(200);
        const providers = await json(await api("GET", "/api/auth/providers"));
        expect(providers).toEqual({ mode: "required", providers: ["github", "google"] });
    });

    it("accepts a valid API token", async () => {
        const { user, token } = await makeUser("alice@example.com");
        const res = await api("GET", "/api/auth/me", { token });
        expect(res.status).toBe(200);
        expect(await json(res)).toEqual({
            authenticated: true, mode: "required", method: "token",
            user: { id: user.id, email: "alice@example.com", name: "alice", role: "owner", provider: "github" },
        });
    });

    it("rejects wrong, revoked and expired tokens", async () => {
        const { user, token, tokenId } = await makeUser("alice@example.com");
        expect((await api("GET", "/api/sessions", { token: token + "x" })).status).toBe(401);
        expect((await api("GET", "/api/sessions", { token: "pth_totally-made-up" })).status).toBe(401);
        expect((await api("GET", "/api/sessions", { token: "not-even-a-token" })).status).toBe(401);
        expect((await api("GET", "/api/sessions", { headers: { authorization: "Basic abc" } })).status).toBe(401);

        await auth.revokeToken(user.id, tokenId);
        expect((await api("GET", "/api/sessions", { token })).status).toBe(401);
    });

    it("accepts a session cookie and a bearer session JWT, but not a forged or mistyped one", async () => {
        const { user } = await makeUser("alice@example.com");
        const jwt = await signSession(user.id);

        expect((await json(await api("GET", "/api/auth/me", { cookie: `pantheon_session=${jwt}` }))).method).toBe("session");
        expect((await api("GET", "/api/auth/me", { token: jwt })).status).toBe(200);

        const tampered = jwt.slice(0, -3) + (jwt.endsWith("aaa") ? "bbb" : "aaa");
        expect((await api("GET", "/api/auth/me", { cookie: `pantheon_session=${tampered}` })).status).toBe(401);

        // An OAuth-state token is signed with the same key but must not work as a session
        const stateToken = await signOAuthState({ provider: "github", nonce: user.id });
        expect((await api("GET", "/api/auth/me", { cookie: `pantheon_session=${stateToken}` })).status).toBe(401);
    });

    it("a session for a deleted user stops working", async () => {
        const { user } = await makeUser("gone@example.com");
        const jwt = await signSession(user.id);
        await wipe();
        expect((await api("GET", "/api/auth/me", { cookie: `pantheon_session=${jwt}` })).status).toBe(401);
    });

    it("an invalid bearer credential is not rescued by a valid cookie", async () => {
        const { user } = await makeUser("alice@example.com");
        const res = await api("GET", "/api/auth/me", { token: "pth_wrong", cookie: `pantheon_session=${await signSession(user.id)}` });
        expect(res.status).toBe(401);
    });

    it("blocks cross-site state-changing requests made with the session cookie", async () => {
        const { user, token } = await makeUser("alice@example.com");
        const cookie = `pantheon_session=${await signSession(user.id)}`;

        const evil = await api("DELETE", "/api/cost", { cookie, headers: { origin: "https://evil.example" } });
        expect(evil.status).toBe(403);
        // Same origin, no Origin header (non-browser), safe methods, and token auth are all fine
        expect((await api("DELETE", "/api/cost", { cookie, headers: { origin: "https://pantheon.test" } })).status).toBe(200);
        expect((await api("DELETE", "/api/cost", { cookie })).status).toBe(200);
        expect((await api("GET", "/api/cost", { cookie, headers: { origin: "https://evil.example" } })).status).toBe(200);
        expect((await api("DELETE", "/api/cost", { token, headers: { origin: "https://evil.example" } })).status).toBe(200);
    });

    it("fails closed on an unrecognised PANTHEON_AUTH value", async () => {
        process.env["PANTHEON_AUTH"] = "requried"; // typo
        expect(getAuthConfig().mode).toBe("required");
        expect((await api("GET", "/api/sessions")).status).toBe(401);
    });
});

describe("auth off (local default)", () => {
    beforeEach(() => {
        process.env["PANTHEON_AUTH"] = "off";
    });

    it("needs no credentials and reports the mode", async () => {
        expect((await api("GET", "/api/sessions")).status).toBe(200);
        expect(await json(await api("GET", "/api/auth/me"))).toEqual({ authenticated: false, mode: "off" });
    });

    it("still recognises a token when one is presented", async () => {
        const { token } = await makeUser("alice@example.com");
        expect((await json(await api("GET", "/api/auth/me", { token }))).authenticated).toBe(true);
    });

    it("a bad token does not lock a local user out", async () => {
        expect((await api("GET", "/api/sessions", { token: "pth_stale" })).status).toBe(200);
    });

    it("does not scope sessions by user", async () => {
        const { user, token } = await makeUser("alice@example.com");
        const sm = new core.SessionManager();
        await sm.create("mine", user.id);
        await sm.create("anonymous");
        expect((await json(await api("GET", "/api/sessions", { token }))).sessions).toHaveLength(2);
    });
});

describe("session isolation between users", () => {
    it("lists only the caller's sessions and hides others as 404", async () => {
        const alice = await makeUser("alice@example.com");
        const bob = await makeUser("bob@example.com");
        const sm = new core.SessionManager();
        const aliceSession = await sm.create("alice's notes", alice.user.id);
        await sm.addMessage(aliceSession, { role: "user", content: "alice's secret" });
        const bobSession = await sm.create("bob's notes", bob.user.id);

        const list = (await json(await api("GET", "/api/sessions", { token: bob.token }))).sessions;
        expect(list.map((s: { id: string }) => s.id)).toEqual([bobSession]);

        for (const [method, url] of [
            ["GET", `/api/sessions/${aliceSession}`],
            ["GET", `/api/sessions/${aliceSession}/messages`],
            ["POST", `/api/sessions/${aliceSession}/archive`],
            ["DELETE", `/api/sessions/${aliceSession}`],
        ] as const) {
            expect((await api(method, url, { token: bob.token })).status, `${method} ${url}`).toBe(404);
        }
        // …and nothing happened to it
        expect((await sm.get(aliceSession))?.isArchived).toBe(false);
        expect((await api("GET", `/api/sessions/${aliceSession}/messages`, { token: alice.token })).status).toBe(200);
    });

    it("chat creates sessions owned by the caller and refuses to continue someone else's", async () => {
        const alice = await makeUser("alice@example.com");
        const bob = await makeUser("bob@example.com");

        const first = await (await api("POST", "/api/chat", { token: alice.token, body: { prompt: "hello", noTools: true } })).text();
        const sessionId = /"sessionId":"([^"]+)"/.exec(first)?.[1];
        expect(sessionId).toBeDefined();
        expect((await new core.SessionManager().get(sessionId!))?.userId).toBe(alice.user.id);

        const hijack = await (await api("POST", "/api/chat", { token: bob.token, body: { prompt: "inject", noTools: true, sessionId } })).text();
        expect(hijack).toContain("event: error");
        expect(hijack).toContain("not found");
        const contents = (await new core.SessionManager().getMessages(sessionId!)).map((m) => m.content);
        expect(contents).toEqual(["hello", "ok"]);
    });
});

describe("API token management", () => {
    it("creates, lists and revokes tokens; the secret is shown exactly once", async () => {
        const { token } = await makeUser("alice@example.com");

        const created = await api("POST", "/api/auth/tokens", { token, body: { name: "ci runner", expiresInDays: 30 } });
        expect(created.status).toBe(201);
        const { token: secret, info } = await json(created);
        expect(secret).toMatch(/^pth_/);
        expect(info).toMatchObject({ name: "ci runner", prefix: secret.slice(0, 10) });
        expect(info.expiresAt).toBeDefined();

        // The new token works
        expect((await api("GET", "/api/auth/me", { token: secret })).status).toBe(200);

        const { tokens } = await json(await api("GET", "/api/auth/tokens", { token }));
        expect(tokens.map((t: { name: string }) => t.name).sort()).toEqual(["ci runner", "test"]);
        expect(JSON.stringify(tokens)).not.toContain(secret);
        expect(JSON.stringify(tokens)).not.toContain("tokenHash");

        expect((await api("DELETE", `/api/auth/tokens/${info.id}`, { token })).status).toBe(200);
        expect((await api("GET", "/api/auth/me", { token: secret })).status).toBe(401);
        expect((await api("DELETE", `/api/auth/tokens/${info.id}`, { token })).status).toBe(404);
    });

    it("validates input", async () => {
        const { token } = await makeUser("alice@example.com");
        expect((await api("POST", "/api/auth/tokens", { token, body: {} })).status).toBe(400);
        expect((await api("POST", "/api/auth/tokens", { token, body: { name: "   " } })).status).toBe(400);
        expect((await api("POST", "/api/auth/tokens", { token, body: { name: "x", expiresInDays: "soon" } })).status).toBe(400);
    });

    it("one user cannot revoke another's token", async () => {
        const alice = await makeUser("alice@example.com");
        const bob = await makeUser("bob@example.com");
        expect((await api("DELETE", `/api/auth/tokens/${alice.tokenId}`, { token: bob.token })).status).toBe(404);
        expect((await api("GET", "/api/auth/me", { token: alice.token })).status).toBe(200);
    });
});

describe("OAuth sign-in", () => {
    it("redirects to the provider with client id, callback URL, scope and a signed state", async () => {
        const { res, location, state, cookie } = await startLogin("github");
        expect(res.status).toBe(302);
        expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
        expect(location.searchParams.get("client_id")).toBe("gh-client");
        expect(location.searchParams.get("redirect_uri")).toBe("https://pantheon.test/api/auth/callback/github");
        expect(location.searchParams.get("scope")).toContain("user:email");
        expect(state.split(".")).toHaveLength(3);
        expect(cookie).toMatch(/^pantheon_oauth=.+/);
        // The client secret never leaves the server
        expect(location.toString()).not.toContain("gh-secret");

        const setCookie = res.headers.getSetCookie().join("\n");
        expect(setCookie).toMatch(/HttpOnly/i);
        expect(setCookie).toMatch(/Secure/i); // public URL is https
        expect(setCookie).toMatch(/SameSite=Lax/i);
    });

    it("404s for an unknown or unconfigured provider", async () => {
        expect((await api("GET", "/api/auth/login/facebook")).status).toBe(404);
        delete process.env["PANTHEON_GOOGLE_CLIENT_SECRET"];
        try {
            expect((await api("GET", "/api/auth/login/google")).status).toBe(404);
            expect((await json(await api("GET", "/api/auth/providers"))).providers).toEqual(["github"]);
        } finally {
            process.env["PANTHEON_GOOGLE_CLIENT_SECRET"] = "goog-secret";
        }
    });

    it("GitHub: completes sign-in, creates the owner from the verified primary e-mail, and sets a session cookie", async () => {
        const { calls } = mockProviders();
        const { state, cookie } = await startLogin("github");

        const res = await api("GET", `/api/auth/callback/github?code=the-code&state=${state}`, { cookie });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("octo@example.com");

        const exchange = calls.find((c) => c.url.endsWith("/access_token"))!;
        expect(JSON.parse(String(exchange.init?.body))).toEqual({
            client_id: "gh-client", client_secret: "gh-secret", code: "the-code",
            redirect_uri: "https://pantheon.test/api/auth/callback/github",
        });

        const [user] = await auth.listUsers();
        expect(user).toMatchObject({ email: "octo@example.com", name: "Octo Cat", provider: "github", role: "owner" });

        const session = cookieOf(res, "pantheon_session")!;
        expect(session).toBeDefined();
        expect((await verifySession(session.split("=")[1]!))?.sub).toBe(user!.id);
        expect((await json(await api("GET", "/api/auth/me", { cookie: session }))).user.email).toBe("octo@example.com");
        // The one-time state cookie is cleared
        expect(res.headers.getSetCookie().some((h) => /^pantheon_oauth=;/.test(h))).toBe(true);
    });

    it("Google: completes sign-in and honours the post-login redirect", async () => {
        mockProviders();
        const { state, cookie, location } = await startLogin("google", "?redirect=/dashboard");
        expect(location.origin).toBe("https://accounts.google.com");

        const res = await api("GET", `/api/auth/callback/google?code=c&state=${state}`, { cookie });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/dashboard");
        expect((await auth.getUserByEmail("gina@example.com"))?.provider).toBe("google");
    });

    it("never redirects off-site after login", async () => {
        mockProviders();
        for (const target of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
            const { state, cookie } = await startLogin("github", `?redirect=${encodeURIComponent(target)}`);
            const res = await api("GET", `/api/auth/callback/github?code=c&state=${state}`, { cookie });
            expect(res.headers.get("location"), target).toBeNull();
            expect(res.status).toBe(200);
        }
    });

    it("rejects a callback without the browser's state cookie (login CSRF)", async () => {
        const { spy } = mockProviders();
        const { state } = await startLogin("github");
        const res = await api("GET", `/api/auth/callback/github?code=c&state=${state}`);
        expect(res.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
        expect(await auth.countUsers()).toBe(0);
    });

    it("rejects a state issued for another browser, another provider, or tampered with", async () => {
        const { spy } = mockProviders();
        const a = await startLogin("github");
        const b = await startLogin("github");
        const g = await startLogin("google");

        expect((await api("GET", `/api/auth/callback/github?code=c&state=${a.state}`, { cookie: b.cookie })).status).toBe(400);
        expect((await api("GET", `/api/auth/callback/github?code=c&state=${g.state}`, { cookie: g.cookie })).status).toBe(400);
        expect((await api("GET", `/api/auth/callback/github?code=c&state=${a.state}x`, { cookie: a.cookie })).status).toBe(400);
        expect((await api("GET", `/api/auth/callback/github?code=c&state=garbage`, { cookie: a.cookie })).status).toBe(400);
        expect((await api("GET", `/api/auth/callback/github?state=${a.state}`, { cookie: a.cookie })).status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
    });

    it("rejects an expired state", async () => {
        mockProviders();
        const { state, cookie } = await startLogin("github");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        try {
            expect((await api("GET", `/api/auth/callback/github?code=c&state=${state}`, { cookie })).status).toBe(400);
        } finally {
            vi.useRealTimers();
        }
    });

    it("reports the provider's own error and a user-cancelled sign-in", async () => {
        mockProviders({ githubToken: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } });
        const { state, cookie } = await startLogin("github");
        const res = await api("GET", `/api/auth/callback/github?code=stale&state=${state}`, { cookie });
        expect(res.status).toBe(502);
        expect(await res.text()).toContain("incorrect or expired");

        const cancelled = await api("GET", `/api/auth/callback/github?error=access_denied&state=${state}`, { cookie });
        expect(cancelled.status).toBe(400);
        expect(await auth.countUsers()).toBe(0);
    });

    it("refuses accounts without a verified e-mail address", async () => {
        mockProviders({ githubEmails: [{ email: "x@example.com", primary: true, verified: false }] });
        const gh = await startLogin("github");
        expect((await api("GET", `/api/auth/callback/github?code=c&state=${gh.state}`, { cookie: gh.cookie })).status).toBe(502);

        vi.restoreAllMocks();
        mockProviders({ googleUser: { sub: "1", email: "x@example.com", email_verified: false } });
        const g = await startLogin("google");
        expect((await api("GET", `/api/auth/callback/google?code=c&state=${g.state}`, { cookie: g.cookie })).status).toBe(502);
        expect(await auth.countUsers()).toBe(0);
    });

    it("is closed by default: a second person is turned away until allow-listed", async () => {
        mockProviders();
        const first = await startLogin("github");
        expect((await api("GET", `/api/auth/callback/github?code=c&state=${first.state}`, { cookie: first.cookie })).status).toBe(200);

        const second = await startLogin("google");
        const denied = await api("GET", `/api/auth/callback/google?code=c&state=${second.state}`, { cookie: second.cookie });
        expect(denied.status).toBe(403);
        expect(await denied.text()).toContain("not allowed");
        expect(cookieOf(denied, "pantheon_session")).toBeUndefined();
        expect(await auth.countUsers()).toBe(1);

        process.env["PANTHEON_ALLOWED_EMAILS"] = "someone@else.com, Gina@Example.com";
        const third = await startLogin("google");
        expect((await api("GET", `/api/auth/callback/google?code=c&state=${third.state}`, { cookie: third.cookie })).status).toBe(200);
        expect((await auth.getUserByEmail("gina@example.com"))?.role).toBe("member");
    });

    it("logout clears the session cookie", async () => {
        const { user } = await makeUser("alice@example.com");
        const res = await api("POST", "/api/auth/logout", { cookie: `pantheon_session=${await signSession(user.id)}` });
        expect(res.status).toBe(200);
        expect(res.headers.getSetCookie().some((h) => /^pantheon_session=;/.test(h))).toBe(true);
    });
});

describe("CLI sign-in (loopback redirect + one-time code)", () => {
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    async function loginAsCli() {
        mockProviders();
        const { state, cookie } = await startLogin("github", `?cli_port=51234&cli_challenge=${challenge}`);
        const res = await api("GET", `/api/auth/callback/github?code=c&state=${state}`, { cookie });
        const location = new URL(res.headers.get("location")!);
        return { res, location, code: location.searchParams.get("code")! };
    }

    it("redirects the browser to the CLI's loopback port with a code, not a token", async () => {
        const { res, location, code } = await loginAsCli();
        expect(res.status).toBe(302);
        expect(location.origin).toBe("http://127.0.0.1:51234");
        expect(location.pathname).toBe("/callback");
        expect(code.length).toBeGreaterThan(30);
        expect(location.toString()).not.toContain("pth_");
        // No browser session is created for a CLI login
        expect(cookieOf(res, "pantheon_session")).toBeUndefined();
    });

    it("exchanges the code plus verifier for a working API token", async () => {
        const { code } = await loginAsCli();
        const res = await api("POST", "/api/auth/cli/exchange", { body: { code, verifier, name: "work laptop" } });
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.token).toMatch(/^pth_/);
        expect(body.user).toMatchObject({ email: "octo@example.com", role: "owner" });

        expect((await api("GET", "/api/auth/me", { token: body.token })).status).toBe(200);
        const tokens = (await json(await api("GET", "/api/auth/tokens", { token: body.token }))).tokens;
        expect(tokens.map((t: { name: string }) => t.name)).toEqual(["work laptop"]);
    });

    it("a code is single-use", async () => {
        const { code } = await loginAsCli();
        expect((await api("POST", "/api/auth/cli/exchange", { body: { code, verifier } })).status).toBe(200);
        expect((await api("POST", "/api/auth/cli/exchange", { body: { code, verifier } })).status).toBe(400);
    });

    it("a stolen code is useless without the verifier — and is burned by the attempt", async () => {
        const { code } = await loginAsCli();
        expect((await api("POST", "/api/auth/cli/exchange", { body: { code, verifier: "wrong" } })).status).toBe(400);
        expect((await api("POST", "/api/auth/cli/exchange", { body: { code, verifier } })).status).toBe(400);
        expect((await api("POST", "/api/auth/cli/exchange", { body: { code } })).status).toBe(400);
        const [user] = await auth.listUsers();
        expect(await auth.listTokens(user!.id)).toEqual([]);
    });

    it("codes expire after two minutes", async () => {
        const { code } = await loginAsCli();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 121_000);
        try {
            expect((await api("POST", "/api/auth/cli/exchange", { body: { code, verifier } })).status).toBe(400);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects malformed exchange requests and bad CLI parameters", async () => {
        expect((await api("POST", "/api/auth/cli/exchange", { body: {} })).status).toBe(400);
        expect((await api("POST", "/api/auth/cli/exchange", { body: { code: "nope", verifier } })).status).toBe(400);
        for (const q of [
            `?cli_port=80&cli_challenge=${challenge}`,          // privileged port
            `?cli_port=abc&cli_challenge=${challenge}`,
            `?cli_port=51234`,                                  // no challenge
            `?cli_port=51234&cli_challenge=short`,
            `?cli_challenge=${challenge}`,                      // no port
        ]) {
            expect((await api("GET", `/api/auth/login/github${q}`)).status, q).toBe(400);
        }
    });
});

describe("JWT signing key", () => {
    it("uses PANTHEON_JWT_SECRET when set and rejects a short one", () => {
        process.env["PANTHEON_JWT_SECRET"] = "x".repeat(40);
        try {
            expect(jwtSecret()).toBe("x".repeat(40));
            process.env["PANTHEON_JWT_SECRET"] = "too-short";
            expect(() => jwtSecret()).toThrow(/at least 32/);
        } finally {
            delete process.env["PANTHEON_JWT_SECRET"];
        }
    });

    it("otherwise generates a key once and persists it with owner-only permissions", () => {
        resetJwtSecretCache();
        const first = jwtSecret();
        const file = path.join(tmpHome, ".pantheon", "jwt-secret");
        expect(fs.readFileSync(file, "utf-8").trim()).toBe(first);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        resetJwtSecretCache();
        expect(jwtSecret()).toBe(first); // survives a "restart"
    });

    it("sessions signed with a different key are rejected", async () => {
        const { user } = await makeUser("alice@example.com");
        process.env["PANTHEON_JWT_SECRET"] = "a".repeat(40);
        const foreign = await signSession(user.id);
        delete process.env["PANTHEON_JWT_SECRET"];
        expect((await api("GET", "/api/auth/me", { cookie: `pantheon_session=${foreign}` })).status).toBe(401);
    });
});
