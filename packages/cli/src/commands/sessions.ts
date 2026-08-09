import chalk from "chalk";
import * as readline from "node:readline";
import { SessionManager } from "@pantheon/core";

// Brand colors matching theme.ts
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");
const dim = chalk.hex("#6B7280");
const muted = chalk.hex("#4B5563");
const success = chalk.hex("#4ADE80");
const warning = chalk.hex("#FBBF24");
const border = chalk.hex("#3A3A3A");

const BRAND_MARK = `${brand.bold("◆")} ${brand("Pantheon")}`;
const HR = border("─".repeat(50));

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

export function sessionsList(opts: { num?: string; all?: boolean }) {
    const manager = new SessionManager();
    const limit = opts.num ? parseInt(opts.num, 10) : 10;
    const sessions = manager.list({ limit, includeArchived: opts.all ?? false });

    console.log(`\n  ${BRAND_MARK} ${dim("— Sessions")}\n`);
    console.log(`  ${HR}\n`);

    if (sessions.length === 0) {
        console.log(`  ${dim("No sessions yet. Start one with")} ${accent("pantheon chat")}\n`);
        return;
    }

    for (const session of sessions) {
        const shortId = dim(session.id.slice(0, 8));
        const time = muted(timeAgo(session.createdAt));
        const msgs = muted(`${session.messageCount ?? 0} msgs`);
        const archived = session.isArchived ? ` ${warning("[archived]")}` : "";

        // Truncate title to fit terminal
        const maxTitleLen = Math.min(40, (process.stdout.columns || 80) - 45);
        const title = session.title.length > maxTitleLen
            ? session.title.slice(0, maxTitleLen - 1) + "…"
            : session.title.padEnd(maxTitleLen);

        console.log(`  ${brand("◆")} ${chalk.white(title)}${archived}  ${shortId}  ${time}  ${msgs}`);
    }

    console.log(`\n  ${HR}\n`);
}

export function sessionsShow(id: string) {
    const manager = new SessionManager();

    // Support partial IDs — search for matching session
    let session = manager.get(id);
    if (!session) {
        // Try to match by prefix
        const allSessions = manager.list({ limit: 100, includeArchived: true });
        const match = allSessions.find(s => s.id.startsWith(id));
        if (match) {
            session = manager.get(match.id);
        }
    }

    if (!session) {
        console.log(`\n  ${warning("⚠")} Session not found: ${muted(id)}\n`);
        return;
    }

    console.log(`\n  ${BRAND_MARK} ${dim("— Session Details")}\n`);
    console.log(`  ${HR}\n`);

    const labelWidth = 16;
    const label = (s: string) => accent(s.padEnd(labelWidth));

    console.log(`  ${label("ID")}${chalk.white(session.id)}`);
    console.log(`  ${label("Title")}${chalk.white.bold(session.title)}`);
    console.log(`  ${label("Created")}${chalk.white(new Date(session.createdAt).toLocaleString())}  ${muted(timeAgo(session.createdAt))}`);
    console.log(`  ${label("Updated")}${chalk.white(new Date(session.updatedAt).toLocaleString())}  ${muted(timeAgo(session.updatedAt))}`);
    if (session.modelId) {
        console.log(`  ${label("Model")}${chalk.white(session.modelId)}`);
    }
    console.log(`  ${label("Messages")}${chalk.white(String(session.messageCount ?? 0))}`);
    console.log(`  ${label("Archived")}${session.isArchived ? warning("yes") : dim("no")}`);

    console.log(`\n  ${HR}\n`);
}

export async function sessionsDelete(id: string) {
    const manager = new SessionManager();

    // Support partial IDs — search for matching session
    let session = manager.get(id);
    if (!session) {
        const allSessions = manager.list({ limit: 100, includeArchived: true });
        const match = allSessions.find(s => s.id.startsWith(id));
        if (match) {
            session = manager.get(match.id);
        }
    }

    if (!session) {
        console.log(`\n  ${warning("⚠")} Session not found: ${muted(id)}\n`);
        return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    await new Promise<void>((resolve) => {
        rl.question(`  ${warning("⚠")} Delete "${session.title}"? This cannot be undone. ${dim("(y/N)")} `, (answer) => {
            rl.close();
            if (answer.trim().toLowerCase() === "y") {
                manager.delete(session.id);
                console.log(`  ${success("✓")} Session deleted.\n`);
            } else {
                console.log(`  ${dim("Cancelled.")}\n`);
            }
            resolve();
        });
    });
}

export function sessionsArchive(id: string) {
    const manager = new SessionManager();

    // Support partial IDs — search for matching session
    let session = manager.get(id);
    if (!session) {
        const allSessions = manager.list({ limit: 100, includeArchived: true });
        const match = allSessions.find(s => s.id.startsWith(id));
        if (match) {
            session = manager.get(match.id);
        }
    }

    if (!session) {
        console.log(`\n  ${warning("⚠")} Session not found: ${muted(id)}\n`);
        return;
    }

    if (session.isArchived) {
        console.log(`\n  ${dim("Session is already archived.")}\n`);
        return;
    }

    manager.archive(session.id);
    console.log(`\n  ${success("✓")} Session "${session.title}" archived.\n`);
}
