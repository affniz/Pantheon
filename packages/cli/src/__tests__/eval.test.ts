import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    compareReports, evaluateCheck, loadTasks, parseTask, runEval, runTask,
    type EvalClient, type EvalReport, type EvalTask,
} from "../eval/eval.js";

type Evt = { event: string; data: Record<string, unknown> };

/** A stand-in server: plays back scripted events and applies their side effects to the project. */
function fakeClient(script: (workingDir: string, prompt: string) => Evt[] | Promise<Evt[]>, opts: { delayMs?: number } = {}) {
    const answered: Array<[string, string]> = [];
    const requests: Array<Record<string, unknown>> = [];
    const client: EvalClient = {
        async *chat(request) {
            requests.push(request);
            for (const evt of await script(request.workingDir, request.prompt)) {
                if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
                yield evt;
            }
        },
        async respondToToolPermission(id, decision) {
            answered.push([id, decision]);
        },
        async getCostSummary() {
            return { summary: { totalInputTokens: 1200, totalOutputTokens: 300, totalCostUsd: 0.002 } };
        },
    };
    return { client, answered, requests };
}

const done: Evt = { event: "done", data: { sessionId: "sess-1", iterations: 2 } };
const kept: string[] = [];
afterEach(() => {
    for (const dir of kept.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseTask", () => {
    it("parses a task and names it after its file when no name is given", () => {
        const task = parseTask("prompt: do it\nchecks:\n  - file_exists: a.txt\n", "/evals/07-thing.yml");
        expect(task).toMatchObject({ name: "07-thing", prompt: "do it", checks: [{ file_exists: "a.txt" }] });
    });

    it.each([
        ["checks:\n  - file_exists: a\n", /`prompt` is required/],
        ["prompt: x\n", /`checks` must list/],
        ["prompt: x\nchecks: []\n", /`checks` must list/],
        ["prompt: x\nchecks:\n  - file_exits: a\n", /unknown check/],
        ["prompt: x\nchecks:\n  - { file_exists: a, command: b }\n", /unknown check/],
        ["prompt: x\nfiles: { '../evil': x }\nchecks:\n  - file_exists: a\n", /must stay inside the project/],
        ["prompt: x\nfiles: { '/etc/evil': x }\nchecks:\n  - file_exists: a\n", /must stay inside the project/],
        ["- just a list\n", /`prompt` is required/],
    ])("rejects %j", (source, reason) => {
        expect(() => parseTask(source, "bad.yml")).toThrowError(reason);
        expect(() => parseTask(source, "bad.yml")).toThrowError(/^bad\.yml: /);
    });
});

describe("the bundled tasks", () => {
    it("all load and are well-formed", () => {
        const tasks = loadTasks(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../evals"));
        expect(tasks.length).toBeGreaterThanOrEqual(6);
        expect(new Set(tasks.map((t) => t.name)).size).toBe(tasks.length);
        expect(tasks.every((t) => t.prompt.trim().length > 20 && t.checks.length > 0)).toBe(true);
    });
});

describe("evaluateCheck", () => {
    function project(files: Record<string, string>) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-check-"));
        kept.push(dir);
        for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
        return { projectDir: dir, response: "The port is 8472.", toolNames: ["read_file", "edit_file"] };
    }
    const passed = async (check: Parameters<typeof evaluateCheck>[0], seen = project({ "a.txt": "hello world\n" })) =>
        (await evaluateCheck(check, seen)).passed;

    it("file checks", async () => {
        expect(await passed({ file_exists: "a.txt" })).toBe(true);
        expect(await passed({ file_exists: "b.txt" })).toBe(false);
        expect(await passed({ file_absent: "b.txt" })).toBe(true);
        expect(await passed({ file_absent: "a.txt" })).toBe(false);
        expect(await passed({ file_contains: { path: "a.txt", text: "hello" } })).toBe(true);
        expect(await passed({ file_contains: { path: "a.txt", text: "nope" } })).toBe(false);
        expect(await passed({ file_not_contains: { path: "a.txt", text: "nope" } })).toBe(true);
        expect(await passed({ file_equals: { path: "a.txt", text: "hello world" } })).toBe(true);
        expect(await passed({ file_equals: { path: "a.txt", text: "hello" } })).toBe(false);
    });

    it("a missing file fails the check with an explanation instead of throwing", async () => {
        const result = await evaluateCheck({ file_contains: { path: "missing.txt", text: "x" } }, project({}));
        expect(result.passed).toBe(false);
        expect(result.detail).toMatch(/ENOENT/);
    });

    it("refuses check paths outside the project", async () => {
        const result = await evaluateCheck({ file_exists: "../../etc/passwd" }, project({}));
        expect(result).toMatchObject({ passed: false, detail: expect.stringContaining("outside the project") });
    });

    it("command checks run in the project and report the tail of the output on failure", async () => {
        const seen = project({ "a.txt": "x" });
        expect(await passed({ command: "test -f a.txt" }, seen)).toBe(true);
        const failed = await evaluateCheck({ command: "echo boom >&2; exit 1" }, seen);
        expect(failed).toMatchObject({ passed: false, detail: "boom" });
    });

    it("response and tool checks", async () => {
        expect(await passed({ response_contains: "PORT IS 8472" })).toBe(true); // case-insensitive
        expect(await passed({ response_not_contains: "9999" })).toBe(true);
        expect(await passed({ tool_called: "edit_file" })).toBe(true);
        expect(await passed({ tool_called: "shell" })).toBe(false);
        expect(await passed({ tool_not_called: "write_file" })).toBe(true);
        expect(await passed({ max_tool_calls: 2 })).toBe(true);
        expect(await evaluateCheck({ max_tool_calls: 1 }, project({}))).toMatchObject({ passed: false, detail: "2 tool calls" });
    });
});

describe("runTask", () => {
    const task: EvalTask = {
        name: "write-it",
        prompt: "create out.txt",
        files: { "src/seed.txt": "seed" },
        checks: [{ file_exists: "out.txt" }, { file_contains: { path: "src/seed.txt", text: "seed" } }, { tool_called: "write_file" }],
    };

    it("sets up the project, drives the turn, approves prompts, checks the outcome and cleans up", async () => {
        const { client, answered, requests } = fakeClient((dir) => {
            expect(fs.readFileSync(path.join(dir, "src/seed.txt"), "utf-8")).toBe("seed");
            fs.writeFileSync(path.join(dir, "out.txt"), "made");
            return [
                { event: "routing", data: { tier: "simple", selectedModelId: "fast-model" } },
                { event: "tool_call", data: { name: "write_file" } },
                { event: "tool_permission_required", data: { toolCallId: "p1", toolName: "write_file" } },
                { event: "text", data: { content: "Created " } },
                { event: "text", data: { content: "out.txt" } },
                done,
            ];
        });
        const { result, projectDir } = await runTask(client, task);

        expect(result).toMatchObject({
            name: "write-it", passed: true, toolCalls: 1, model: "fast-model", tier: "simple",
            inputTokens: 1200, outputTokens: 300, costUsd: 0.002,
        });
        expect(result.checks.every((c) => c.passed)).toBe(true);
        expect(answered).toEqual([["p1", "always_allow"]]);
        expect(requests[0]).toMatchObject({ prompt: "create out.txt", workingDir: projectDir });
        expect(fs.existsSync(projectDir)).toBe(false); // throw-away
    });

    it("fails when a check fails, naming it", async () => {
        const { client } = fakeClient(() => [done]);
        const { result } = await runTask(client, task);
        expect(result.passed).toBe(false);
        expect(result.checks.map((c) => c.passed)).toEqual([false, true, false]);
    });

    it("a server error fails the task without evaluating checks", async () => {
        const { client } = fakeClient(() => [{ event: "error", data: { message: "model unavailable" } }]);
        const { result } = await runTask(client, task);
        expect(result).toMatchObject({ passed: false, error: "model unavailable" });
        expect(result.checks.every((c) => !c.passed && c.detail?.includes("not evaluated"))).toBe(true);
    });

    it("a thrown transport error is reported, not propagated", async () => {
        const { client } = fakeClient(() => {
            throw new Error("ECONNREFUSED");
        });
        expect((await runTask(client, task)).result).toMatchObject({ passed: false, error: "ECONNREFUSED" });
    });

    it("gives up after the task's timeout", async () => {
        const { client } = fakeClient(() => Array.from({ length: 50 }, () => ({ event: "text", data: { content: "." } })), { delayMs: 40 });
        const { result } = await runTask(client, { ...task, timeoutSeconds: 0.1 });
        expect(result).toMatchObject({ passed: false, error: "timed out after 0.1s" });
    });

    it("passes task options through and can deny permissions or keep the project", async () => {
        const { client, answered, requests } = fakeClient(() => [{ event: "tool_permission_required", data: { toolCallId: "p9" } }, done]);
        const { projectDir } = await runTask(client, { ...task, orchestrate: true, model: "big", checks: [{ file_absent: "out.txt" }] }, { approve: "deny", keep: true });
        kept.push(projectDir);
        expect(requests[0]).toMatchObject({ orchestrate: true, model: "big" });
        expect(answered).toEqual([["p9", "deny"]]);
        expect(fs.existsSync(projectDir)).toBe(true);
    });
});

describe("runEval and compareReports", () => {
    const ok: EvalTask = { name: "passes", prompt: "p", checks: [{ file_absent: "nope" }] };
    const bad: EvalTask = { name: "fails", prompt: "p", checks: [{ file_exists: "nope" }] };

    it("runs every task in order and totals the results", async () => {
        const order: string[] = [];
        const { client } = fakeClient(() => [done]);
        const report = await runEval(client, [ok, bad, { ...ok, name: "passes-too" }], { onTaskStart: (t) => order.push(t.name) });

        expect(order).toEqual(["passes", "fails", "passes-too"]);
        expect(report).toMatchObject({ total: 3, passed: 2, failed: 1, inputTokens: 3600, outputTokens: 900 });
        expect(report.costUsd).toBeCloseTo(0.006, 9);
        expect(report.results.map((r) => r.passed)).toEqual([true, false, true]);
    });

    it("compareReports lists regressions and fixes, ignoring new and unchanged tasks", () => {
        const report = (results: Array<[string, boolean]>): EvalReport => ({
            startedAt: "", passed: 0, failed: 0, total: results.length, durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
            results: results.map(([name, passed]) => ({ name, passed, checks: [], durationMs: 0, toolCalls: 0 })),
        });
        const diff = compareReports(
            report([["a", true], ["b", false], ["c", true], ["d", false]]),
            report([["a", false], ["b", true], ["c", true], ["d", false], ["new", false]]),
        );
        expect(diff).toEqual({ regressions: ["a"], fixes: ["b"] });
    });
});
