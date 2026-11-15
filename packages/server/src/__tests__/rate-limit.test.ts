import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-rl-"));
const ENV = ["HOME", "PANTHEON_DB_PATH", "DATABASE_URL", "NODE_ENV", "PANTHEON_AUTH", "PANTHEON_TRUST_PROXY"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
process.env["HOME"] = tmpHome;
process.env["PANTHEON_DB_PATH"] = path.join(tmpHome, "rl.db");
process.env["NODE_ENV"] = "production";

const core = await import("@pantheon/core");
const { serve } = await import("@hono/node-server");
const { Hono } = await import("hono");
const { clientAddress, isLoopback, globalRateLimiter, llmRateLimiter } = await import("../middleware/rate-limiter.js");

/** A fresh app + limiter per test would need fresh limiter state; use distinct paths' keys instead. */
let server: ReturnType<typeof serve>;
let base: string;

beforeAll(async () => {
    const app = new Hono();
    app.use("/limited/*", globalRateLimiter);
    app.use("/llm/*", llmRateLimiter);
    app.get("/whoami", (c) => c.json({ address: clientAddress(c) }));
    app.get("/limited/ping", (c) => c.json({ ok: true }));
    app.get("/llm/ping", (c) => c.json({ ok: true }));
    await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
    delete process.env["PANTHEON_TRUST_PROXY"];
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await core.closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

const whoami = async (headers: Record<string, string> = {}) =>
    ((await (await fetch(`${base}/whoami`, { headers })).json()) as { address: string }).address;

describe("client address", () => {
    it("is the TCP peer by default — forwarded headers are ignored", async () => {
        expect(await whoami()).toBe("127.0.0.1");
        expect(await whoami({ "x-forwarded-for": "203.0.113.9" })).toBe("127.0.0.1");
        expect(await whoami({ "x-real-ip": "203.0.113.9" })).toBe("127.0.0.1");
    });

    it("uses the proxy-supplied address only when PANTHEON_TRUST_PROXY is set", async () => {
        process.env["PANTHEON_TRUST_PROXY"] = "1";
        expect(await whoami({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("203.0.113.9");
        expect(await whoami({ "x-real-ip": "198.51.100.4" })).toBe("198.51.100.4");
        expect(await whoami()).toBe("127.0.0.1"); // falls back to the peer
    });

    it("isLoopback", () => {
        expect(isLoopback("127.0.0.1")).toBe(true);
        expect(isLoopback("::1")).toBe(true);
        expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
        expect(isLoopback("203.0.113.9")).toBe(false);
    });
});

describe("rate limiting cannot be dodged with forged headers", () => {
    it("a client rotating X-Forwarded-For still hits the global limit", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 103; i++) {
            const res = await fetch(`${base}/limited/ping`, { headers: { "x-forwarded-for": `198.51.100.${i}` } });
            statuses.push(res.status);
        }
        expect(statuses.filter((s) => s === 200)).toHaveLength(100);
        expect(statuses.slice(100)).toEqual([429, 429, 429]);
    });

    it("claiming to be 127.0.0.1 does not buy a remote client the local LLM quota", async () => {
        // Behind a trusted proxy the original client is remote → 15/min, whatever it claims further along
        process.env["PANTHEON_TRUST_PROXY"] = "1";
        const statuses: number[] = [];
        for (let i = 0; i < 17; i++) {
            statuses.push((await fetch(`${base}/llm/ping`, { headers: { "x-forwarded-for": "203.0.113.50, 127.0.0.1" } })).status);
        }
        expect(statuses.filter((s) => s === 200)).toHaveLength(15);
        expect(statuses.slice(15)).toEqual([429, 429]);
    });

    it("a client on this machine gets the higher LLM quota", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 20; i++) statuses.push((await fetch(`${base}/llm/ping`)).status);
        expect(statuses.every((s) => s === 200)).toBe(true);
    });
});
