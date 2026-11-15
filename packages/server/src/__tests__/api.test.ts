import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "@pantheon/shared";

// ── Isolated environment: a throw-away HOME (config, plugins) and SQLite file ──
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-api-"));
const saved = { HOME: process.env["HOME"], DB: process.env["PANTHEON_DB_PATH"], URL: process.env["DATABASE_URL"], ENV: process.env["NODE_ENV"] };
process.env["HOME"] = tmpHome;
process.env["PANTHEON_DB_PATH"] = path.join(tmpHome, "api-test.db");
process.env["NODE_ENV"] = "production";
// Each request below names its own client address (x-forwarded-for) to stay clear of the rate limiter
process.env["PANTHEON_TRUST_PROXY"] = "1"; // silences the per-request logger
delete process.env["DATABASE_URL"];

// ── Fake LLM gateway: the chat route must work end-to-end without a model ─────
const gatewayScript = { chunks: ["Hello", ", ", "world"], fail: false };
vi.mock("@pantheon/core", async (importOriginal) => {
    const original = await importOriginal<typeof import("@pantheon/core")>();
    class FakeGateway {
        async stream(_messages: ChatMessage[], model?: string) {
            if (gatewayScript.fail) throw new Error("gateway unavailable");
            const chunks = gatewayScript.chunks;
            return {
                decision: { tier: "general", selectedModelId: model ?? "llama-smart", reason: "test" },
                generator: (async function* () {
                    for (const c of chunks) yield c;
                })(),
            };
        }
    }
    return { ...original, Gateway: FakeGateway };
});

const core = await import("@pantheon/core");
const { app } = await import("../app.js");
const { PANTHEON_VERSION } = await import("@pantheon/shared");

