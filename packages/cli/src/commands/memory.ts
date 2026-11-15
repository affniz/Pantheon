import chalk from "chalk";
import { ensureServerRunning, getServerUrl } from "../server-manager.js";
import { resolveToken } from "../credentials.js";

const dim = chalk.hex("#6B7280");
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    await ensureServerRunning();
    const server = getServerUrl();
    const token = resolveToken(server);
    const res = await fetch(`${server}/api/memory${path}`, {
        ...init,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
        throw new Error(
            res.status === 401
                ? "Authentication required — run `pantheon auth login` (or set PANTHEON_API_TOKEN)."
                : body.error ?? `HTTP ${res.status}`,
        );
    }
    return body;
}

interface Status {
    enabled: boolean;
    search: string;
    chunks: number;
    sessions: number;
    models: Array<{ embeddingModel: string; dimensions: number; chunks: number }>;
}

/** pantheon memory status */
export async function memoryStatus(): Promise<void> {
    const s = await call<Status>("/status");
    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Semantic memory")}`);
    console.log(`  ${dim("─".repeat(50))}`);
    console.log(`  ${dim("Enabled:")}   ${s.enabled ? chalk.green("yes") : chalk.yellow("no")}`);
    console.log(`  ${dim("Search:")}    ${s.search}${s.search === "pgvector" ? dim(" (inside PostgreSQL)") : dim(" (computed by the server)")}`);
    console.log(`  ${dim("Indexed:")}   ${s.chunks.toLocaleString()} passages from ${s.sessions.toLocaleString()} session(s)`);
    for (const m of s.models) {
        console.log(`  ${dim("Model:")}     ${accent(m.embeddingModel)} ${dim(`${m.dimensions} dims, ${m.chunks.toLocaleString()} passages`)}`);
    }
    if (!s.enabled) {
        console.log("");
        console.log(dim("  To enable, add an embedding model to litellm-config.yaml and set in ~/.pantheon/config.yml:"));
        console.log(dim("    memory: { semantic: { enabled: true, embeddingModel: pantheon-embed } }"));
    }
    console.log("");
}

/** pantheon memory search <query> [-n <count>] */
export async function memorySearch(query: string, opts: { num?: string }): Promise<void> {
    const params = new URLSearchParams({ q: query, limit: opts.num ?? "5" });
    const { results } = await call<{
        results: Array<{ sessionId: string; sessionTitle: string; role: string; content: string; score: number; createdAt: number }>;
    }>(`/search?${params.toString()}`);

    console.log("");
    if (results.length === 0) {
        console.log(dim("  Nothing relevant found in past conversations."));
        console.log("");
        return;
    }
    for (const r of results) {
        const date = new Date(r.createdAt).toISOString().slice(0, 10);
        console.log(`  ${accent(r.score.toFixed(2))}  ${chalk.white(r.sessionTitle.slice(0, 50))} ${dim(`${date} · ${r.sessionId.slice(0, 8)} · ${r.role}`)}`);
        console.log(`        ${dim(r.content.replace(/\s+/g, " ").slice(0, 220))}`);
        console.log("");
    }
}

/** pantheon memory reindex */
export async function memoryReindex(): Promise<void> {
    console.log(dim("\n  Embedding messages that are not indexed yet…"));
    const { sessions, chunks } = await call<{ sessions: number; chunks: number }>("/reindex", { method: "POST" });
    console.log(chalk.green(`  ✓ ${chunks.toLocaleString()} new passage(s) indexed across ${sessions.toLocaleString()} session(s)\n`));
}

/** pantheon memory clear */
export async function memoryClear(): Promise<void> {
    const { removed } = await call<{ removed: number }>("/", { method: "DELETE" });
    console.log(chalk.green(`\n  ✓ Removed ${removed.toLocaleString()} indexed passage(s). Conversations are untouched.\n`));
}
