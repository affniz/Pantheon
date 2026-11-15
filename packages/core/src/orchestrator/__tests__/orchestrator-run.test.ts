import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMessage, OrchestrationEvent, ToolCall } from "@pantheon/shared";
import { createTestDb, rawExecutor, type PantheonDatabase } from "../../db/client.js";
import type { Gateway } from "../../gateway/gateway.js";
import type { ExecRequest, ExecResult } from "../../sandbox/executor.js";

let _testDb: PantheonDatabase | null = null;
vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_testDb) throw new Error("test database not set up");
            return _testDb;
        },
    };
});

const { Orchestrator } = await import("../orchestrator.js");
const { Sandbox } = await import("../../sandbox/sandbox.js");
const { PermissionManager } = await import("../../sandbox/permission-manager.js");
const { ToolRegistry } = await import("../../tools/tool-registry.js");
const { SessionManager } = await import("../../session/session-manager.js");
const { OrchestrationStore } = await import("../store.js");

// ── A scripted model ─────────────────────────────────────────────────────────

interface Script {
    /** Sub-tasks the planner returns. */
    plan: Array<{ id: string; title: string; description?: string; dependencies?: string[]; taskRole?: string }>;
    /** Per task title: tool calls to make (one per turn) before answering, or an error to throw. */
    tasks?: Record<string, { calls?: ToolCall[]; answer?: string; error?: string }>;
    review?: string;
}

function scriptedGateway(script: Script) {
    const seen: Array<{ kind: string; title?: string; messages: ChatMessage[]; tools: string[] }> = [];
    const progress = new Map<string, number>();

    const complete = vi.fn(async (messages: ChatMessage[], _model: string, tools?: Array<{ function: { name: string } }>, options?: { onToken?: (d: string) => void }) => {
        const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        const usage = { inputTokens: 1, outputTokens: 1 };
        const toolNames = (tools ?? []).map((t) => t.function.name);

        if (system.startsWith("You are a Planner agent")) {
            seen.push({ kind: "planner", messages, tools: toolNames });
            const tasks = script.plan.map((t) => ({ description: `${t.title} description`, dependencies: [], taskRole: "code", ...t }));
            return { message: { role: "assistant" as const, content: JSON.stringify(tasks) }, usage };
        }
        if (system.startsWith("You are a reviewer agent")) {
            seen.push({ kind: "reviewer", messages, tools: toolNames });
            const content = script.review ?? "Final synthesized answer.";
            options?.onToken?.(content);
            return { message: { role: "assistant" as const, content }, usage };
        }

        const title = /^Title: (.*)$/m.exec(system)?.[1] ?? "?";
        const spec = script.tasks?.[title] ?? (title.startsWith("Fix verification failures") ? script.tasks?.["__fix__"] : undefined) ?? {};
        const step = progress.get(title) ?? 0;
        if (step === 0) seen.push({ kind: "specialist", title, messages, tools: toolNames });
        progress.set(title, step + 1);

        if (spec.error) throw new Error(spec.error);
        const call = spec.calls?.[step];
        if (call) return { message: { role: "assistant" as const, content: "", toolCalls: [call] }, usage };
        return { message: { role: "assistant" as const, content: spec.answer ?? `${title} done` }, usage };
    });

    const gateway = {
        complete,
        resolveRouting: vi.fn(async () => ({ tier: "complex", selectedModelId: "big-model", reason: "test" })),
        getRoutingConfig: () => ({ enabled: true, tiers: { general: "small", simple: "small", standard: "small", complex: "big-model" } }),
        stream: vi.fn(),
    } as unknown as Gateway;
    return { gateway, seen };
}

