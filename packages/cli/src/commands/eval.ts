import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { PantheonApiClient } from "../api-client.js";
import { ensureServerRunning } from "../server-manager.js";
import { compareReports, loadTasks, runEval, type EvalClient, type EvalReport } from "../eval/eval.js";

const dim = chalk.hex("#6B7280");
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");

/** The bundled tasks live in <repo>/evals; a project can keep its own in ./evals. */
function defaultLocation(): string | undefined {
    const candidates = [
        path.resolve(process.cwd(), "evals"),
        path.resolve(new URL(import.meta.url).pathname, "../../../../../evals"),
    ];
    return candidates.find((c) => fs.existsSync(c));
}

/**
 * pantheon eval [location] [--only <name…>] [--report <file>] [--compare <file>] [--keep]
 *
 * Runs each task against the running server and model, checks the outcome, and
 * exits non-zero if any task failed. Tasks run in throw-away copies of their
 * projects, so tool-permission prompts are approved automatically.
 */
export async function evalCommand(
    location: string | undefined,
    opts: { only?: string[]; report?: string; compare?: string; keep?: boolean },
): Promise<void> {
    const where = location ?? defaultLocation();
    if (!where) throw new Error("No eval tasks found. Pass a directory or file, or create ./evals/*.yml.");

    let tasks = loadTasks(where);
    if (opts.only && opts.only.length > 0) {
        tasks = tasks.filter((t) => opts.only!.some((name) => t.name.includes(name)));
        if (tasks.length === 0) throw new Error(`No task matches ${opts.only.join(", ")}.`);
    }

    await ensureServerRunning();
    const client = new PantheonApiClient() as unknown as EvalClient;

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Pantheon eval")} ${dim(`${tasks.length} task(s) from ${where}`)}`);
    console.log(`  ${dim("─".repeat(78))}`);

    const report = await runEval(client, tasks, {
        keep: Boolean(opts.keep),
        onTaskStart: (task) => {
            // Progress line, overwritten by the result (only when attached to a terminal)
            if (process.stdout.isTTY) process.stdout.write(`  ${dim("…")} ${task.name}\r`);
        },
        onTaskEnd: (r, projectDir) => {
            if (process.stdout.isTTY) process.stdout.write("\x1b[2K");
            const mark = r.passed ? chalk.green("✓") : chalk.red("✗");
            const meta = [
                `${(r.durationMs / 1000).toFixed(1)}s`,
                `${r.toolCalls} tool call${r.toolCalls === 1 ? "" : "s"}`,
                r.model ? `${r.tier} → ${r.model}` : "",
                r.inputTokens !== undefined ? `${(r.inputTokens + (r.outputTokens ?? 0)).toLocaleString()} tok` : "",
            ].filter(Boolean).join(dim(" · "));
            console.log(`  ${mark} ${chalk.white(r.name.padEnd(30))} ${dim(meta)}`);
            if (r.error) console.log(`      ${chalk.red(r.error)}`);
            for (const c of r.checks.filter((c) => !c.passed && !r.error)) {
                console.log(`      ${chalk.red("✗")} ${c.check}${c.detail ? dim(`  — ${c.detail.split("\n").at(-1)}`) : ""}`);
            }
            if (opts.keep) console.log(`      ${dim(projectDir)}`);
        },
    });

    console.log(`  ${dim("─".repeat(78))}`);
    const verdict = report.failed === 0 ? chalk.green.bold(`${report.passed}/${report.total} passed`) : chalk.red.bold(`${report.passed}/${report.total} passed`);
    console.log(
        `  ${verdict}  ${dim(`${(report.durationMs / 1000).toFixed(0)}s · ${(report.inputTokens + report.outputTokens).toLocaleString()} tokens` +
            (report.costUsd > 0 ? ` · $${report.costUsd.toFixed(4)}` : ""))}`,
    );

    if (opts.compare) {
        const previous = JSON.parse(fs.readFileSync(opts.compare, "utf-8")) as EvalReport;
        const { regressions, fixes } = compareReports(previous, report);
        console.log(`  ${dim(`vs ${opts.compare}:`)} ${previous.passed}/${previous.total} → ${report.passed}/${report.total}`);
        for (const name of regressions) console.log(`    ${chalk.red("regressed")} ${name}`);
        for (const name of fixes) console.log(`    ${chalk.green("now passes")} ${name}`);
    }
    if (opts.report) {
        fs.writeFileSync(opts.report, JSON.stringify(report, null, 2) + "\n");
        console.log(`  ${dim("Report written to")} ${accent(opts.report)}`);
    }
    console.log("");

    if (report.failed > 0) process.exitCode = 1;
}
