import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

/**
 * Repeatable end-to-end tasks, run against the real stack (server, gateway, model).
 *
 * Unit tests prove the plumbing; they cannot say whether Pantheon does good work.
 * An eval task is a small project, a prompt, and checks on the result — run the
 * set after changing a prompt, a model or the orchestration and see what moved.
 */
export type EvalCheck =
    | { file_exists: string }
    | { file_absent: string }
    | { file_contains: { path: string; text: string } }
    | { file_not_contains: { path: string; text: string } }
    | { file_equals: { path: string; text: string } }
    /** Shell command run in the task's project; passes when it exits 0. */
    | { command: string }
    | { response_contains: string }
    | { response_not_contains: string }
    /** A tool with this name was (or, with `tool_not_called`, was not) used. */
    | { tool_called: string }
    | { tool_not_called: string }
    | { max_tool_calls: number };

export interface EvalTask {
    name: string;
    description?: string;
    prompt: string;
    /** Files the project starts with: relative path → content. */
    files?: Record<string, string>;
    checks: EvalCheck[];
    /** Passed through to the chat request. */
    orchestrate?: boolean | "auto";
    model?: string;
    noTools?: boolean;
    /** Give up on the task after this many seconds. Default 300. */
    timeoutSeconds?: number;
}

export interface CheckResult {
    check: string;
    passed: boolean;
    detail?: string;
}

export interface EvalResult {
    name: string;
    passed: boolean;
    checks: CheckResult[];
    durationMs: number;
    toolCalls: number;
    /** Model the request was routed to, and the tier the classifier chose. */
    model?: string;
    tier?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    error?: string;
}

/** What the runner needs from a Pantheon server; `PantheonApiClient` satisfies it. */
export interface EvalClient {
    chat(opts: {
        prompt: string;
        workingDir: string;
        orchestrate?: boolean | "auto";
        model?: string;
        noTools?: boolean;
    }): AsyncGenerator<{ event: string; data: Record<string, unknown> }>;
    respondToToolPermission(toolCallId: string, decision: "allow_once" | "always_allow" | "deny"): Promise<void>;
    getCostSummary(sessionId?: string): Promise<{ summary: { totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number } }>;
}

// ── Loading ──────────────────────────────────────────────────────────────────

function describeCheck(check: EvalCheck): string {
    const [kind, value] = Object.entries(check)[0] ?? ["?", ""];
    const shown = typeof value === "object" && value !== null ? (value as { path: string }).path : String(value);
    return `${kind}: ${shown.length > 60 ? shown.slice(0, 57) + "…" : shown}`;
}

const CHECK_KINDS = new Set([
    "file_exists", "file_absent", "file_contains", "file_not_contains", "file_equals", "command",
    "response_contains", "response_not_contains", "tool_called", "tool_not_called", "max_tool_calls",
]);

/** Parse and validate one task definition. Throws with the file name on any problem. */
export function parseTask(source: string, origin: string): EvalTask {
    const raw = yaml.load(source) as Partial<EvalTask> | null;
    const fail = (why: string): never => {
        throw new Error(`${origin}: ${why}`);
    };
    if (!raw || typeof raw !== "object") return fail("not a YAML mapping");
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) fail("`prompt` is required");
    if (!Array.isArray(raw.checks) || raw.checks.length === 0) fail("`checks` must list at least one check");
    for (const check of raw.checks!) {
        const keys = check && typeof check === "object" ? Object.keys(check) : [];
        if (keys.length !== 1 || !CHECK_KINDS.has(keys[0]!)) {
            fail(`unknown check ${JSON.stringify(check)} — expected one of ${[...CHECK_KINDS].join(", ")}`);
        }
    }
    for (const file of Object.keys(raw.files ?? {})) {
        if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) fail(`file path "${file}" must stay inside the project`);
    }
    return { ...raw, name: raw.name?.trim() || path.basename(origin).replace(/\.ya?ml$/, "") } as EvalTask;
}

