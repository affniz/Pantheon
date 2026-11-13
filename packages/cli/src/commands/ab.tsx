import chalk from "chalk";
import { getServerUrl, ensureServerRunning } from "../server-manager.js";
import { PantheonApiClient } from "../api-client.js";

const dim = chalk.hex("#6B7280");
const accent = chalk.hex("#56B6C2");
const brand = chalk.hex("#F5A623");

export async function abList() {
    try {
        await ensureServerRunning();
        const client = new PantheonApiClient(getServerUrl());
        const res = await (client as any).get("/api/ab/experiments");
        const experiments = (res as any).experiments as Array<{
            id: string;
            name: string;
            splitPercent: number;
            controlModelId: string;
            variantModelId: string;
            active: boolean;
        }>;

        if (experiments.length === 0) {
            console.log("");
            console.log(dim("  No A/B experiments configured."));
            console.log(dim("  Add experiments to your config.yml under the `ab.experiments` key."));
            console.log("");
            return;
        }

        console.log("");
        console.log(`  ${brand.bold("◆ A/B Experiments")}`);
        console.log(`  ${dim("─".repeat(70))}`);

        for (const exp of experiments) {
            const statusIcon = exp.active ? chalk.green("● active") : dim("○ inactive");
            console.log(`  ${statusIcon}  ${chalk.bold(exp.name)} ${dim(`(${exp.id})`)}`);
            console.log(`     ${dim("Control")}:  ${exp.controlModelId}`);
            console.log(`     ${dim("Variant")}:  ${exp.variantModelId} ${dim(`(${exp.splitPercent}% traffic)`)}`);
            console.log("");
        }
    } catch (err) {
        console.error(chalk.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}

export async function abComparison(experimentId: string) {
    try {
        await ensureServerRunning();
        const client = new PantheonApiClient(getServerUrl());
        const res = await (client as any).get(`/api/ab/experiments/${experimentId}/comparison`);
        const c = (res as any).comparison as {
            experimentId: string;
            runCount: number;
            controlRunCount: number;
            variantRunCount: number;
            controlAvgLatencyMs: number;
            variantAvgLatencyMs: number;
            controlAvgQualityScore: number | null;
            variantAvgQualityScore: number | null;
        };

        console.log("");
        console.log(`  ${brand.bold("◆ A/B Comparison")} ${dim(`experiment: ${experimentId}`)}`);
        console.log(`  ${dim("─".repeat(60))}`);
        console.log(`  ${dim("Total runs")}:  ${c.runCount} (control: ${c.controlRunCount}, variant: ${c.variantRunCount})`);
        console.log("");
        console.log(`  ${dim("Metric".padEnd(25))} ${dim("Control".padEnd(15))} ${dim("Variant")}`);
        console.log(`  ${dim("─".repeat(55))}`);

        const fmt = (n: number | null, suffix: string) =>
            n === null ? dim("n/a") : `${Math.round(n)}${suffix}`;

        console.log(
            `  ${"Avg Latency".padEnd(25)} ${fmt(c.controlAvgLatencyMs, "ms").padEnd(15)} ${fmt(c.variantAvgLatencyMs, "ms")}`
        );
        console.log(
            `  ${"Avg Quality Score".padEnd(25)} ${fmt(c.controlAvgQualityScore, "/10").padEnd(15)} ${fmt(c.variantAvgQualityScore, "/10")}`
        );
        console.log("");

        // Simple winner analysis
        if (c.variantAvgQualityScore !== null && c.controlAvgQualityScore !== null) {
            const diff = c.variantAvgQualityScore - c.controlAvgQualityScore;
            if (diff > 0.5) {
                console.log(`  ${chalk.green("✓")} Variant is winning (quality +${diff.toFixed(1)} points)`);
            } else if (diff < -0.5) {
                console.log(`  ${chalk.yellow("⚠")} Control is winning (variant quality -${Math.abs(diff).toFixed(1)} points)`);
            } else {
                console.log(`  ${dim("─")} No significant quality difference yet`);
            }
        } else {
            console.log(`  ${dim("Quality scores not yet available — wait for async LLM judge to run")}`);
        }
        console.log("");
    } catch (err) {
        console.error(chalk.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}
