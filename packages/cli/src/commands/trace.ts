import chalk from "chalk";
import readline from "node:readline";
import { PantheonApiClient } from "../api-client.js";
import { ensureServerRunning } from "../server-manager.js";
import { renderTraceWaterfall } from "../ui/trace-waterfall.js";

const dim = chalk.hex("#6B7280");
const accent = chalk.hex("#56B6C2");
const brand = chalk.hex("#F5A623");

function timeAgo(epochMs: number): string {
    const seconds = Math.floor((Date.now() - epochMs) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "yesterday" : `${days}d ago`;
}

export async function traceList(opts: { limit?: number } = {}) {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    const traces = await client.listTraces(opts.limit ?? 20);

    if (traces.length === 0) {
        console.log(dim("\n  No traces recorded yet. Run pantheon chat to generate traces.\n"));
        return;
    }

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Recent Traces")}`);
    console.log(`  ${dim("─".repeat(80))}`);
    console.log(
        `  ${dim("TRACE ID".padEnd(38))} ${"WHEN".padEnd(12)} ${"SPANS".padEnd(7)} ${"DURATION".padEnd(10)} STATUS`
    );
    console.log(`  ${dim("─".repeat(80))}`);

    for (const trace of traces) {
        const when = timeAgo(trace.startTime);
        const duration = `${trace.totalDurationMs ?? 0}ms`;
        const status = trace.status === "ok" ? chalk.green("✓") : chalk.red("✗");
        const id = trace.traceId.slice(0, 36);

        console.log(
            `  ${accent(id)}  ${dim(when.padEnd(12))} ${String(trace.spanCount).padEnd(7)} ${duration.padEnd(10)} ${status}`
        );
    }

    console.log(`  ${dim("─".repeat(80))}`);
    console.log(`  ${dim(`Showing ${traces.length} traces. Use --limit N for more.`)}`);
    console.log("");
}

export async function traceShow(traceId: string) {
    await ensureServerRunning();
    const client = new PantheonApiClient();

    try {
        const spans = await client.getTrace(traceId);
        renderTraceWaterfall(spans);
    } catch (err) {
        console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}

export async function traceClear() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
        rl.question(chalk.yellow("  Clear all trace data? This cannot be undone. [y/N] "), resolve)
    );
    rl.close();

    if (answer.trim().toLowerCase() !== "y") {
        console.log(dim("  Cancelled."));
        return;
    }

    await ensureServerRunning();
    const client = new PantheonApiClient();
    await client.clearTraces();
    console.log(chalk.green("  ✓ All trace data cleared."));
}