/** Load every `*.yml` / `*.yaml` task in a directory (sorted by file name), or a single file. */
export function loadTasks(location: string): EvalTask[] {
    const stat = fs.statSync(location);
    const files = stat.isDirectory()
        ? fs.readdirSync(location).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(location, f))
        : [location];
    if (files.length === 0) throw new Error(`No eval tasks (*.yml) found in ${location}`);
    return files.map((file) => parseTask(fs.readFileSync(file, "utf-8"), file));
}

// ── Checks ───────────────────────────────────────────────────────────────────

export interface RunObservation {
    projectDir: string;
    response: string;
    toolNames: string[];
}

function runCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        execFile("sh", ["-c", command], { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ ok: !error, output: `${stdout}${stderr}`.trim().slice(-400) });
        });
    });
}

/** Resolve a path named by a check, refusing to leave the task's project. */
function inProject(projectDir: string, relative: string): string {
    const resolved = path.resolve(projectDir, relative);
    if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
        throw new Error(`check path "${relative}" is outside the project`);
    }
    return resolved;
}

export async function evaluateCheck(check: EvalCheck, seen: RunObservation): Promise<CheckResult> {
    const label = describeCheck(check);
    const read = (p: string) => fs.readFileSync(inProject(seen.projectDir, p), "utf-8");
    try {
        if ("file_exists" in check) {
            return { check: label, passed: fs.existsSync(inProject(seen.projectDir, check.file_exists)) };
        }
        if ("file_absent" in check) {
            return { check: label, passed: !fs.existsSync(inProject(seen.projectDir, check.file_absent)) };
        }
        if ("file_contains" in check) {
            return { check: label, passed: read(check.file_contains.path).includes(check.file_contains.text) };
        }
        if ("file_not_contains" in check) {
            return { check: label, passed: !read(check.file_not_contains.path).includes(check.file_not_contains.text) };
        }
        if ("file_equals" in check) {
            return { check: label, passed: read(check.file_equals.path).trim() === check.file_equals.text.trim() };
        }
        if ("command" in check) {
            const { ok, output } = await runCommand(check.command, seen.projectDir);
            return { check: label, passed: ok, ...(ok || !output ? {} : { detail: output }) };
        }
        if ("response_contains" in check) {
            return { check: label, passed: seen.response.toLowerCase().includes(check.response_contains.toLowerCase()) };
        }
        if ("response_not_contains" in check) {
            return { check: label, passed: !seen.response.toLowerCase().includes(check.response_not_contains.toLowerCase()) };
        }
        if ("tool_called" in check) {
            return { check: label, passed: seen.toolNames.includes(check.tool_called) };
        }
        if ("tool_not_called" in check) {
            return { check: label, passed: !seen.toolNames.includes(check.tool_not_called) };
        }
        if ("max_tool_calls" in check) {
            return {
                check: label,
                passed: seen.toolNames.length <= check.max_tool_calls,
                ...(seen.toolNames.length > check.max_tool_calls ? { detail: `${seen.toolNames.length} tool calls` } : {}),
            };
        }
        return { check: label, passed: false, detail: "unknown check" };
    } catch (err) {
        return { check: label, passed: false, detail: err instanceof Error ? err.message : String(err) };
    }
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface RunOptions {
    /** Answer to every tool-permission prompt. Default: approve (the project is a throw-away copy). */
    approve?: "always_allow" | "deny";
    /** Keep each task's project directory afterwards, for inspection. */
    keep?: boolean;
    onTaskStart?: (task: EvalTask) => void;
    onTaskEnd?: (result: EvalResult, projectDir: string) => void;
}

function writeProject(task: EvalTask): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pantheon-eval-${task.name.replace(/[^\w-]/g, "_")}-`)));
    for (const [file, content] of Object.entries(task.files ?? {})) {
        const target = path.join(dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return dir;
}

export async function runTask(client: EvalClient, task: EvalTask, options: RunOptions = {}): Promise<{ result: EvalResult; projectDir: string }> {
    const projectDir = writeProject(task);
    const started = Date.now();
    const toolNames: string[] = [];
    let response = "";
    let sessionId: string | undefined;
    let model: string | undefined;
    let tier: string | undefined;
    let error: string | undefined;

    const deadline = (task.timeoutSeconds ?? 300) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deadline);
        timer.unref();
    });

    const stream = client.chat({
        prompt: task.prompt,
        workingDir: projectDir,
        ...(task.orchestrate !== undefined ? { orchestrate: task.orchestrate } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.noTools ? { noTools: true } : {}),
    });

    const consume = (async () => {
        for await (const { event, data } of stream) {
            if (event === "routing") {
                model = String(data["selectedModelId"] ?? "");
                tier = String(data["tier"] ?? "");
            } else if (event === "text") {
                response += String(data["content"] ?? "");
            } else if (event === "tool_call") {
                toolNames.push(String(data["name"] ?? ""));
            } else if (event === "tool_permission_required") {
                await client.respondToToolPermission(String(data["toolCallId"]), options.approve ?? "always_allow");
            } else if (event === "done") {
                sessionId = String(data["sessionId"] ?? "");
            } else if (event === "error") {
                error = String(data["message"] ?? "unknown error");
            }
        }
        return "done" as const;
    })().catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
        return "done" as const;
    });

    if ((await Promise.race([consume, timedOut])) === "timeout") {
        error = `timed out after ${deadline / 1000}s`;
        // Stop reading; the server finishes or abandons the turn on its own
        void stream.return(undefined).catch(() => {});
    }
    if (timer) clearTimeout(timer);

    const checks = error
        ? task.checks.map((c) => ({ check: describeCheck(c), passed: false, detail: "not evaluated (the run failed)" }))
        : await Promise.all(task.checks.map((c) => evaluateCheck(c, { projectDir, response, toolNames })));

    let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
    if (sessionId) {
        try {
            const { summary } = await client.getCostSummary(sessionId);
            usage = { inputTokens: summary.totalInputTokens, outputTokens: summary.totalOutputTokens, costUsd: summary.totalCostUsd };
        } catch {
            // usage is informative only
        }
    }

    const result: EvalResult = {
        name: task.name,
        passed: !error && checks.every((c) => c.passed),
        checks,
        durationMs: Date.now() - started,
        toolCalls: toolNames.length,
        ...(model ? { model } : {}),
        ...(tier ? { tier } : {}),
        ...usage,
        ...(error ? { error } : {}),
    };

    options.onTaskEnd?.(result, projectDir);
    if (!options.keep) fs.rmSync(projectDir, { recursive: true, force: true });
    return { result, projectDir };
}

export interface EvalReport {
    startedAt: string;
    passed: number;
    failed: number;
    total: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    results: EvalResult[];
}

/** Run tasks one after another (so they do not compete for the model's rate limit). */
export async function runEval(client: EvalClient, tasks: EvalTask[], options: RunOptions = {}): Promise<EvalReport> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const results: EvalResult[] = [];
    for (const task of tasks) {
        options.onTaskStart?.(task);
        results.push((await runTask(client, task, options)).result);
    }
    const sum = (pick: (r: EvalResult) => number | undefined) => results.reduce((total, r) => total + (pick(r) ?? 0), 0);
    return {
        startedAt,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        total: results.length,
        durationMs: Date.now() - started,
        inputTokens: sum((r) => r.inputTokens),
        outputTokens: sum((r) => r.outputTokens),
        costUsd: sum((r) => r.costUsd),
        results,
    };
}

/** Tasks whose outcome differs between two reports — the point of running evals repeatedly. */
export function compareReports(previous: EvalReport, current: EvalReport): { regressions: string[]; fixes: string[] } {
    const before = new Map(previous.results.map((r) => [r.name, r.passed]));
    const regressions: string[] = [];
    const fixes: string[] = [];
    for (const r of current.results) {
        const was = before.get(r.name);
        if (was === true && !r.passed) regressions.push(r.name);
        if (was === false && r.passed) fixes.push(r.name);
    }
    return { regressions, fixes };
}
