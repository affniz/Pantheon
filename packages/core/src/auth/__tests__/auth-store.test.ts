import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { BACKENDS, useBackend } from "../../db/__tests__/backends.js";
import { rawExecutor } from "../../db/client.js";
import { SessionManager } from "../../session/session-manager.js";
import { AuthStore, NotAuthorizedError, hashToken, safeEqual, TOKEN_PREFIX } from "../auth-store.js";

const alice = { email: "alice@example.com", name: "Alice", provider: "github" as const, providerUserId: "gh-1" };
const bob = { email: "bob@example.com", name: "Bob", provider: "google" as const, providerUserId: "goog-2" };

describe.each(BACKENDS)("AuthStore [$name]", (backend) => {
    const getDb = useBackend(backend);
    let auth: AuthStore;

    beforeEach(() => {
        auth = new AuthStore(getDb());
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("users", () => {
        it("the first user becomes the owner, later users are members", async () => {
            const first = await auth.upsertUser(alice);
            const second = await auth.upsertUser(bob);
            expect(first).toMatchObject({ email: "alice@example.com", name: "Alice", provider: "github", role: "owner" });
            expect(second.role).toBe("member");
            expect(await auth.countUsers()).toBe(2);
            expect((await auth.listUsers()).map((u) => u.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
        });

        it("normalises e-mail case and whitespace", async () => {
            const user = await auth.upsertUser({ ...alice, email: "  Alice@Example.COM " });
            expect(user.email).toBe("alice@example.com");
            expect((await auth.getUserByEmail("ALICE@example.com"))?.id).toBe(user.id);
        });

        it("signing in again updates the same user instead of creating another", async () => {
            const first = await auth.upsertUser(alice);
            const again = await auth.upsertUser({ ...alice, name: "Alice Renamed" });
            expect(again.id).toBe(first.id);
            expect(again.name).toBe("Alice Renamed");
            expect(again.role).toBe("owner");
            expect(await auth.countUsers()).toBe(1);
        });

        it("follows a provider identity whose e-mail changed", async () => {
            const first = await auth.upsertUser(alice);
            const moved = await auth.upsertUser({ ...alice, email: "alice@new-domain.com" });
            expect(moved.id).toBe(first.id);
            expect(moved.email).toBe("alice@new-domain.com");
        });

        it("links a second provider to the same account by e-mail", async () => {
            const viaGithub = await auth.upsertUser(alice);
            const viaGoogle = await auth.upsertUser({ ...alice, provider: "google", providerUserId: "goog-99" });
            expect(viaGoogle.id).toBe(viaGithub.id);
            expect(viaGoogle.provider).toBe("google");
            expect(await auth.countUsers()).toBe(1);
        });

        it("getUser / getUserByEmail return undefined for unknown users", async () => {
            expect(await auth.getUser("nope")).toBeUndefined();
            expect(await auth.getUserByEmail("nobody@example.com")).toBeUndefined();
        });
    });

    describe("signIn policy", () => {
        it("lets the first person in and makes them owner", async () => {
            expect((await auth.signIn(alice)).role).toBe("owner");
        });

        it("rejects strangers once an owner exists (closed by default)", async () => {
            await auth.signIn(alice);
            await expect(auth.signIn(bob)).rejects.toBeInstanceOf(NotAuthorizedError);
            await expect(auth.signIn(bob)).rejects.toThrow(/allowedEmails/);
            expect(await auth.countUsers()).toBe(1);
        });

        it("admits people on the allow-list (case-insensitively) and existing users", async () => {
            await auth.signIn(alice);
            const admitted = await auth.signIn(bob, ["BOB@example.com"]);
            expect(admitted.role).toBe("member");
            // Once they have an account they stay in even if removed from the list
            expect((await auth.signIn(bob, [])).id).toBe(admitted.id);
        });

        it('"*" opens sign-up to anyone', async () => {
            await auth.signIn(alice);
            expect((await auth.signIn(bob, ["*"])).email).toBe("bob@example.com");
        });

        it("with an allow-list configured, even the first user must be on it", async () => {
            await expect(auth.signIn(alice, ["bob@example.com"])).rejects.toBeInstanceOf(NotAuthorizedError);
            expect(await auth.countUsers()).toBe(0);
            expect((await auth.signIn(bob, ["bob@example.com"])).role).toBe("owner");
        });
    });

    describe("API tokens", () => {
        it("creates a prefixed token, returns it once, and stores only its hash", async () => {
            const user = await auth.upsertUser(alice);
            const { token, info } = await auth.createToken(user.id, "laptop");

            expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
            expect(token.length).toBeGreaterThan(40);
            expect(info).toMatchObject({ userId: user.id, name: "laptop", prefix: token.slice(0, 10) });
            expect(info).not.toHaveProperty("tokenHash");

            const rows = await rawExecutor(getDb()).all<Record<string, string>>("SELECT * FROM api_tokens");
            expect(rows).toHaveLength(1);
            expect(rows[0]!["token_hash"]).toBe(hashToken(token));
            expect(JSON.stringify(rows)).not.toContain(token);
        });

        it("every token is unique", async () => {
            const user = await auth.upsertUser(alice);
            const tokens = await Promise.all(Array.from({ length: 5 }, (_, i) => auth.createToken(user.id, `t${i}`)));
            expect(new Set(tokens.map((t) => t.token)).size).toBe(5);
        });

        it("verifyToken resolves the owning user and records last use", async () => {
            const user = await auth.upsertUser(alice);
            const { token, info } = await auth.createToken(user.id, "ci");
            expect(info.lastUsedAt).toBeUndefined();

            const verified = await auth.verifyToken(token);
            expect(verified?.user).toMatchObject({ id: user.id, email: "alice@example.com", role: "owner" });
            expect(verified?.token.id).toBe(info.id);
            expect((await auth.listTokens(user.id))[0]!.lastUsedAt).toBeDefined();
        });

        it("rejects unknown, malformed and wrong-prefix tokens", async () => {
            const user = await auth.upsertUser(alice);
            const { token } = await auth.createToken(user.id, "t");
            expect(await auth.verifyToken(token + "x")).toBeUndefined();
            expect(await auth.verifyToken(token.slice(TOKEN_PREFIX.length))).toBeUndefined();
            expect(await auth.verifyToken("")).toBeUndefined();
            expect(await auth.verifyToken(TOKEN_PREFIX)).toBeUndefined();
            // The stored hash is not itself a credential
            expect(await auth.verifyToken(hashToken(token))).toBeUndefined();
        });

        it("rejects expired tokens and accepts unexpired ones", async () => {
            const user = await auth.upsertUser(alice);
            const { token, info } = await auth.createToken(user.id, "short", { expiresInDays: 1 });
            expect(info.expiresAt).toBeDefined();
            expect(await auth.verifyToken(token)).toBeDefined();

            vi.useFakeTimers();
            vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
            expect(await auth.verifyToken(token)).toBeUndefined();
        });

        it("revoked tokens stop working immediately; revoking twice reports false", async () => {
            const user = await auth.upsertUser(alice);
            const { token, info } = await auth.createToken(user.id, "t");
            expect(await auth.revokeToken(user.id, info.id)).toBe(true);
            expect(await auth.verifyToken(token)).toBeUndefined();
            expect(await auth.revokeToken(user.id, info.id)).toBe(false);
            expect((await auth.listTokens(user.id))[0]!.revokedAt).toBeDefined();
        });

        it("a user cannot revoke or list someone else's tokens", async () => {
            const a = await auth.upsertUser(alice);
            const b = await auth.upsertUser(bob);
            const { token, info } = await auth.createToken(a.id, "alice's");
            expect(await auth.revokeToken(b.id, info.id)).toBe(false);
            expect(await auth.verifyToken(token)).toBeDefined();
            expect(await auth.listTokens(b.id)).toEqual([]);
        });

        it("createToken rejects an unknown user", async () => {
            await expect(auth.createToken("ghost", "t")).rejects.toThrow();
        });
    });

    describe("session ownership", () => {
        it("records the owner and scopes listing to them", async () => {
            const a = await auth.upsertUser(alice);
            const b = await auth.upsertUser(bob);
            const sessions = new SessionManager(getDb());
            const mine = await sessions.create("alice's", a.id);
            const theirs = await sessions.create("bob's", b.id);
            const legacy = await sessions.create("pre-auth");

            expect((await sessions.get(mine))?.userId).toBe(a.id);
            expect((await sessions.get(legacy))?.userId).toBeUndefined();
            expect((await sessions.list({ userId: a.id })).map((s) => s.id)).toEqual([mine]);
            expect((await sessions.list()).map((s) => s.id).sort()).toEqual([mine, theirs, legacy].sort());
        });

        it("isAccessibleBy: owner yes, other users no, ownerless sessions yes, unknown no", async () => {
            const a = await auth.upsertUser(alice);
            const b = await auth.upsertUser(bob);
            const sessions = new SessionManager(getDb());
            const mine = await sessions.create("mine", a.id);
            const legacy = await sessions.create("legacy");

            expect(await sessions.isAccessibleBy(mine, a.id)).toBe(true);
            expect(await sessions.isAccessibleBy(mine, b.id)).toBe(false);
            expect(await sessions.isAccessibleBy(legacy, b.id)).toBe(true);
            expect(await sessions.isAccessibleBy("missing", a.id)).toBe(false);
        });
    });
});

describe("token helpers", () => {
    it("hashToken is a deterministic SHA-256 hex digest", () => {
        expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("safeEqual compares strings without throwing on length mismatch", () => {
        expect(safeEqual("secret", "secret")).toBe(true);
        expect(safeEqual("secret", "secreT")).toBe(false);
        expect(safeEqual("secret", "secret-longer")).toBe(false);
        expect(safeEqual("", "")).toBe(true);
    });
});