/** Verification outcomes, in the order the checks run: baseline first, then after the tasks, then after each fix. */
function scriptedExecutor(outcomes: Array<"pass" | "fail">) {
    const run = vi.fn(async (_req: ExecRequest): Promise<ExecResult> => {
        const outcome = outcomes[Math.min(run.mock.calls.length - 1, outcomes.length - 1)] ?? "pass";
        return outcome === "pass"
            ? { stdout: "", stderr: "", exitCode: 0, timedOut: false }
            : { stdout: "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", stderr: "", exitCode: 2, timedOut: false };
    });
    return { executor: { kind: "host" as const, run, describe: () => "scripted" }, run };
}

const write = (id: string, file: string, content = "export const x = 1;\n"): ToolCall =>
    ({ id, name: "write_file", arguments: { path: file, content } });

describe("Orchestrator.run", () => {
    let dir: string;
    let sessionId: string;
    let events: OrchestrationEvent[];

    beforeEach(async () => {
        _testDb = createTestDb();
        sessionId = await new SessionManager(_testDb).create("orchestrated");
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-run-")));
        fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}"); // so verification has something to check
        events = [];
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function build(script: Script, outcomes: Array<"pass" | "fail">, extra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
        const { gateway, seen } = scriptedGateway(script);
        const { executor, run } = scriptedExecutor(outcomes);
        const sandbox = new Sandbox({
            projectRoot: dir,
            maxOutputSize: 50_000,
            shellTimeout: 5_000,
            allowlist: { enabled: true, entries: [] },
            executor,
        });
        const orchestrator = new Orchestrator({
            gateway,
            toolRegistry: new ToolRegistry(),
            sandbox,
            permissionManager: new PermissionManager(async () => "always_allow"),
            sessionId,
            plannerModelId: "big-model",
            agentModelId: "big-model",
            reviewerModelId: "big-model",
            onEvent: (e) => events.push(e),
            ...extra,
        });
        return { orchestrator, seen, verificationRuns: run, gateway };
    }

    const types = () => events.map((e) => e.type);
    const verifications = () => events.filter((e): e is Extract<OrchestrationEvent, { type: "verification" }> => e.type === "verification");
    const subTasks = () => rawExecutor(_testDb!).all<{ id: string; title: string; status: string; task_role: string }>(
        "SELECT id, title, status, task_role FROM sub_tasks ORDER BY created_at, id",
    );

    it("plans, runs the sub-tasks, verifies, reviews — and reports each stage", async () => {
        const { orchestrator, seen } = build(
            { plan: [{ id: "t1", title: "Write module" }, { id: "t2", title: "Write tests" }], review: "Both parts are done." },
            ["pass"],
        );
        const result = await orchestrator.run("add a module with tests", [{ role: "user", content: "add a module with tests" }]);

        expect(result.finalResponse).toBe("Both parts are done.");
        expect(result.reviewApproved).toBe(true);
        expect(result.fixRounds).toBe(0);
        expect(result.verification.passed).toBe(true);
        expect(result.plan.tasks).toHaveLength(2);

        expect(types()).toEqual([
            "plan_created", "orchestration_start",
            "agent_spawned", "agent_spawned", "agent_completed", "agent_completed",
            "verification", "review_result", "orchestration_done",
        ]);
        expect(verifications()).toEqual([{ type: "verification", round: 0, passed: true, summary: expect.stringContaining("TypeScript compilation: PASSED") }]);

        // Planner once, each specialist, reviewer once
        expect(seen.map((s) => s.kind)).toEqual(["planner", "specialist", "specialist", "reviewer"]);
        // The run's agent tree: orchestrator + planner + 2 coders + reviewer
        expect(result.agentTree.map((a) => a.role).sort()).toEqual(["coder", "coder", "orchestrator", "planner", "reviewer"]);
        expect(result.agentTree.every((a) => a.status === "completed" || a.role === "orchestrator")).toBe(true);
        expect((await subTasks()).map((t) => t.status)).toEqual(["completed", "completed"]);
    });

    it("fixes what the run broke: verification fails → debugger agent → verification passes", async () => {
        const { orchestrator, seen, verificationRuns } = build(
            {
                plan: [{ id: "t1", title: "Change types" }],
                tasks: {
                    "Change types": { calls: [write("c1", "src/app.ts")], answer: "types changed" },
                    __fix__: { calls: [write("c2", "src/app.ts", "export const x: number = 1;\n")], answer: "fixed the type error" },
                },
            },
            ["pass", "fail", "pass"], // baseline, after the task, after the fix
        );
        const result = await orchestrator.run("change the types", []);

        expect(result.fixRounds).toBe(1);
        expect(result.verification.passed).toBe(true);
        expect(result.reviewApproved).toBe(true);
        expect(verificationRuns).toHaveBeenCalledTimes(3);
        expect(verifications().map((v) => [v.round, v.passed])).toEqual([[0, false], [1, true]]);

        // The fix agent is a debugger, was told exactly what failed and which files changed
        const fix = seen.find((s) => s.title?.startsWith("Fix verification failures"))!;
        const fixPrompt = fix.messages.find((m) => m.role === "system")!.content;
        expect(fixPrompt).toContain("You are a Debugger agent");
        expect(fixPrompt).toContain("error TS2322");
        expect(fixPrompt).toContain(path.join(dir, "src/app.ts"));
        expect(fixPrompt).toContain("Do not weaken, skip or delete tests");

        // …it really changed the file, and is recorded as part of the plan
        expect(fs.readFileSync(path.join(dir, "src/app.ts"), "utf-8")).toBe("export const x: number = 1;\n");
        const tasks = await subTasks();
        expect(tasks.map((t) => [t.title, t.status, t.task_role])).toEqual([
            ["Change types", "completed", "code"],
            ["Fix verification failures (round 1)", "completed", "debug"],
        ]);
        expect(result.agentTree.map((a) => a.role)).toContain("debugger");

        // The reviewer hears that a fix was needed
        const reviewInput = seen.find((s) => s.kind === "reviewer")!.messages.at(-1)!.content;
        expect(reviewInput).toContain("Verification passed after 1 automatic fix round(s)");
    });

    it("gives up after maxFixRounds and reports the failure honestly", async () => {
        const { orchestrator, seen, verificationRuns } = build(
            {
                plan: [{ id: "t1", title: "Break it" }],
                tasks: { "Break it": { calls: [write("c1", "a.ts")] }, __fix__: { answer: "I could not find the cause" } },
            },
            ["pass", "fail"], // fails forever after the baseline
            { maxFixRounds: 2 },
        );
        const result = await orchestrator.run("break it", []);

        expect(result.fixRounds).toBe(2);
        expect(result.verification.passed).toBe(false);
        expect(result.reviewApproved).toBe(false);
        expect(result.reviewFeedback).toContain("verification failed");
        expect(verificationRuns).toHaveBeenCalledTimes(4); // baseline + 3 checks
        expect(verifications().map((v) => v.round)).toEqual([0, 1, 2]);
        expect(seen.find((s) => s.kind === "reviewer")!.messages.at(-1)!.content)
            .toContain("2 automatic fix round(s) were attempted without resolving the failures");
    });

    it("does not try to fix failures that were already there before the run", async () => {
        const { orchestrator, seen } = build(
            { plan: [{ id: "t1", title: "Small change" }], tasks: { "Small change": { calls: [write("c1", "a.ts")] } } },
            ["fail"], // baseline already red
        );
        const result = await orchestrator.run("small change", []);

        expect(result.fixRounds).toBe(0);
        expect(seen.some((s) => s.title?.startsWith("Fix verification"))).toBe(false);
        expect(verifications()[0]).toMatchObject({ passed: false, baselineFailing: true });
        // Pre-existing failures are reported but not held against this run
        expect(result.reviewApproved).toBe(true);
        expect(seen.find((s) => s.kind === "reviewer")!.messages.at(-1)!.content)
            .toContain("already failing before this request was started");
    });

    it("does not start a fix when the run changed no files", async () => {
        const { orchestrator, seen } = build(
            { plan: [{ id: "t1", title: "Research only", taskRole: "general" }] },
            ["pass", "fail"], // flaky project: passes at baseline, fails later, but nothing was written
        );
        const result = await orchestrator.run("look into it", []);
        expect(result.fixRounds).toBe(0);
        expect(seen.some((s) => s.title?.startsWith("Fix verification"))).toBe(false);
        expect(result.reviewApproved).toBe(false);
    });

    it("maxFixRounds: 0 skips the baseline run and never fixes", async () => {
        const { orchestrator, verificationRuns } = build(
            { plan: [{ id: "t1", title: "Break it" }], tasks: { "Break it": { calls: [write("c1", "a.ts")] } } },
            ["fail"],
            { maxFixRounds: 0 },
        );
        const result = await orchestrator.run("x", []);
        expect(verificationRuns).toHaveBeenCalledTimes(1);
        expect(result.fixRounds).toBe(0);
        expect(result.reviewApproved).toBe(false);
    });

    it("a fix agent that crashes does not abort the run", async () => {
        const { orchestrator } = build(
            {
                plan: [{ id: "t1", title: "Break it" }],
                tasks: { "Break it": { calls: [write("c1", "a.ts")] }, __fix__: { error: "model overloaded" } },
            },
            ["pass", "fail"],
            { maxFixRounds: 1 },
        );
        const result = await orchestrator.run("x", []);
        expect(result.finalResponse).toBe("Final synthesized answer.");
        expect(result.fixRounds).toBe(1);
        expect(events.some((e) => e.type === "agent_failed" && e.error === "model overloaded")).toBe(true);
        expect((await subTasks()).at(-1)).toMatchObject({ title: "Fix verification failures (round 1)", status: "failed" });
    });

    it("runs dependent tasks after their dependencies and cancels them when a dependency fails", async () => {
        const order: string[] = [];
        const { orchestrator, gateway } = build(
            {
                plan: [
                    { id: "a", title: "First" },
                    { id: "b", title: "Second", dependencies: ["a"] },
                    { id: "c", title: "Doomed" },
                    { id: "d", title: "Needs doomed", dependencies: ["c"] },
                ],
                tasks: { Doomed: { error: "kaboom" } },
            },
            ["pass"],
            { maxSubTasks: 6 },
        );
        const original = vi.mocked(gateway.complete).getMockImplementation()!;
        vi.mocked(gateway.complete).mockImplementation(async (...args) => {
            const title = /^Title: (.*)$/m.exec(args[0].filter((m) => m.role === "system").map((m) => m.content).join("\n"))?.[1];
            if (title) order.push(title);
            return original(...args);
        });

        const result = await orchestrator.run("multi", []);

        expect(order.indexOf("First")).toBeLessThan(order.indexOf("Second"));
        expect(order).not.toContain("Needs doomed");
        expect(result.reviewApproved).toBe(false);
        expect(events.some((e) => e.type === "agent_failed" && /dependency/.test(e.error))).toBe(true);
        const statuses = Object.fromEntries((await subTasks()).map((t) => [t.title, t.status]));
        expect(statuses).toMatchObject({ First: "completed", Second: "completed", Doomed: "failed" });
    });

    it("gives sub-agents the session's tools, the repo map and memory — and the planner its context", async () => {
        const registry = new ToolRegistry();
        registry.register({
            definition: { name: "jira.create_issue", description: "plugin tool", parameters: { type: "object", properties: {}, required: [] }, safety: "safe" },
            execute: async () => "ok",
        });
        const { orchestrator, seen } = build(
            { plan: [{ id: "t1", title: "Use plugin" }] },
            ["pass"],
            { toolRegistry: registry, repoMap: "src/app.ts: fn main()", episodicMemory: "## Past sessions\n- we use tabs" },
        );
        await orchestrator.run("x", []);

        const specialist = seen.find((s) => s.kind === "specialist")!;
        expect(specialist.tools).toEqual(["jira.create_issue"]);
        const prompt = specialist.messages.find((m) => m.role === "system")!.content;
        expect(prompt).toContain("## Codebase Map\nsrc/app.ts: fn main()");
        expect(prompt).toContain("we use tabs");
        expect(prompt).toContain("Other agents are working on other sub-tasks");

        const plannerContext = seen.find((s) => s.kind === "planner")!.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        expect(plannerContext).toContain("src/app.ts: fn main()");
        expect(plannerContext).toContain("we use tabs");
    });

    it("falls back to the built-in tools when the session registry is empty", async () => {
        const { orchestrator, seen } = build({ plan: [{ id: "t1", title: "Plain" }] }, ["pass"]);
        await orchestrator.run("x", []);
        expect(seen.find((s) => s.kind === "specialist")!.tools).toEqual(
            expect.arrayContaining(["read_file", "write_file", "edit_file", "shell", "grep"]),
        );
    });

    it("streams the reviewer's answer through onText and says so", async () => {
        const chunks: string[] = [];
        const { orchestrator } = build({ plan: [{ id: "t1", title: "T" }], review: "streamed answer" }, ["pass"], { onText: (d) => chunks.push(d) });
        const result = await orchestrator.run("x", []);
        expect(chunks.join("")).toBe("streamed answer");
        expect(result.streamed).toBe(true);

        const quiet = build({ plan: [{ id: "t1", title: "T" }] }, ["pass"]);
        expect((await quiet.orchestrator.run("x", [])).streamed).toBe(false);
    });

    it("stops parallel agents from overwriting each other's files", async () => {
        const toolOutputs: string[] = [];
        const { orchestrator } = build(
            {
                plan: [{ id: "t1", title: "Agent one" }, { id: "t2", title: "Agent two" }],
                tasks: {
                    "Agent one": { calls: [write("c1", "shared.ts", "// from one\n")], answer: "one done" },
                    "Agent two": { calls: [write("c2", "shared.ts", "// from two\n")], answer: "two done" },
                },
            },
            ["pass"],
            { onToolResult: (r) => toolOutputs.push(r.content) },
        );
        await orchestrator.run("both write shared.ts", []);

        // One write went through; the other was refused with guidance instead of
        // silently replacing the first agent's work.
        expect(toolOutputs.filter((o) => o.startsWith("Successfully wrote"))).toHaveLength(1);
        const refused = toolOutputs.find((o) => o.startsWith("Error"))!;
        expect(refused).toContain("already written by another agent working in parallel");
        expect(refused).toContain("edit_file");
        expect(["// from one\n", "// from two\n"]).toContain(fs.readFileSync(path.join(dir, "shared.ts"), "utf-8"));
    });

    it("lets a later wave rewrite files an earlier wave created", async () => {
        const { orchestrator } = build(
            {
                plan: [{ id: "a", title: "Create" }, { id: "b", title: "Rewrite", dependencies: ["a"] }],
                tasks: {
                    Create: { calls: [write("c1", "mod.ts", "v1\n")] },
                    Rewrite: { calls: [write("c2", "mod.ts", "v2\n")] },
                },
            },
            ["pass"],
        );
        await orchestrator.run("x", []);
        expect(fs.readFileSync(path.join(dir, "mod.ts"), "utf-8")).toBe("v2\n");
    });

    it("marks the orchestrator failed and rethrows when planning itself fails", async () => {
        const { orchestrator, gateway } = build({ plan: [] }, ["pass"]);
        vi.mocked(gateway.complete).mockRejectedValue(new Error("planner model down"));
        await expect(orchestrator.run("x", [])).rejects.toThrow("planner model down");
        const [root] = (await new OrchestrationStore(_testDb!).listAgents({ sessionId })).filter((a) => a.role === "orchestrator");
        expect(root).toMatchObject({ status: "failed", error: "planner model down" });
    });
});
