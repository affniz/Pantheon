import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import type { Gateway } from "../../gateway/gateway.js";
import type { SubTask } from "@pantheon/shared";

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
const { CoderAgent } = await import("../coder.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSubTask(overrides?: Partial<SubTask>): SubTask {
    return {
        id: "task-1",
        title: "Implement the feature",
        description: "Write the new API endpoint",
        dependencies: [],
        status: "pending",
        taskRole: "code",
        ...overrides,
    };
}

function makeMockGateway(responseContent: string): Gateway {
    return {
        complete: vi.fn().mockResolvedValue({
            message: { role: "assistant", content: responseContent },
            usage: { inputTokens: 20, outputTokens: 80 },
        }),
        resolveRouting: vi.fn().mockResolvedValue({
            tier: "complex",
            selectedModelId: "deepseek-v4-pro",
            reason: "test",
        }),
        stream: vi.fn().mockImplementation(async function* () {
            yield { delta: responseContent, inputTokens: 20, outputTokens: 80 };
        }),
    } as unknown as Gateway;
}

function makeMockSandbox() {
    return {
        resolvePath: vi.fn((p: string) => p),
        isAllowed: vi.fn().mockReturnValue(true),
    } as any;
}

function makeMockPermissionManager() {
    return {
        check: vi.fn().mockResolvedValue("allow"),
        classify: vi.fn().mockReturnValue("safe"),
    } as any;
}

// ── CoderAgent ────────────────────────────────────────────────────────────────

describe("CoderAgent", () => {
    beforeEach(() => {
        setupTestDb();
    });

    it("executes a coding task and returns a CoderResult", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Here is the implementation: ...");

        const agent = new CoderAgent({
            gateway,
            coderModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "parent-agent-id",
            sandbox: makeMockSandbox(),
            permissionManager: makeMockPermissionManager(),
        });

        const result = await agent.execute(makeSubTask(), []);

        expect(result.taskId).toBe("task-1");
        expect(result.agentId).toBeTruthy();
        expect(result.result).toBe("Here is the implementation: ...");
        expect(result.iterations).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(result.toolCalls)).toBe(true);
    });

    it("persists an agent_node row with role 'coder'", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Done.");

        const agent = new CoderAgent({
            gateway,
            coderModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "parent-agent-id",
            sandbox: makeMockSandbox(),
            permissionManager: makeMockPermissionManager(),
        });

        const result = await agent.execute(makeSubTask(), []);

        const row = _testSqlite!.prepare(
            "SELECT role, status, model_id FROM agent_nodes WHERE agent_id = ?",
        ).get(result.agentId) as { role: string; status: string; model_id: string } | undefined;

        expect(row).toBeDefined();
        expect(row?.role).toBe("coder");
        expect(row?.status).toBe("completed");
        expect(row?.model_id).toBe("deepseek-v4-pro");
    });

    it("marks the sub_task row as completed", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Done.");

        // Pre-insert the sub_task row so the UPDATE has a target
        _testSqlite!.exec(`
            INSERT INTO task_plans (plan_id, session_id, original_prompt, created_at)
            VALUES ('plan-1', 'test-session', 'test prompt', '2024-01-01T00:00:00.000Z');
            INSERT INTO sub_tasks (id, plan_id, title, description, dependencies, status, created_at)
            VALUES ('task-1', 'plan-1', 'Implement', 'Do it', '[]', 'pending', '2024-01-01T00:00:00.000Z');
        `);

        const agent = new CoderAgent({
            gateway,
            coderModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "parent-agent-id",
            sandbox: makeMockSandbox(),
            permissionManager: makeMockPermissionManager(),
        });

        await agent.execute(makeSubTask(), []);

        const row = _testSqlite!.prepare(
            "SELECT status FROM sub_tasks WHERE id = ?",
        ).get("task-1") as { status: string } | undefined;

        expect(row?.status).toBe("completed");
    });

    it("rethrows errors and marks agent_node as failed", async () => {
        seedSession("test-session");
        const gateway = {
            complete: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
            resolveRouting: vi.fn().mockResolvedValue({
                tier: "complex",
                selectedModelId: "deepseek-v4-pro",
                reason: "test",
            }),
            // eslint-disable-next-line require-yield
            stream: vi.fn().mockImplementation(async function* () {
                throw new Error("LLM unavailable");
            }),
        } as unknown as Gateway;

        const agent = new CoderAgent({
            gateway,
            coderModelId: "deepseek-v4-pro",
            sessionId: "test-session",
            parentAgentId: "parent-agent-id",
            sandbox: makeMockSandbox(),
            permissionManager: makeMockPermissionManager(),
        });

        await expect(agent.execute(makeSubTask(), [])).rejects.toThrow("LLM unavailable");

        const row = _testSqlite!.prepare(
            "SELECT status FROM agent_nodes WHERE role = 'coder'",
        ).get() as { status: string } | undefined;

        expect(row?.status).toBe("failed");
    });
});
