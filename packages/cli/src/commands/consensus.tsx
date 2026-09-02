import chalk from "chalk";
import { PantheonApiClient } from "../api-client.js";
import { getServerUrl, ensureServerRunning } from "../server-manager.js";

const dim = chalk.hex("#6B7280");
const accent = chalk.hex("#56B6C2");
const brand = chalk.hex("#F5A623");

export async function consensusList(opts: { limit?: number } = {}) {
    try {
        await ensureServerRunning();
        const client = new PantheonApiClient(getServerUrl());
        const res = await (client as any).get("/api/consensus", { limit: opts.limit ?? 20 });
        const runs = (res as any).runs as Array<{
            id: string;
            sessionId: string | null;
            promptHash: string;
            synthesisLatencyMs: number;
            createdAt: string;
        }>;

        if (runs.length === 0) {
            console.log(dim("  No consensus runs yet. Use `pantheon chat --consensus` to start."));
            return;
        }

        console.log("");
        console.log(`  ${brand.bold("◆ Consensus Runs")} ${dim(`(${runs.length} shown)`)}`);
        console.log(`  ${dim("─".repeat(70))}`);
        console.log(
            `  ${dim("ID".padEnd(36))}  ${dim("Session".padEnd(12))}  ${dim("Synthesis")}  ${dim("Created")}`
        );
        console.log(`  ${dim("─".repeat(70))}`);

        for (const run of runs) {
            const id = run.id.slice(0, 8);
            const session = (run.sessionId ?? "-").slice(0, 8);
            const latency = `${run.synthesisLatencyMs}ms`.padEnd(10);
            const created = new Date(run.createdAt).toLocaleString();
            console.log(`  ${accent(id.padEnd(36))}  ${session.padEnd(12)}  ${latency}  ${dim(created)}`);
        }
        console.log("");
    } catch (err) {
        console.error(chalk.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}

export async function consensusShow(id: string) {
    try {
        await ensureServerRunning();
        const client = new PantheonApiClient(getServerUrl());
        const res = await (client as any).get(`/api/consensus/${id}`);
        const run = (res as any).run as {
            id: string;
            sessionId: string | null;
            promptHash: string;
            synthesizedContent: string;
            modelResponses: Array<{
                modelId: string;
                content: string;
                latencyMs: number;
                inputTokens: number;
                outputTokens: number;
                error?: string;
            }>;
            synthesisLatencyMs: number;
            createdAt: string;
        };

        console.log("");
        console.log(`  ${brand.bold("◆ Consensus Run")} ${dim(run.id)}`);
        console.log(`  ${dim("Created")}:  ${new Date(run.createdAt).toLocaleString()}`);
        if (run.sessionId) {
            console.log(`  ${dim("Session")}:  ${run.sessionId}`);
        }
        console.log(`  ${dim("Prompt hash")}:  ${run.promptHash}`);
        console.log("");
        console.log(`  ${accent.bold("Model Responses:")}`);
        console.log(`  ${dim("─".repeat(60))}`);

        for (const r of run.modelResponses) {
            const status = r.error ? chalk.red("✗ FAILED") : chalk.green("✓");
            console.log(`  ${status} ${chalk.bold(r.modelId)} ${dim(`(${r.latencyMs}ms, ${r.inputTokens}in/${r.outputTokens}out)`)}`);
            if (r.error) {
                console.log(`    ${chalk.red(r.error)}`);
            } else {
                const preview = r.content.slice(0, 200).replace(/\n/g, " ");
                console.log(`    ${dim(preview + (r.content.length > 200 ? "..." : ""))}`);
            }
            console.log("");
        }

        console.log(`  ${accent.bold("Synthesized Response:")} ${dim(`(synthesis: ${run.synthesisLatencyMs}ms)`)}`);
        console.log(`  ${dim("─".repeat(60))}`);
        console.log("");
        // Word-wrap at 76 chars
        const words = run.synthesizedContent.split(" ");
        let line = "  ";
        for (const word of words) {
            if (line.length + word.length > 78) {
                console.log(line);
                line = "  " + word + " ";
            } else {
                line += word + " ";
            }
        }
        if (line.trim()) console.log(line);
        console.log("");
    } catch (err) {
        console.error(chalk.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}
