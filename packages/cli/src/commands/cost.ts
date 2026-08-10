import chalk from "chalk";
import { PantheonApiClient } from "../api-client.js";
import { ensureServerRunning } from "../server-manager.js";

const dim = chalk.hex("#6B7280");
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");

export async function costSummary() {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    const { summary, byModel } = await client.getCostSummary();

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Usage Summary")}`);
    console.log(`  ${dim("─".repeat(50))}`);
    console.log(`  ${dim("Total calls:")}         ${summary.totalCalls}`);
    console.log(`  ${dim("Total input tokens:")}  ${summary.totalInputTokens.toLocaleString()}`);
    console.log(`  ${dim("Total output tokens:")} ${summary.totalOutputTokens.toLocaleString()}`);
    console.log(`  ${dim("Total cost:")}          $${summary.totalCostUsd.toFixed(6)}`);

    const models = Object.entries(byModel);
    if (models.length > 1) {
        console.log(`\n  ${dim("─".repeat(50))}`);
        console.log(`  ${dim("By model:")}`);
        for (const [modelId, stats] of models) {
            const s = stats as { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
            console.log(`  ${accent(modelId)}`);
            console.log(`    ${dim("Calls:")} ${s.calls}  ${dim("In:")} ${s.inputTokens.toLocaleString()}  ${dim("Out:")} ${s.outputTokens.toLocaleString()}`);
        }
    }

    console.log("");
}

export async function costRecent(n = 10) {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    const records = await client.getCostRecent(n);

    if (records.length === 0) {
        console.log(dim("\n  No usage records found.\n"));
        return;
    }

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold(`Last ${records.length} Calls`)}`);
    console.log(`  ${dim("─".repeat(80))}`);
    console.log(
        `  ${dim("MODEL".padEnd(15))} ${"IN".padEnd(8)} ${"OUT".padEnd(8)} ${"COST".padEnd(12)} PROMPT`
    );
    console.log(`  ${dim("─".repeat(80))}`);

    for (const r of records) {
        const model = (r.modelId ?? "unknown").padEnd(15);
        const inTok = String(r.inputTokens).padEnd(8);
        const outTok = String(r.outputTokens).padEnd(8);
        const cost = `$${r.costUsd.toFixed(6)}`.padEnd(12);
        const preview = r.promptPreview.replace(/\n/g, " ").slice(0, 30);
        console.log(`  ${accent(model)} ${inTok} ${outTok} ${cost} ${dim(preview)}`);
    }

    console.log(`  ${dim("─".repeat(80))}`);
    console.log("");
}

export async function costReset() {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    await client.resetCost();
    console.log(chalk.green("  ✓ Usage data cleared."));
}