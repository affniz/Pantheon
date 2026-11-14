import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { TaskPlan } from "@pantheon/shared";
import { BACKENDS, useBackend } from "../../db/__tests__/backends.js";
import { SessionManager } from "../../session/session-manager.js";
import { OrchestrationStore } from "../store.js";

describe.each(BACKENDS)("OrchestrationStore [$name]", (backend) => {
    const getDb = useBackend(backend);
    let store: OrchestrationStore;
    let sessionId: string;

    beforeEach(async () => {
        store = new OrchestrationStore(getDb());
        sessionId = await new SessionManager(getDb()).create("orchestrated");
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function makePlan(planId: string, createdAt = new Date().toISOString()): TaskPlan {
        return {
            planId,
            sessionId,
            originalPrompt: "build the thing",
            createdAt,
            tasks: [
                { id: `${planId}_a`, title: "A", description: "first", dependencies: [], status: "pending", taskRole: "code" },
                { id: `${planId}_b`, title: "B", description: "second", dependencies: [`${planId}_a`], status: "pending" },
            ],
        };
    }

    describe("agents", () => {
        it("startAgent records a running agent with epoch-ms start time", async () => {
            const before = Date.now();
            await store.startAgent({ agentId: "a1", role: "planner", modelId: "m", sessionId });
            const agent = await store.getAgent("a1");
            expect(agent).toMatchObject({
                agentId: "a1", role: "planner", modelId: "m", sessionId,
                status: "running", parentAgentId: null, taskId: null, result: null, error: null, endTime: null,
            });
            expect(agent!.startTime).toBeGreaterThanOrEqual(before);
            expect(agent!.startTime).toBeGreaterThan(2 ** 31); // must not be truncated to int4
        });

        it("completeAgent stores the result and an end time", async () => {
            await store.startAgent({ agentId: "a1", role: "coder", modelId: "m", sessionId });
            await store.completeAgent("a1", "all done");
            const agent = await store.getAgent("a1");
            expect(agent).toMatchObject({ status: "completed", result: "all done" });
            expect(agent!.endTime).toBeGreaterThanOrEqual(agent!.startTime);
        });

        it("completeAgent without a result leaves result null", async () => {
            await store.startAgent({ agentId: "a1", role: "planner", modelId: "m", sessionId });
            await store.completeAgent("a1");
            expect(await store.getAgent("a1")).toMatchObject({ status: "completed", result: null });
        });

        it("failAgent stores the error message (Error or plain value)", async () => {
            await store.startAgent({ agentId: "a1", role: "coder", modelId: "m", sessionId });
            await store.startAgent({ agentId: "a2", role: "coder", modelId: "m", sessionId });
            await store.failAgent("a1", new Error("LLM exploded"));
            await store.failAgent("a2", "plain string");
            expect(await store.getAgent("a1")).toMatchObject({ status: "failed", error: "LLM exploded" });
            expect(await store.getAgent("a2")).toMatchObject({ status: "failed", error: "plain string" });
        });

        it("getAgent returns undefined for an unknown id", async () => {
            expect(await store.getAgent("nope")).toBeUndefined();
        });

        it("startAgent rejects an unknown session (foreign key)", async () => {
            await expect(
                store.startAgent({ agentId: "a1", role: "planner", modelId: "m", sessionId: "missing-session" }),
            ).rejects.toThrow();
        });

        it("listAgents is newest-first, filterable by session and limited", async () => {
            const otherSession = await new SessionManager(getDb()).create("other");
            vi.useFakeTimers();
            vi.setSystemTime(1_800_000_000_000);
            await store.startAgent({ agentId: "old", role: "planner", modelId: "m", sessionId });
            vi.setSystemTime(1_800_000_001_000);
            await store.startAgent({ agentId: "mid", role: "coder", modelId: "m", sessionId: otherSession });
            vi.setSystemTime(1_800_000_002_000);
            await store.startAgent({ agentId: "new", role: "reviewer", modelId: "m", sessionId });
            vi.useRealTimers();

            expect((await store.listAgents()).map((a) => a.agentId)).toEqual(["new", "mid", "old"]);
            expect((await store.listAgents({ sessionId })).map((a) => a.agentId)).toEqual(["new", "old"]);
            expect((await store.listAgents({ limit: 1 })).map((a) => a.agentId)).toEqual(["new"]);
            expect(await store.listAgents({ sessionId: "missing" })).toEqual([]);
        });

        it("getAgentTree returns only the agents of that run, not earlier runs in the session", async () => {
            await store.startAgent({ agentId: "run1", role: "orchestrator", modelId: "m", sessionId });
            await store.startAgent({ agentId: "run1-coder", role: "coder", modelId: "m", sessionId, parentAgentId: "run1", taskId: "t1" });
            await store.startAgent({ agentId: "run2", role: "orchestrator", modelId: "m", sessionId });
            await store.startAgent({ agentId: "run2-planner", role: "planner", modelId: "m", sessionId, parentAgentId: "run2" });
            await store.startAgent({ agentId: "run2-reviewer", role: "reviewer", modelId: "m", sessionId, parentAgentId: "run2" });
            await store.completeAgent("run2-planner");

            const tree = await store.getAgentTree("run2");
            expect(tree.map((a) => a.agentId).sort()).toEqual(["run2", "run2-planner", "run2-reviewer"]);
            expect(tree[0]).toMatchObject({ agentId: "run2", role: "orchestrator" });
            // Optional fields are omitted, not null
            expect(tree[0]).not.toHaveProperty("parentAgentId");
            expect(tree.find((a) => a.agentId === "run2-planner")).toMatchObject({ parentAgentId: "run2", status: "completed" });

            const first = await store.getAgentTree("run1");
            expect(first.find((a) => a.agentId === "run1-coder")).toMatchObject({ taskId: "t1" });
            expect(await store.getAgentTree("unknown")).toEqual([]);
        });
    });

    describe("plans and sub-tasks", () => {
        it("savePlan persists the plan and its sub-tasks with decoded dependencies", async () => {
            await store.savePlan(makePlan("p1"));
            const tasks = await store.getSubTasks("p1");
            expect(tasks).toHaveLength(2);
            expect(tasks[0]).toMatchObject({ id: "p1_a", planId: "p1", title: "A", taskRole: "code", status: "pending", dependencies: [] });
            // taskRole defaults to "general" when the planner omitted it
            expect(tasks[1]).toMatchObject({ id: "p1_b", taskRole: "general", dependencies: ["p1_a"] });
        });

        it("savePlan accepts a plan with no tasks", async () => {
            await store.savePlan({ ...makePlan("p1"), tasks: [] });
            expect(await store.getSubTasks("p1")).toEqual([]);
        });

        it("updateSubTask writes only the provided fields", async () => {
            await store.savePlan(makePlan("p1"));
            await store.updateSubTask("p1_a", { status: "running", agentId: "agent-1" });
            expect((await store.getSubTasks("p1"))[0]).toMatchObject({ status: "running", agentId: "agent-1", result: null });

            await store.updateSubTask("p1_a", { status: "completed", result: "shipped" });
            // agentId set earlier must survive the second update
            expect((await store.getSubTasks("p1"))[0]).toMatchObject({ status: "completed", agentId: "agent-1", result: "shipped" });
        });

        it("failSubTask records the failure", async () => {
            await store.savePlan(makePlan("p1"));
            await store.failSubTask("p1_b", new Error("nope"));
            expect((await store.getSubTasks("p1"))[1]).toMatchObject({ status: "failed", error: "nope" });
        });

        it("tolerates a corrupt dependencies blob", async () => {
            await store.savePlan(makePlan("p1"));
            const { subTasks } = (await import("../../db/client.js")).tablesFor(getDb());
            const { eq } = await import("drizzle-orm");
            await getDb().update(subTasks).set({ dependencies: "{not json" }).where(eq(subTasks.id, "p1_a"));
            expect((await store.getSubTasks("p1"))[0]!.dependencies).toEqual([]);
        });

        it("getPlanForAgent picks the plan that was current when the agent started", async () => {
            await store.savePlan(makePlan("first", "2026-01-01T00:00:00.000Z"));
            await store.savePlan(makePlan("second", "2026-06-01T00:00:00.000Z"));

            const duringFirst = { sessionId, startTime: Date.parse("2026-03-01T00:00:00.000Z") };
            const duringSecond = { sessionId, startTime: Date.parse("2026-07-01T00:00:00.000Z") };
            expect((await store.getPlanForAgent(duringFirst))?.planId).toBe("first");
            expect((await store.getPlanForAgent(duringSecond))?.planId).toBe("second");
        });

        it("getPlanForAgent matches a plan created within a second after the agent started", async () => {
            // The orchestrator row is inserted just before the planner writes the plan
            await store.savePlan(makePlan("p1", "2026-01-01T00:00:00.500Z"));
            const agent = { sessionId, startTime: Date.parse("2026-01-01T00:00:00.000Z") };
            expect((await store.getPlanForAgent(agent))?.planId).toBe("p1");
        });

        it("getPlanForAgent falls back to the newest plan, and to undefined when there is none", async () => {
            expect(await store.getPlanForAgent({ sessionId, startTime: Date.now() })).toBeUndefined();
            await store.savePlan(makePlan("later", "2030-01-01T00:00:00.000Z"));
            expect((await store.getPlanForAgent({ sessionId, startTime: 0 }))?.planId).toBe("later");
        });
    });

    it("deleting the session cascades to agents, plans and sub-tasks", async () => {
        await store.startAgent({ agentId: "a1", role: "orchestrator", modelId: "m", sessionId });
        await store.savePlan(makePlan("p1"));

        await new SessionManager(getDb()).delete(sessionId);

        expect(await store.getAgent("a1")).toBeUndefined();
        expect(await store.getSubTasks("p1")).toEqual([]);
        expect(await store.listAgents()).toEqual([]);
    });
});

describe("OrchestrationStore — error-path helpers never throw", () => {
    it("failAgent / failSubTask swallow database errors so the original failure propagates", async () => {
        const broken = new Proxy({}, {
            get() {
                throw new Error("database is gone");
            },
        });
        const store = new OrchestrationStore(broken as never);
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            await expect(store.failAgent("a1", new Error("original"))).resolves.toBeUndefined();
            await expect(store.failSubTask("t1", new Error("original"))).resolves.toBeUndefined();
            expect(stderr).toHaveBeenCalled();
        } finally {
            stderr.mockRestore();
        }
    });
});
