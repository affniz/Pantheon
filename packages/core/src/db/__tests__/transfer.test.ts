import { describe, it, expect } from "vitest";
import { copyDatabase } from "../transfer.js";
import { createTestDb, getDatabaseStatus, tablesFor, type PantheonDatabase } from "../client.js";
import { cleanPgDb } from "./backends.js";
import { SessionManager } from "../../session/session-manager.js";
import { SessionSummarizer } from "../../session/summarizer.js";
import { CostTracker } from "../../cost/tracker.js";
import { TraceStore } from "../../tracing/store.js";
import { ABStore } from "../../ab/ab-store.js";
import { ConsensusStore } from "../../consensus/consensus-store.js";
import { OrchestrationStore } from "../../orchestrator/store.js";
import { AuthStore } from "../../auth/auth-store.js";

/** Put at least one row — with awkward values — into every table. */
async function seed(db: PantheonDatabase): Promise<{ sessionId: string; archivedId: string }> {
    const auth = new AuthStore(db);
    const user = await auth.upsertUser({ email: "Owner@Example.com", name: "Owner", provider: "github", providerUserId: "42" });
    await auth.createToken(user.id, "laptop");

    const sessions = new SessionManager(db);
    const sessionId = await sessions.create("Migrating session", user.id);
    const archivedId = await sessions.create("Archived");
    await sessions.archive(archivedId);

    await sessions.addMessage(sessionId, { role: "user", content: "héllo 'quoted' \"double\" \n newline — 日本語 🚀" });
    await sessions.addMessage(sessionId, {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "read_file", arguments: { path: "a.ts" } }],
    });
    await sessions.addMessage(sessionId, { role: "tool", content: "file body", toolCallId: "tc1" });

    const cost = new CostTracker(db);
    await cost.record({ timestamp: "2026-10-01T00:00:00.000Z", modelId: "m1", inputTokens: 1_500_000, outputTokens: 7, costUsd: 0.123456789, promptPreview: "p" });
    await cost.record({ timestamp: "2026-10-02T00:00:00.000Z", modelId: "m2", inputTokens: 3, outputTokens: 4, costUsd: 0, promptPreview: "q" });

    const t = tablesFor(db);
    await db.insert(t.sessionSummaries).values({ sessionId, summary: "A summary", createdAt: "2026-10-01T00:00:00.000Z" });

    const now = Date.now(); // > 2^31 — would overflow a Postgres int4 column
    await db.insert(t.spans).values([
        { id: "span-root", traceId: "trace-1", parentSpanId: null, sessionId, name: "agent.run", kind: "agent", startTime: now, endTime: now + 50, durationMs: 50, status: "ok", errorMessage: null, attributes: JSON.stringify({ tier: "complex" }), createdAt: now },
        { id: "span-child", traceId: "trace-1", parentSpanId: "span-root", sessionId, name: "llm.completion", kind: "llm", startTime: now + 1, endTime: now + 40, durationMs: 39, status: "error", errorMessage: "boom", attributes: null, createdAt: now },
    ]);

    const orch = new OrchestrationStore(db);
    await orch.startAgent({ agentId: "agent-root", role: "orchestrator", modelId: "m1", sessionId });
    await orch.startAgent({ agentId: "agent-coder", role: "coder", modelId: "m1", sessionId, parentAgentId: "agent-root", taskId: "plan-1_task-1" });
    await orch.savePlan({
        planId: "plan-1",
        sessionId,
        originalPrompt: "build it",
        createdAt: "2026-10-01T00:00:00.000Z",
        tasks: [
            { id: "plan-1_task-1", title: "One", description: "first", dependencies: [], status: "pending", taskRole: "code" },
            { id: "plan-1_task-2", title: "Two", description: "second", dependencies: ["plan-1_task-1"], status: "pending", taskRole: "debug" },
        ],
    });
    await orch.updateSubTask("plan-1_task-1", { status: "completed", agentId: "agent-coder", result: "done" });
    await orch.completeAgent("agent-coder", "done");

    await db.insert(t.installedPlugins).values([
        { name: "@p/enabled", version: "1.0.0", source: "./x", installedAt: now, enabled: true, config: null, directory: "/plugins/x" },
        { name: "@p/disabled", version: "2.0.0", source: "npm", installedAt: now, enabled: false, config: "{}", directory: "/plugins/y" },
    ]);

    await new ConsensusStore(db).save({
        id: "consensus-1",
        sessionId,
        promptHash: "abc",
        synthesizedContent: "synth",
        responses: [{ modelId: "m1", content: "a", latencyMs: 1, inputTokens: 1, outputTokens: 1 }],
        synthesisLatencyMs: 12,
    });
    await new ConsensusStore(db).updateQualityScore("consensus-1", 7.5);

    const ab = new ABStore(db);
    const run = await ab.save({ experimentId: "exp", sessionId, promptHash: "h", arm: "variant", modelId: "m2", latencyMs: 99, inputTokens: 5, outputTokens: 6 });
    await ab.updateQualityScore(run.id, 8.25);

    return { sessionId, archivedId };
}

