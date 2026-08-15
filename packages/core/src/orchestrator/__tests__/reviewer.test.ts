import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import type { Gateway } from "../../gateway/gateway.js";
import type { SubTask, TaskPlan } from "@pantheon/shared";

// ── DB mock setup ─────────────────────────────────────────────────────────────

let _testDb: ReturnType<typeof createTestDb> | null = null;
let _testSqlite: Database.Database | null = null;

vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_testDb) throw new Error("Test DB not initialised — call setupTestDb() in beforeEach");
            return _testDb;
        },
    };
});

function setupTestDb() {
    _testSqlite = new Database(":memory:");
    _testDb = createTestDb(_testSqlite);
}

function seedSession(id: string) {
    _testSqlite!.exec(
        `INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, is_archived)
         VALUES ('${id}', 'Test Session', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 0)`,
    );
}

// Import after mock is registered
const { ReviewerAgent } = await import("../reviewer.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockGateway(responseContent: string): Gateway {
    return {
        complete: vi.fn().mockResolvedValue({
            message: { role: "assistant", content: responseContent },
            usage: { inputTokens: 50, outputTokens: 120 },
        }),
        resolveRouting: vi.fn(),
        stream: vi.fn(),
    } as unknown as Gateway;
}

function makePlan(overrides?: Partial<TaskPlan>): TaskPlan {
    return {
        planId: "plan-1",
        sessionId: "test-session",
        originalPrompt: "Refactor the auth module",
        tasks: [],
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeCompletedTask(overrides?: Partial<SubTask>): SubTask {
    return {
        id: "task-1",
        title: "Implement auth",
        description: "Write the new auth module",
        dependencies: [],
        status: "completed",
        result: "Auth module implemented successfully.",
        ...overrides,
    };
}

// ── ReviewerAgent ─────────────────────────────────────────────────────────────

describe("ReviewerAgent", () => {
    beforeEach(() => {
        setupTestDb();
    });

    it("synthesizes task results and returns a ReviewResult", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Here is the final synthesized response.");

        const agent = new ReviewerAgent({
            gateway,
            reviewerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "orchestrator-id",
        });

        const result = await agent.review(makePlan(), [makeCompletedTask()]);

        expect(result.agentId).toBeTruthy();
        expect(result.approved).toBe(true);
        expect(result.finalResponse).toBe("Here is the final synthesized response.");
        expect(result.feedback).toContain("1 tasks completed successfully");
    });

    it("sets approved=false when any task failed", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Partial result — one task failed.");

        const agent = new ReviewerAgent({
            gateway,
            reviewerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "orchestrator-id",
        });

        const tasks: SubTask[] = [
            makeCompletedTask({ id: "task-1", status: "completed" }),
            makeCompletedTask({ id: "task-2", status: "failed", error: "Build error" }),
        ];

        const result = await agent.review(makePlan(), tasks);

        expect(result.approved).toBe(false);
        expect(result.feedback).toContain("1 failed");
    });

    it("persists an agent_node row with role 'reviewer'", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Synthesis complete.");

        const agent = new ReviewerAgent({
            gateway,
            reviewerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "orchestrator-id",
        });

        const result = await agent.review(makePlan(), [makeCompletedTask()]);

        const row = _testSqlite!.prepare(
            "SELECT role, status FROM agent_nodes WHERE agent_id = ?",
        ).get(result.agentId) as { role: string; status: string } | undefined;

        expect(row?.role).toBe("reviewer");
        expect(row?.status).toBe("completed");
    });

    it("passes the original prompt and task results to the LLM", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Done.");

        const agent = new ReviewerAgent({
            gateway,
            reviewerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "orchestrator-id",
        });

        const plan = makePlan({ originalPrompt: "Refactor the auth module" });
        const task = makeCompletedTask({ title: "Rewrite JWT handler", result: "JWT handler rewritten." });

        await agent.review(plan, [task]);

        const callArgs = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ role: string; content: string }>;
        const userMsg = callArgs.find((m) => m.role === "user");
        expect(userMsg?.content).toContain("Refactor the auth module");
        expect(userMsg?.content).toContain("Rewrite JWT handler");
        expect(userMsg?.content).toContain("JWT handler rewritten.");
    });

    it("rethrows errors and marks agent_node as failed", async () => {
        seedSession("test-session");
        const gateway = {
            complete: vi.fn().mockRejectedValue(new Error("Reviewer LLM error")),
            resolveRouting: vi.fn(),
            stream: vi.fn(),
        } as unknown as Gateway;

        const agent = new ReviewerAgent({
            gateway,
            reviewerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "orchestrator-id",
        });

        await expect(agent.review(makePlan(), [makeCompletedTask()])).rejects.toThrow("Reviewer LLM error");

        const row = _testSqlite!.prepare(
            "SELECT status FROM agent_nodes WHERE role = 'reviewer'",
        ).get() as { status: string } | undefined;

        expect(row?.status).toBe("failed");
    });
});
