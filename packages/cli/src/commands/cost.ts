import chalk from "chalk";
import { CostTracker } from "@pantheon/core";
import * as readline from "node:readline";

// Brand colors matching theme.ts
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");
const dim = chalk.hex("#6B7280");
const muted = chalk.hex("#4B5563");
const success = chalk.hex("#4ADE80");
const warning = chalk.hex("#FBBF24");
const error = chalk.hex("#EF4444");
const border = chalk.hex("#3A3A3A");

const BRAND_MARK = `${brand.bold("◆")} ${brand("Pantheon")}`;
const HR = border("─".repeat(50));

function formatCost(usd: number): string {
    if (usd === 0) return dim("$0.00");
    if (usd < 0.01) return success(`${(usd * 100).toFixed(4)}¢`);
    if (usd < 0.10) return warning(`$${usd.toFixed(4)}`);
    return error(`$${usd.toFixed(4)}`);
}

export function costSummary() {
    const tracker = new CostTracker();
    const summary = tracker.getSummary();
    const byModel = tracker.getByModel();

    console.log(`\n  ${BRAND_MARK} ${dim("— Cost Summary")}\n`);
    console.log(`  ${HR}\n`);

    if (summary.totalCalls === 0) {
        console.log(`  ${dim("No usage recorded yet.")}\n`);
        return;
    }

    const labelWidth = 16;
    const label = (s: string) => accent(s.padEnd(labelWidth));

    console.log(`  ${label("Total calls")}${chalk.white.bold(summary.totalCalls.toString())}`);
    console.log(`  ${label("Input tokens")}${chalk.white(summary.totalInputTokens.toLocaleString())}`);
    console.log(`  ${label("Output tokens")}${chalk.white(summary.totalOutputTokens.toLocaleString())}`);
    console.log(`  ${label("Total cost")}${formatCost(summary.totalCostUsd)}`);

    console.log(`\n  ${HR}`);
    console.log(`  ${dim("By model")}\n`);

    for (const [modelId, stats] of Object.entries(byModel)) {
        console.log(`  ${brand("•")} ${chalk.white.bold(modelId)}`);
        console.log(`    ${muted("calls:")} ${chalk.white(stats.calls.toString())}  ${muted("in:")} ${chalk.white(stats.inputTokens.toString())}  ${muted("out:")} ${chalk.white(stats.outputTokens.toString())}  ${muted("cost:")} ${formatCost(stats.costUsd)}`);
    }

    console.log(`\n  ${HR}\n`);
}

export function costRecent(n = 10) {
    const tracker = new CostTracker();
    const records = tracker.getRecent(n);

    console.log(`\n  ${BRAND_MARK} ${dim(`— Last ${n} Calls`)}\n`);
    console.log(`  ${HR}\n`);

    if (records.length === 0) {
        console.log(`  ${dim("No usage recorded yet.")}\n`);
        return;
    }

    for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        const ts = new Date(r.timestamp).toLocaleString();
        const tokens = `${muted("in:")}${chalk.white(r.inputTokens.toString())} ${muted("out:")}${chalk.white(r.outputTokens.toString())}`;
        const preview = r.promptPreview.length > 50
            ? r.promptPreview.slice(0, 50) + "…"
            : r.promptPreview;

        // Alternate dimming for readability
        const rowColor = i % 2 === 0 ? chalk.white : dim;

        console.log(`  ${muted(`[${ts}]`)} ${accent(r.modelId)} ${muted("·")} ${tokens} ${muted("·")} ${formatCost(r.costUsd)}`);
        console.log(`  ${muted('"')}${rowColor(preview)}${muted('"')}\n`);
    }

    console.log(`  ${HR}\n`);
}

export async function costReset() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    await new Promise<void>((resolve) => {
        rl.question(`  ${warning("⚠")} Reset all usage data? This cannot be undone. ${dim("(y/N)")} `, (answer) => {
            rl.close();
            if (answer.trim().toLowerCase() === "y") {
                new CostTracker().reset();
                console.log(`  ${success("✓")} Usage data cleared.\n`);
            } else {
                console.log(`  ${dim("Cancelled.")}\n`);
            }
            resolve();
        });
    });
}