import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ChatMessage } from "@pantheon/shared";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-ws-"));
const ENV = ["HOME", "PANTHEON_DB_PATH", "DATABASE_URL", "NODE_ENV", "PANTHEON_AUTH"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
process.env["HOME"] = tmpHome;
process.env["PANTHEON_DB_PATH"] = path.join(tmpHome, "ws-test.db");
process.env["NODE_ENV"] = "production";

vi.mock("@pantheon/core", async (importOriginal) => {
    const original = await importOriginal<typeof import("@pantheon/core")>();
    class FakeGateway {
        async stream(_messages: ChatMessage[], model?: string) {
            return {
                decision: { tier: "general", selectedModelId: model ?? "llama-smart", reason: "test" },
                generator: (async function* () {
                    yield "Hel";
                    yield "lo";
                })(),
            };
        }
    }
    return { ...original, Gateway: FakeGateway };
});

const core = await import("@pantheon/core");
const { serve } = await import("@hono/node-server");
const { app, injectWebSocket } = await import("../app.js");
const { matches, closeAllWebSockets } = await import("../routes/ws.js");
const { PANTHEON_VERSION } = await import("@pantheon/shared");

let server: ReturnType<typeof serve>;
let base: string;
let wsBase: string;
const sockets: WebSocket[] = [];

interface Msg { type: string; sessionId?: string; timestamp?: number; data?: Record<string, unknown>; [k: string]: unknown }

/** Open a WebSocket and collect everything it receives. */
function connect(query = ""): Promise<{ ws: WebSocket; messages: Msg[]; next: (type: string, timeoutMs?: number) => Promise<Msg> }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/api/ws${query}`);
        sockets.push(ws);
        const messages: Msg[] = [];
        const waiters: Array<{ type: string; resolve: (m: Msg) => void }> = [];
        ws.onmessage = (evt) => {
            const msg = JSON.parse(String(evt.data)) as Msg;
            messages.push(msg);
            const i = waiters.findIndex((w) => w.type === msg.type);
            if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
        };
        // Messages already handed out by next(), so the same one is not returned twice
        const taken = new WeakSet<Msg>();
        const next = (type: string, timeoutMs = 2000) =>
            new Promise<Msg>((res, rej) => {
                const seen = messages.find((m) => m.type === type && !taken.has(m));
                if (seen) {
                    taken.add(seen);
                    res(seen);
                    return;
                }
                const timer = setTimeout(() => rej(new Error(`timed out waiting for "${type}"`)), timeoutMs);
                waiters.push({ type, resolve: (m) => { clearTimeout(timer); taken.add(m); res(m); } });
            });
        ws.onopen = () => resolve({ ws, messages, next });
        ws.onerror = () => reject(new Error("websocket connection failed"));
    });
}

/** Resolves with true when the upgrade is refused. */
function connectionRefused(query = ""): Promise<boolean> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`${wsBase}/api/ws${query}`);
        sockets.push(ws);
        ws.onopen = () => resolve(false);
        ws.onerror = () => resolve(true);
    });
}

let n = 0;
async function chat(body: Record<string, unknown>, token?: string): Promise<string> {
    const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": `10.7.0.${n++ % 250}`,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ noTools: true, ...body }),
    });
    const text = await res.text();
    return /"sessionId":"([^"]+)"/.exec(text)?.[1] ?? "";
}

const settle = () => new Promise((r) => setTimeout(r, 60));

beforeAll(async () => {
    await core.initDb();
    await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
    });
    injectWebSocket(server);
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
});

beforeEach(() => {
    process.env["PANTHEON_AUTH"] = "off";
});

afterEach(async () => {
    for (const ws of sockets.splice(0)) {
        if (ws.readyState <= 1) ws.close();
    }
    await settle();
});

afterAll(async () => {
    closeAllWebSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await core.TraceCollector.flush();
    await core.closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe("WebSocket feed /api/ws", () => {
    it("greets the client with the server version", async () => {
        const { next } = await connect();
        expect(await next("connected")).toEqual({ type: "connected", version: PANTHEON_VERSION });
    });

    it("delivers a chat turn's events to an observer that did not start it", async () => {
        const { next, messages } = await connect();
        await next("connected");

        const sessionId = await chat({ prompt: "hello there" });
        const done = await next("done");

        expect(done).toMatchObject({ type: "done", sessionId, data: { sessionId, iterations: 1 } });
        expect(typeof done.timestamp).toBe("number");
        const routing = messages.find((m) => m.type === "routing")!;
        expect(routing).toMatchObject({ sessionId, data: { selectedModelId: "llama-smart" } });
        // Token deltas are excluded unless asked for
        expect(messages.some((m) => m.type === "text")).toBe(false);
    });

    it("includes token deltas when `types` asks for them", async () => {
        const { next, messages } = await connect("?types=text,done");
        await next("connected");
        await chat({ prompt: "stream please" });
        await next("done");
        expect(messages.filter((m) => m.type === "text").map((m) => m.data!["content"]).join("")).toBe("Hello");
        expect(messages.some((m) => m.type === "routing")).toBe(false);
    });

    it("filters by sessionId", async () => {
        const first = await chat({ prompt: "one" });
        const { next, messages } = await connect(`?sessionId=${first}`);
        expect(await next("connected")).toMatchObject({ sessionId: first });

        const other = await chat({ prompt: "another session" });
        await chat({ prompt: "two", sessionId: first });
        await next("done");
        await settle();

        expect(other).not.toBe(first);
        expect(messages.filter((m) => m.type !== "connected").every((m) => m.sessionId === first)).toBe(true);
        expect(messages.filter((m) => m.type === "done")).toHaveLength(1);
    });

    it("fans out to every connected observer", async () => {
        const a = await connect();
        const b = await connect();
        await Promise.all([a.next("connected"), b.next("connected")]);
        const sessionId = await chat({ prompt: "broadcast" });
        const [da, db] = await Promise.all([a.next("done"), b.next("done")]);
        expect(da.sessionId).toBe(sessionId);
        expect(db.sessionId).toBe(sessionId);
    });

    it("lets a client change its subscription and answers pings", async () => {
        const { ws, next, messages } = await connect();
        await next("connected");

        ws.send(JSON.stringify({ action: "ping" }));
        expect(await next("pong")).toEqual({ type: "pong" });

        ws.send(JSON.stringify({ action: "subscribe", sessionId: "no-such-session", types: ["done"] }));
        expect(await next("subscribed")).toEqual({ type: "subscribed", sessionId: "no-such-session", types: ["done"] });
        await chat({ prompt: "invisible" });
        await settle();
        expect(messages.some((m) => m.type === "done")).toBe(false);

        ws.send(JSON.stringify({ action: "subscribe", sessionId: null, types: null }));
        expect(await next("subscribed")).toEqual({ type: "subscribed" });
        await chat({ prompt: "visible again" });
        expect((await next("done")).type).toBe("done");
    });

    it("answers malformed and unknown messages with an error instead of dropping the connection", async () => {
        const { ws, next } = await connect();
        await next("connected");
        ws.send("not json");
        expect((await next("error")).message).toMatch(/JSON/);
        ws.send(JSON.stringify({ action: "self-destruct" }));
        expect((await next("error")).message).toMatch(/Unknown action/);
        expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it("stops delivering (and unsubscribes) after the client disconnects", async () => {
        const before = core.eventBus.listenerCount;
        const { ws, next } = await connect();
        await next("connected");
        expect(core.eventBus.listenerCount).toBe(before + 1);
        ws.close();
        await settle();
        expect(core.eventBus.listenerCount).toBe(before);
        // Publishing with nobody listening is harmless
        await chat({ prompt: "into the void" });
    });
});

describe("WebSocket feed — authentication", () => {
    const auth = new core.AuthStore();
    async function makeUser(email: string) {
        const user = await auth.upsertUser({ email, provider: "github", providerUserId: email });
        const { token } = await auth.createToken(user.id, "ws");
        return { user, token };
    }

    beforeEach(() => {
        process.env["PANTHEON_AUTH"] = "required";
    });

    it("refuses the upgrade without credentials or with a bad token", async () => {
        expect(await connectionRefused()).toBe(true);
        expect(await connectionRefused("?access_token=pth_wrong")).toBe(true);
    });

    it("accepts an API token passed as access_token (browsers cannot set headers)", async () => {
        const { token } = await makeUser("ws-alice@example.com");
        const { next } = await connect(`?access_token=${token}`);
        expect((await next("connected")).type).toBe("connected");
    });

    it("does not accept access_token on ordinary HTTP requests (it would leak into logs)", async () => {
        const { token } = await makeUser("ws-query@example.com");
        const res = await fetch(`${base}/api/sessions?access_token=${token}`, { headers: { "x-forwarded-for": "10.7.9.9" } });
        expect(res.status).toBe(401);
    });

    it("only shows a user the activity of their own sessions", async () => {
        const alice = await makeUser("ws-a@example.com");
        const bob = await makeUser("ws-b@example.com");
        const aliceFeed = await connect(`?access_token=${alice.token}`);
        const bobFeed = await connect(`?access_token=${bob.token}`);
        await Promise.all([aliceFeed.next("connected"), bobFeed.next("connected")]);

        const aliceSession = await chat({ prompt: "alice's private prompt" }, alice.token);
        await aliceFeed.next("done");
        await settle();

        expect(aliceFeed.messages.some((m) => m.sessionId === aliceSession)).toBe(true);
        expect(bobFeed.messages.filter((m) => m.type !== "connected")).toEqual([]);

        // Asking for that session explicitly does not help either
        bobFeed.ws.send(JSON.stringify({ action: "subscribe", sessionId: aliceSession }));
        await bobFeed.next("subscribed");
        await chat({ prompt: "more", sessionId: aliceSession }, alice.token);
        await aliceFeed.next("done");
        await settle();
        expect(bobFeed.messages.filter((m) => m.type !== "connected" && m.type !== "subscribed")).toEqual([]);
    });
});

describe("subscription matching", () => {
    const event = (over: Partial<import("@pantheon/core").PantheonEvent> = {}) =>
        ({ type: "agent_spawned", sessionId: "s1", timestamp: 1, data: {}, ...over });
    const sub = (over: Partial<import("../routes/ws.js").Subscription> = {}) =>
        ({ sessionId: undefined, types: undefined, userId: undefined, ...over });

    it("with no filters passes everything except token deltas", () => {
        expect(matches(sub(), event())).toBe(true);
        expect(matches(sub(), event({ type: "text" }))).toBe(false);
    });

    it("applies session, type and owner filters together", () => {
        expect(matches(sub({ sessionId: "s1" }), event())).toBe(true);
        expect(matches(sub({ sessionId: "s2" }), event())).toBe(false);
        expect(matches(sub({ types: new Set(["done"]) }), event())).toBe(false);
        expect(matches(sub({ types: new Set(["text"]) }), event({ type: "text" }))).toBe(true);
        expect(matches(sub({ userId: "u1" }), event({ userId: "u2" }))).toBe(false);
        expect(matches(sub({ userId: "u1" }), event({ userId: "u1" }))).toBe(true);
        // Ownerless sessions (created before auth) are visible to any signed-in user
        expect(matches(sub({ userId: "u1" }), event())).toBe(true);
    });
});