let requestCounter = 0;
/** Each call uses its own client address so the suite never trips the rate limiter. */
async function api(method: string, url: string, body?: unknown) {
    const res = await app.request(url, {
        method,
        headers: {
            "x-forwarded-for": `10.0.${Math.floor(requestCounter / 250)}.${requestCounter++ % 250}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

/** Parse a text/event-stream body into [{ event, data }]. */
async function sse(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
    const text = await res.text();
    return text
        .split("\n\n")
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
            const data = /^data: (.*)$/m.exec(block)?.[1] ?? "{}";
            return { event, data: JSON.parse(data) as Record<string, unknown> };
        });
}

async function wipe() {
    const db = core.getDb();
    const t = core.tablesFor(db);
    for (const table of [t.abRuns, t.consensusRuns, t.subTasks, t.taskPlans, t.agentNodes, t.spans, t.sessionSummaries, t.usageRecords, t.messages, t.sessions, t.apiTokens, t.users]) {
        await db.delete(table);
    }
}

beforeAll(async () => {
    await core.initDb();
});

beforeEach(async () => {
    await core.TraceCollector.flush();
    await wipe();
    gatewayScript.chunks = ["Hello", ", ", "world"];
    gatewayScript.fail = false;
});

afterAll(async () => {
    await core.TraceCollector.flush();
    await core.closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    };
    restore("HOME", saved.HOME);
    restore("PANTHEON_DB_PATH", saved.DB);
    restore("DATABASE_URL", saved.URL);
    restore("NODE_ENV", saved.ENV);
});

describe("health", () => {
    it("GET /api/health reports ok and the current version", async () => {
        const res = await api("GET", "/api/health");
        expect(res.status).toBe(200);
        expect(await json(res)).toMatchObject({ status: "ok", version: PANTHEON_VERSION });
    });

    it("GET /api/health/db reports backend, schema version and row counts", async () => {
        await new core.SessionManager().create("one");
        const body = await json(await api("GET", "/api/health/db"));
        expect(body.status).toBe("ok");
        expect(body.database).toMatchObject({
            dialect: "sqlite",
            location: process.env["PANTHEON_DB_PATH"],
            schemaVersion: core.LATEST_SCHEMA_VERSION,
            latestSchemaVersion: core.LATEST_SCHEMA_VERSION,
        });
        expect(body.database.tables.sessions).toBe(1);
    });

    it("unknown routes return a JSON 404", async () => {
        const res = await api("GET", "/api/nope");
        expect(res.status).toBe(404);
        expect((await json(res)).error).toMatch(/not found/);
    });
});

describe("sessions", () => {
    it("lists sessions newest first with message counts", async () => {
        const sm = new core.SessionManager();
        const first = await sm.create("first");
        await sm.addMessage(first, { role: "user", content: "a" });
        await sm.addMessage(first, { role: "assistant", content: "b" });
        await new Promise((r) => setTimeout(r, 5));
        const second = await sm.create("second");

        const { sessions } = await json(await api("GET", "/api/sessions"));
        expect(sessions.map((s: { id: string }) => s.id)).toEqual([second, first]);
        expect(sessions[1]).toMatchObject({ title: "first", messageCount: 2, isArchived: false });
    });

    it("honours limit/offset and falls back to defaults for junk values", async () => {
        const sm = new core.SessionManager();
        for (let i = 0; i < 12; i++) await sm.create(`s${i}`);

        expect((await json(await api("GET", "/api/sessions?limit=3"))).sessions).toHaveLength(3);
        expect((await json(await api("GET", "/api/sessions?limit=5&offset=10"))).sessions).toHaveLength(2);
        // Non-numeric / out-of-range input used to reach the database as NaN
        expect((await json(await api("GET", "/api/sessions?limit=abc"))).sessions).toHaveLength(10);
        expect((await json(await api("GET", "/api/sessions?limit=-5"))).sessions).toHaveLength(1);
        expect((await json(await api("GET", "/api/sessions?limit=999999"))).sessions).toHaveLength(12);
    });

    it("hides archived sessions unless all=true", async () => {
        const sm = new core.SessionManager();
        const kept = await sm.create("kept");
        const archived = await sm.create("archived");

        expect((await api("POST", `/api/sessions/${archived}/archive`)).status).toBe(200);

        const visible = (await json(await api("GET", "/api/sessions"))).sessions;
        expect(visible.map((s: { id: string }) => s.id)).toEqual([kept]);
        const all = (await json(await api("GET", "/api/sessions?all=true"))).sessions;
        expect(all).toHaveLength(2);
    });

    it("returns a session and its messages", async () => {
        const sm = new core.SessionManager();
        const id = await sm.create();
        await sm.addMessage(id, { role: "user", content: "What is a WAL?" });

        expect((await json(await api("GET", `/api/sessions/${id}`))).session).toMatchObject({ id, title: "What is a WAL?", messageCount: 1 });
        const { messages } = await json(await api("GET", `/api/sessions/${id}/messages`));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ role: "user", content: "What is a WAL?" });
    });

    it("deletes a session together with its messages", async () => {
        const sm = new core.SessionManager();
        const id = await sm.create("doomed");
        await sm.addMessage(id, { role: "user", content: "bye" });

        expect((await api("DELETE", `/api/sessions/${id}`)).status).toBe(200);
        expect((await api("GET", `/api/sessions/${id}`)).status).toBe(404);
        expect(await sm.getMessages(id)).toEqual([]);
    });

    it("answers 404 for every operation on an unknown session", async () => {
        for (const [method, url] of [
            ["GET", "/api/sessions/missing"],
            ["GET", "/api/sessions/missing/messages"],
            ["POST", "/api/sessions/missing/archive"],
            ["DELETE", "/api/sessions/missing"],
        ] as const) {
            const res = await api(method, url);
            expect(res.status, `${method} ${url}`).toBe(404);
            expect((await json(res)).error).toBe("Session not found");
        }
    });
});

describe("cost", () => {
    const usage = (modelId: string, inputTokens: number, outputTokens: number, costUsd: number) => ({
        timestamp: new Date().toISOString(), modelId, inputTokens, outputTokens, costUsd, promptPreview: "p",
    });

    it("summarises usage overall and per model", async () => {
        const tracker = new core.CostTracker();
        await tracker.record(usage("m1", 100, 50, 0.01));
        await tracker.record(usage("m1", 10, 5, 0.002));
        await tracker.record(usage("m2", 1, 1, 0));

        const body = await json(await api("GET", "/api/cost"));
        expect(body.summary).toMatchObject({ totalCalls: 3, totalInputTokens: 111, totalOutputTokens: 56 });
        expect(body.summary.totalCostUsd).toBeCloseTo(0.012, 9);
        expect(body.byModel.m1).toMatchObject({ calls: 2, inputTokens: 110, outputTokens: 55 });
        expect(body.byModel.m2).toMatchObject({ calls: 1, costUsd: 0 });
    });

    it("returns zeros (not nulls) when nothing has been recorded", async () => {
        const body = await json(await api("GET", "/api/cost"));
        expect(body).toEqual({
            summary: { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
            byModel: {},
        });
    });

    it("lists recent records newest first and resets", async () => {
        const tracker = new core.CostTracker();
        for (let i = 1; i <= 4; i++) await tracker.record(usage(`m${i}`, i, i, 0));

        const { records } = await json(await api("GET", "/api/cost/recent?n=2"));
        expect(records.map((r: { modelId: string }) => r.modelId)).toEqual(["m4", "m3"]);
        expect((await json(await api("GET", "/api/cost/recent?n=bogus"))).records).toHaveLength(4);

        expect((await api("DELETE", "/api/cost")).status).toBe(200);
        expect((await json(await api("GET", "/api/cost/recent"))).records).toEqual([]);
    });
});

describe("traces", () => {
    it("lists traces, returns their spans, and clears", async () => {
        const traceId = await core.Tracer.startTrace("sess", async (id) => {
            await core.Tracer.startSpan("root.op", "agent", async () => {
                await core.Tracer.startSpan("child.op", "tool", async () => undefined);
            });
            return id;
        });
        await core.TraceCollector.flush();

        const { traces } = await json(await api("GET", "/api/traces"));
        expect(traces).toHaveLength(1);
        expect(traces[0]).toMatchObject({ traceId, rootSpanName: "root.op", spanCount: 2, status: "ok" });

        const detail = await json(await api("GET", `/api/traces/${traceId}`));
        expect(detail.traceId).toBe(traceId);
        expect(detail.spans.map((s: { name: string }) => s.name).sort()).toEqual(["child.op", "root.op"]);

        expect((await api("DELETE", "/api/traces")).status).toBe(200);
        expect((await json(await api("GET", "/api/traces"))).traces).toEqual([]);
    });

    it("404s for an unknown trace", async () => {
        expect((await api("GET", "/api/traces/missing")).status).toBe(404);
    });
});

describe("agents", () => {
    async function seedRun() {
        const sessionId = await new core.SessionManager().create("orchestrated");
        const store = new core.OrchestrationStore();
        await store.startAgent({ agentId: "root", role: "orchestrator", modelId: "m", sessionId });
        await store.savePlan({
            planId: "plan-1",
            sessionId,
            originalPrompt: "ship it",
            createdAt: new Date().toISOString(),
            tasks: [
                { id: "plan-1_a", title: "A", description: "d", dependencies: [], status: "pending", taskRole: "code" },
                { id: "plan-1_b", title: "B", description: "d", dependencies: ["plan-1_a"], status: "pending", taskRole: "debug" },
            ],
        });
        await store.startAgent({ agentId: "coder", role: "coder", modelId: "m", sessionId, parentAgentId: "root", taskId: "plan-1_a" });
        await store.updateSubTask("plan-1_a", { status: "completed", agentId: "coder", result: "done" });
        return sessionId;
    }

    it("lists agents (optionally by session) and returns one by id", async () => {
        const sessionId = await seedRun();

        const { agents } = await json(await api("GET", "/api/agents"));
        expect(agents.map((a: { agentId: string }) => a.agentId).sort()).toEqual(["coder", "root"]);
        expect((await json(await api("GET", `/api/agents?sessionId=${sessionId}&limit=1`))).agents).toHaveLength(1);
        expect((await json(await api("GET", "/api/agents?sessionId=other"))).agents).toEqual([]);

        const { agent } = await json(await api("GET", "/api/agents/coder"));
        expect(agent).toMatchObject({ agentId: "coder", role: "coder", parentAgentId: "root", taskId: "plan-1_a", status: "running" });
        expect(typeof agent.startTime).toBe("number");
    });

    it("returns the plan with decoded task dependencies and roles", async () => {
        await seedRun();
        const { plan } = await json(await api("GET", "/api/agents/coder/plan"));
        expect(plan).toMatchObject({ planId: "plan-1", originalPrompt: "ship it" });
        expect(plan.tasks).toHaveLength(2);
        expect(plan.tasks[0]).toMatchObject({ id: "plan-1_a", status: "completed", taskRole: "code", dependencies: [], result: "done" });
        expect(plan.tasks[1]).toMatchObject({ id: "plan-1_b", taskRole: "debug", dependencies: ["plan-1_a"] });
    });

    it("404s for an unknown agent, and for an agent whose session has no plan", async () => {
        expect((await api("GET", "/api/agents/missing")).status).toBe(404);
        expect((await api("GET", "/api/agents/missing/plan")).status).toBe(404);

        const sessionId = await new core.SessionManager().create("no plan");
        await new core.OrchestrationStore().startAgent({ agentId: "lonely", role: "planner", modelId: "m", sessionId });
        const res = await api("GET", "/api/agents/lonely/plan");
        expect(res.status).toBe(404);
        expect((await json(res)).error).toMatch(/No task plan/);
    });
});

describe("consensus", () => {
    it("lists run summaries and returns full detail", async () => {
        const store = new core.ConsensusStore();
        await store.save({
            id: "run-1", promptHash: "h", synthesizedContent: "the answer", synthesisLatencyMs: 5,
            responses: [{ modelId: "a", content: "x", latencyMs: 1, inputTokens: 1, outputTokens: 1 }],
        });
        await store.updateQualityScore("run-1", 9);

        const { runs } = await json(await api("GET", "/api/consensus"));
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ id: "run-1", qualityScore: 9 });
        expect(runs[0]).not.toHaveProperty("synthesizedContent");

        const { run } = await json(await api("GET", "/api/consensus/run-1"));
        expect(run).toMatchObject({ id: "run-1", synthesizedContent: "the answer" });
        expect(run.modelResponses).toEqual([{ modelId: "a", content: "x", latencyMs: 1, inputTokens: 1, outputTokens: 1 }]);

        expect((await api("GET", "/api/consensus/missing")).status).toBe(404);
    });
});

describe("A/B", () => {
    it("lists experiments (none configured) and computes a comparison", async () => {
        expect(await json(await api("GET", "/api/ab/experiments"))).toEqual({ experiments: [] });

        const store = new core.ABStore();
        const base = { experimentId: "exp", sessionId: "", promptHash: "h", inputTokens: 1, outputTokens: 1 };
        await store.save({ ...base, arm: "control", modelId: "a", latencyMs: 100 });
        await store.save({ ...base, arm: "control", modelId: "a", latencyMs: 300 });
        await new Promise((r) => setTimeout(r, 5)); // distinct createdAt, so "most recent" is unambiguous
        const variant = await store.save({ ...base, arm: "variant", modelId: "b", latencyMs: 50 });
        await store.updateQualityScore(variant.id, 8);

        const { comparison } = await json(await api("GET", "/api/ab/experiments/exp/comparison"));
        expect(comparison).toEqual({
            experimentId: "exp", runCount: 3, controlRunCount: 2, variantRunCount: 1,
            controlAvgLatencyMs: 200, variantAvgLatencyMs: 50,
            controlAvgQualityScore: null, variantAvgQualityScore: 8,
        });

        expect((await json(await api("GET", "/api/ab/experiments/exp/runs"))).runs).toHaveLength(3);
        const limited = (await json(await api("GET", "/api/ab/experiments/exp/runs?limit=1"))).runs;
        expect(limited).toHaveLength(1);
        expect(limited[0].id).toBe(variant.id); // the most recent run
    });
});

describe("models", () => {
    it("lists the default model catalogue", async () => {
        const body = await json(await api("GET", "/api/models"));
        expect(body.models.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(["llama-smart", "deepseek-v4-flash", "deepseek-v4-pro"]));
        expect(body.defaultModel).toBe("deepseek-v4-flash");
    });

    it("rejects an unknown or missing default model", async () => {
        expect((await api("PUT", "/api/models/default", {})).status).toBe(400);
        expect((await api("PUT", "/api/models/default", { id: "not-a-model" })).status).toBe(404);
    });
});

describe("chat", () => {
    it("rejects an empty prompt with 400", async () => {
        const res = await api("POST", "/api/chat", { prompt: "   " });
        expect(res.status).toBe(400);
        expect((await json(res)).error).toBe("prompt is required");
    });

    it("streams a reply, creates the session and persists both turns", async () => {
        const events = await sse(await api("POST", "/api/chat", { prompt: "  say hello  ", noTools: true }));

        expect(events.map((e) => e.event)).toEqual(["routing", "text", "text", "text", "done"]);
        expect(events.filter((e) => e.event === "text").map((e) => e.data["content"]).join("")).toBe("Hello, world");

        const sessionId = events.at(-1)!.data["sessionId"] as string;
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

        const sm = new core.SessionManager();
        const messages = await sm.getMessages(sessionId);
        expect(messages.map((m) => [m.role, m.content])).toEqual([
            ["user", "say hello"],
            ["assistant", "Hello, world"],
        ]);
        expect((await sm.get(sessionId))?.title).toBe("say hello");
    });

    it("continues an existing session, keeping earlier messages", async () => {
        const first = await sse(await api("POST", "/api/chat", { prompt: "one", noTools: true }));
        const sessionId = first.at(-1)!.data["sessionId"] as string;

        gatewayScript.chunks = ["second reply"];
        const second = await sse(await api("POST", "/api/chat", { prompt: "two", noTools: true, sessionId, model: "pinned-model" }));

        expect(second.at(-1)!.data["sessionId"]).toBe(sessionId);
        expect(second[0]).toMatchObject({ event: "routing", data: { selectedModelId: "pinned-model" } });
        const contents = (await new core.SessionManager().getMessages(sessionId)).map((m) => m.content);
        expect(contents).toEqual(["one", "Hello, world", "two", "second reply"]);
    });

    it("reports an unknown sessionId as a clear error and writes nothing", async () => {
        const events = await sse(await api("POST", "/api/chat", { prompt: "hi", noTools: true, sessionId: "does-not-exist" }));
        expect(events).toEqual([{ event: "error", data: { message: 'Session "does-not-exist" not found' } }]);
        expect(await new core.SessionManager().list()).toEqual([]);
    });

    it("turns a gateway failure into an error event while keeping the user's message", async () => {
        gatewayScript.fail = true;
        const events = await sse(await api("POST", "/api/chat", { prompt: "hi", noTools: true }));
        expect(events.at(-1)).toEqual({ event: "error", data: { message: "gateway unavailable" } });

        const [session] = await new core.SessionManager().list();
        expect(session?.messageCount).toBe(1);
    });

    it("POST /api/chat/respond 404s when no permission request is pending", async () => {
        const res = await api("POST", "/api/chat/respond", { toolCallId: "nope", decision: "deny" });
        expect(res.status).toBe(404);
    });
});

describe("rate limiting", () => {
    it("returns 429 once a single client exceeds the global limit", async () => {
        const hit = () => app.request("/api/health", { headers: { "x-forwarded-for": "203.0.113.77" } });
        const statuses: number[] = [];
        for (let i = 0; i < 101; i++) statuses.push((await hit()).status);
        expect(statuses.slice(0, 100).every((s) => s === 200)).toBe(true);
        expect(statuses[100]).toBe(429);
    });
});