/** Everything a user can observe through the stores — must be identical before and after a copy. */
async function snapshot(db: PantheonDatabase, sessionId: string) {
    const sessions = new SessionManager(db);
    const orch = new OrchestrationStore(db);
    const t = tablesFor(db);
    return {
        users: await new AuthStore(db).listUsers(),
        tokens: (await db.select().from(t.apiTokens)),
        sessions: await sessions.list({ includeArchived: true }),
        messages: await sessions.getMessages(sessionId),
        costSummary: await new CostTracker(db).getSummary(),
        costByModel: await new CostTracker(db).getByModel(),
        costRecent: await new CostTracker(db).getRecent(10),
        summary: await new SessionSummarizer({} as never, "m", db).getSummary(sessionId),
        traces: await new TraceStore(db).listTraces(),
        spans: await new TraceStore(db).getSpans("trace-1"),
        agents: await orch.getAgentTree("agent-root"),
        tasks: await orch.getSubTasks("plan-1"),
        plugins: (await db.select().from(t.installedPlugins)).sort((a, b) => a.name.localeCompare(b.name)),
        consensus: await new ConsensusStore(db).get("consensus-1"),
        abRuns: await new ABStore(db).getRuns("exp"),
    };
}

const EXPECTED_COUNTS = {
    users: 1,
    api_tokens: 1,
    sessions: 2,
    messages: 3,
    usage_records: 2,
    session_summaries: 1,
    spans: 2,
    agent_nodes: 2,
    task_plans: 1,
    sub_tasks: 2,
    installed_plugins: 2,
    consensus_runs: 1,
    ab_runs: 1,
};

const DIRECTIONS = [
    { name: "SQLite → PostgreSQL", source: async () => createTestDb(), target: () => cleanPgDb() },
    { name: "PostgreSQL → SQLite", source: () => cleanPgDb(), target: async () => createTestDb() },
    { name: "SQLite → SQLite", source: async () => createTestDb(), target: async () => createTestDb() },
];

describe.each(DIRECTIONS)("copyDatabase: $name", ({ source, target }) => {
    it("copies every table and preserves all values", async () => {
        const src = await source();
        const dst = await target();
        const { sessionId } = await seed(src);
        const before = await snapshot(src, sessionId);

        const report = await copyDatabase(src, dst);

        expect(Object.fromEntries(Object.entries(report.tables).map(([k, v]) => [k, v.inserted]))).toEqual(EXPECTED_COUNTS);
        expect(report.totalInserted).toBe(report.totalRead);
        expect((await getDatabaseStatus(dst)).tables).toEqual(EXPECTED_COUNTS);

        // Same observable data on the other side
        expect(await snapshot(dst, sessionId)).toEqual(before);
        // …and the source was not modified
        expect(await snapshot(src, sessionId)).toEqual(before);
    });

    it("is idempotent — a second run copies nothing and duplicates nothing", async () => {
        const src = await source();
        const dst = await target();
        const { sessionId } = await seed(src);
        await copyDatabase(src, dst);

        const second = await copyDatabase(src, dst);
        expect(second.totalInserted).toBe(0);
        expect(second.totalRead).toBe(Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0));
        expect((await getDatabaseStatus(dst)).tables).toEqual(EXPECTED_COUNTS);
        expect((await new SessionManager(dst).getMessages(sessionId))).toHaveLength(3);
    });

    it("resumes after a partial copy and picks up rows added since", async () => {
        const src = await source();
        const dst = await target();
        const { sessionId } = await seed(src);
        await copyDatabase(src, dst);

        await new SessionManager(src).addMessage(sessionId, { role: "user", content: "written after the first copy" });
        const report = await copyDatabase(src, dst);

        expect(report.tables["messages"]).toEqual({ read: 4, inserted: 1 });
        const messages = await new SessionManager(dst).getMessages(sessionId);
        expect(messages.at(-1)?.content).toBe("written after the first copy");
    });

    it("leaves auto-increment ids usable — new rows do not collide with copied ones", async () => {
        const src = await source();
        const dst = await target();
        const { sessionId } = await seed(src);
        await copyDatabase(src, dst);

        // Would throw "duplicate key" on PostgreSQL if the SERIAL sequences were not advanced
        await new SessionManager(dst).addMessage(sessionId, { role: "user", content: "new after migration" });
        await new CostTracker(dst).record({ timestamp: "t", modelId: "m3", inputTokens: 1, outputTokens: 1, costUsd: 0, promptPreview: "" });

        const messages = await new SessionManager(dst).getMessages(sessionId);
        expect(messages).toHaveLength(4);
        expect(messages.at(-1)?.content).toBe("new after migration");
        expect((await new CostTracker(dst).getSummary()).totalCalls).toBe(3);
    });

    it("pages through tables larger than the batch size", async () => {
        const src = await source();
        const dst = await target();
        const sessions = new SessionManager(src);
        const id = await sessions.create("big");
        for (let i = 0; i < 23; i++) {
            await sessions.addMessage(id, { role: "user", content: `message ${i}` });
        }

        const seen: string[] = [];
        const report = await copyDatabase(src, dst, { batchSize: 5, onTable: (t) => seen.push(t) });

        expect(report.tables["messages"]).toEqual({ read: 23, inserted: 23 });
        expect(seen).toHaveLength(Object.keys(EXPECTED_COUNTS).length);
        const copied = await new SessionManager(dst).getMessages(id);
        expect(copied.map((m) => m.content)).toEqual(Array.from({ length: 23 }, (_, i) => `message ${i}`));
    });

    it("copies an empty database without error", async () => {
        const src = await source();
        const dst = await target();
        const report = await copyDatabase(src, dst);
        expect(report.totalRead).toBe(0);
        expect(report.totalInserted).toBe(0);
        // An empty SERIAL table must still hand out id 1 afterwards
        const id = await new SessionManager(dst).create("first");
        await new SessionManager(dst).addMessage(id, { role: "user", content: "x" });
        expect(await new SessionManager(dst).getMessages(id)).toHaveLength(1);
    });
});

describe("copyDatabase guards", () => {
    it("refuses to copy a database onto itself", async () => {
        const db = createTestDb();
        await expect(copyDatabase(db, db)).rejects.toThrow(/same handle/);
    });
});
