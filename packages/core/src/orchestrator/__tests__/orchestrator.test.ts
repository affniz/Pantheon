import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import type { Gateway } from "../../gateway/gateway.js";
import type { SubTask } from "@pantheon/shared";

// ── DB mock setup ─────────────────────────────────────────────────────────────
//
// PlannerAgent calls `getDb()` (the singleton) internally. We intercept it
// here by mocking the entire db/client module so tests use a fresh in-memory
// DB per test instead of the on-disk ~/.pantheon/pantheon.db.
//
// vi.mock is hoisted to the top of the file by Vitest — the factory runs
// before any imports, so we use a module-level variable to hold the
// current test DB and swap it in beforeEach.

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
const { PlannerAgent } = await import("../planner.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockGateway(responseContent: string): Gateway {
    return {
        complete: vi.fn().mockResolvedValue({
            message: { role: "assistant", content: responseContent },
            usage: { inputTokens: 10, outputTokens: 30 },
        }),
        resolveRouting: vi.fn().mockResolvedValue({
            tier: "complex",
            selectedModelId: "deepseek-v4-pro",
            reason: "test",
        }),
        stream: vi.fn(),
    } as unknown as Gateway;
}

// ── PlannerAgent ──────────────────────────────────────────────────────────────

describe("PlannerAgent", () => {
    beforeEach(() => {
        setupTestDb();
    });

    it("decomposes a prompt into a TaskPlan", async () => {
        seedSession("test-session");
        const tasks = [
            { id: "task-1", title: "Research", description: "Research the topic", dependencies: [] },
            { id: "task-2", title: "Write", description: "Write the report", dependencies: ["task-1"] },
        ];
        const gateway = makeMockGateway(JSON.stringify(tasks));

        const planner = new PlannerAgent({
            gateway,
            plannerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
        });

        const plan = await planner.plan("Write a research report on AI");

        expect(plan.tasks).toHaveLength(2);
        expect(plan.tasks[0]?.id).toBe("task-1");
        expect(plan.tasks[1]?.dependencies).toContain("task-1");
        expect(plan.sessionId).toBe("test-session");
        expect(plan.planId).toBeTruthy();
    });

    it("falls back to a single task when LLM returns invalid JSON", async () => {
        seedSession("test-session");
        const gateway = makeMockGateway("Sorry, I cannot decompose this.");

        const planner = new PlannerAgent({
            gateway,
            plannerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
        });

        const plan = await planner.plan("Do something complex");

        expect(plan.tasks).toHaveLength(1);
        expect(plan.tasks[0]?.id).toBe("task-1");
        expect(plan.tasks[0]?.title).toBe("Complete the request");
    });

    it("strips markdown fences from JSON response", async () => {
        seedSession("test-session");
        const tasks = [{ id: "task-1", title: "Task", description: "Do it", dependencies: [] }];
        const gateway = makeMockGateway("```json\n" + JSON.stringify(tasks) + "\n```");

        const planner = new PlannerAgent({
            gateway,
            plannerModelId: "deepseek-v4-pro",
            sessionId: "test-session",
        });

        const plan = await planner.plan("Do a task");

        expect(plan.tasks).toHaveLength(1);
    });
});

// ── Topological sort ──────────────────────────────────────────────────────────

describe("topological sort", () => {
    /**
     * Inline replica of the private algorithm from orchestrator.ts.
     * Tests the pure ordering logic without needing a full orchestrator instance.
     */
    function topoSort(tasks: SubTask[]): SubTask[][] {
        const taskMap = new Map<string, SubTask>(tasks.map((t) => [t.id, t]));
        const remaining = new Set<string>(tasks.map((t) => t.id));
        const completed = new Set<string>();
        const waves: SubTask[][] = [];

        while (remaining.size > 0) {
            const wave: SubTask[] = [];
            for (const id of remaining) {
                const task = taskMap.get(id)!;
                if (task.dependencies.every((dep) => completed.has(dep))) {
                    wave.push(task);
                }
            }
            if (wave.length === 0) break;
            waves.push(wave);
            for (const task of wave) {
                remaining.delete(task.id);
                completed.add(task.id);
            }
        }
        return waves;
    }

    it("produces waves respecting dependencies", () => {
        const tasks: SubTask[] = [
            { id: "a", title: "A", description: "A", dependencies: [], status: "pending" },
            { id: "b", title: "B", description: "B", dependencies: ["a"], status: "pending" },
            { id: "c", title: "C", description: "C", dependencies: ["a"], status: "pending" },
            { id: "d", title: "D", description: "D", dependencies: ["b", "c"], status: "pending" },
        ];

        const waves = topoSort(tasks);

        expect(waves).toHaveLength(3);
        expect(waves[0]?.map((t) => t.id)).toEqual(["a"]);
        expect(waves[1]?.map((t) => t.id)).toEqual(expect.arrayContaining(["b", "c"]));
        expect(waves[2]?.map((t) => t.id)).toEqual(["d"]);
    });

    it("handles tasks with no dependencies (all in first wave)", () => {
        const tasks: SubTask[] = [
            { id: "x", title: "X", description: "X", dependencies: [], status: "pending" },
            { id: "y", title: "Y", description: "Y", dependencies: [], status: "pending" },
        ];

        const waves = topoSort(tasks);
        expect(waves).toHaveLength(1);
        expect(waves[0]?.map((t) => t.id)).toEqual(expect.arrayContaining(["x", "y"]));
    });
});
