import chalk from "chalk";
import readline from "node:readline";
import { PantheonApiClient } from "../api-client.js";
import { ensureServerRunning } from "../server-manager.js";

const dim = chalk.hex("#6B7280");
const accent = chalk.hex("#56B6C2");
const brand = chalk.hex("#F5A623");
const muted = chalk.hex("#4B5563");

function timeAgo(isoString: string): string {
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString();
}

export async function sessionsList(opts: { num?: string; all?: boolean }) {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    const limit = Number(opts.num ?? 10);
    const sessions = await client.listSessions({
        limit,
        ...(opts.all ? { all: true } : {}),
    });

    if (sessions.length === 0) {
        console.log(dim("\n  No sessions found. Run `pantheon chat` to start one.\n"));
        return;
    }

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Recent Sessions")}`);
    console.log(`  ${dim("─".repeat(75))}`);
    console.log(
        `  ${dim("ID".padEnd(10))} ${"TITLE".padEnd(35)} ${"UPDATED".padEnd(12)} MSGS`
    );
    console.log(`  ${dim("─".repeat(75))}`);

    for (const s of sessions) {
        const id = accent(s.id.slice(0, 8));
        const title = s.title.slice(0, 34).padEnd(35);
        const when = timeAgo(s.updatedAt).padEnd(12);
        const msgs = String(s.messageCount ?? 0);
        const archived = s.isArchived ? dim(" [archived]") : "";
        console.log(`  ${id}  ${title} ${dim(when)} ${msgs}${archived}`);
    }

    console.log(`  ${dim("─".repeat(75))}`);
    console.log("");
}

export async function sessionsShow(id: string) {
    await ensureServerRunning();
    const client = new PantheonApiClient();

    let session;
    try {
        session = await client.getSession(id);
    } catch {
        console.error(chalk.red(`  Session "${id}" not found.`));
        process.exit(1);
    }

    const messages = await client.getSessionMessages(session.id);

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Session Details")}`);
    console.log(`  ${dim("─".repeat(60))}`);
    console.log(`  ${dim("ID:")}      ${accent(session.id)}`);
    console.log(`  ${dim("Title:")}   ${session.title}`);
    console.log(`  ${dim("Created:")} ${new Date(session.createdAt).toLocaleString()}`);
    console.log(`  ${dim("Updated:")} ${new Date(session.updatedAt).toLocaleString()}`);
    console.log(`  ${dim("Model:")}   ${session.modelId ?? dim("(auto)")}`);
    console.log(`  ${dim("Status:")}  ${session.isArchived ? dim("archived") : chalk.green("active")}`);
    console.log(`  ${dim("Messages:")} ${messages.length}`);

    if (messages.length > 0) {
        console.log(`\n  ${dim("─".repeat(60))}`);
        console.log(`  ${dim("Last exchange:")}`);
        const last = messages.filter((m) => m.role === "user" || m.role === "assistant").slice(-2);
        for (const m of last) {
            const label = m.role === "user" ? chalk.hex("#56B6C2")("User") : chalk.hex("#F5A623")("Pantheon");
            const preview = m.content.replace(/\n/g, " ").slice(0, 120);
            console.log(`  ${label}: ${preview}${m.content.length > 120 ? dim("…") : ""}`);
        }
    }

    console.log("");
}

export async function sessionsDelete(id: string) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
        rl.question(chalk.yellow(`  Permanently delete session ${id.slice(0, 8)}…? [y/N] `), resolve)
    );
    rl.close();

    if (answer.trim().toLowerCase() !== "y") {
        console.log(dim("  Cancelled."));
        return;
    }

    await ensureServerRunning();
    const client = new PantheonApiClient();
    try {
        await client.deleteSession(id);
        console.log(chalk.green(`  ✓ Session deleted.`));
    } catch (err) {
        console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}

export async function sessionsArchive(id: string) {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    try {
        await client.archiveSession(id);
        console.log(chalk.green(`  ✓ Session archived.`));
    } catch (err) {
        console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}
