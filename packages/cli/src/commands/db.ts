import chalk from "chalk";
import readline from "node:readline";
import {
    openDatabase,
    closeDatabase,
    copyDatabase,
    getDatabaseStatus,
    resolveDatabaseTarget,
    parseDatabaseTarget,
    describeTarget,
    type DatabaseStatus,
    type DatabaseTarget,
} from "@pantheon/core";
import { isServerRunning } from "../server-manager.js";

const dim = chalk.hex("#6B7280");
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");

/**
 * `pantheon db` talks to the database directly rather than through the API
 * server: its whole purpose is to inspect and move the storage the server sits on,
 * including databases the running server is not connected to.
 */

function sameTarget(a: DatabaseTarget, b: DatabaseTarget): boolean {
    if (a.dialect !== b.dialect) return false;
    return a.dialect === "sqlite"
        ? a.path === (b as typeof a).path
        : a.url === (b as typeof a).url;
}

function printStatus(status: DatabaseStatus): void {
    const upToDate = status.schemaVersion === status.latestSchemaVersion;
    console.log(`  ${dim("Backend:")}   ${accent(status.dialect)}`);
    console.log(`  ${dim("Location:")}  ${status.location}`);
    console.log(
        `  ${dim("Schema:")}    v${status.schemaVersion}` +
        (upToDate ? chalk.green("  ✓ up to date") : chalk.yellow(`  (latest is v${status.latestSchemaVersion})`)),
    );
    console.log(`  ${dim("─".repeat(50))}`);
    for (const [table, rows] of Object.entries(status.tables)) {
        console.log(`  ${dim(table.padEnd(22))} ${rows.toLocaleString().padStart(10)}`);
    }
}

function fail(err: unknown): never {
    console.error(chalk.red(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
}

/** pantheon db status [--url <location>] */
export async function dbStatus(opts: { url?: string } = {}): Promise<void> {
    try {
        const target = opts.url ? parseDatabaseTarget(opts.url) : resolveDatabaseTarget();
        const db = await openDatabase(target);
        try {
            const status = await getDatabaseStatus(db);
            console.log("");
            console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Database")}`);
            console.log(`  ${dim("─".repeat(50))}`);
            printStatus(status);
            console.log("");
        } finally {
            await closeDatabase(db);
        }
    } catch (err) {
        fail(err);
    }
}

async function confirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}

/**
 * pantheon db migrate --to <location> [--from <location>] [--yes]
 *
 * Copies every row from the source database (default: the one Pantheon is
 * currently configured to use) into the destination. Works in any direction
 * between SQLite and PostgreSQL. The source is never modified, and re-running
 * after an interruption only copies what is still missing.
 */
export async function dbMigrate(opts: { to: string; from?: string; yes?: boolean }): Promise<void> {
    try {
        const source = opts.from ? parseDatabaseTarget(opts.from) : resolveDatabaseTarget();
        const target = parseDatabaseTarget(opts.to);
        if (sameTarget(source, target)) {
            throw new Error("Source and destination are the same database.");
        }

        console.log("");
        console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Database migration")}`);
        console.log(`  ${dim("─".repeat(50))}`);
        console.log(`  ${dim("From:")} ${accent(source.dialect)}  ${describeTarget(source)}`);
        console.log(`  ${dim("To:")}   ${accent(target.dialect)}  ${describeTarget(target)}`);

        if (await isServerRunning()) {
            console.log(
                chalk.yellow(
                    "\n  ⚠ The Pantheon server is running. Rows written while the copy is in progress\n" +
                    "    may be missed — stop it first (`pantheon server stop`) for a consistent copy.",
                ),
            );
        }

        const src = await openDatabase(source);
        let dst;
        try {
            dst = await openDatabase(target);
        } catch (err) {
            await closeDatabase(src);
            throw err;
        }

        try {
            const before = await getDatabaseStatus(dst);
            const existing = Object.values(before.tables).reduce((a, b) => a + b, 0);
            if (existing > 0 && !opts.yes) {
                console.log(
                    chalk.yellow(
                        `\n  ⚠ The destination already contains ${existing.toLocaleString()} row(s). ` +
                        "Existing rows are kept;\n    only rows whose ids are not present yet will be added.",
                    ),
                );
                if (!process.stdin.isTTY) {
                    throw new Error("Destination is not empty. Re-run with --yes to merge into it.");
                }
                if (!(await confirm("  Continue? [y/N] "))) {
                    console.log(dim("\n  Cancelled.\n"));
                    return;
                }
            }

            console.log("");
            const report = await copyDatabase(src, dst, {
                onTable: (table, r) => {
                    const skipped = r.read - r.inserted;
                    console.log(
                        `  ${chalk.green("✓")} ${table.padEnd(22)} ${String(r.inserted).padStart(8)} copied` +
                        (skipped > 0 ? dim(`  (${skipped} already present)`) : ""),
                    );
                },
            });

            console.log(`  ${dim("─".repeat(50))}`);
            console.log(
                `  ${chalk.green.bold("Done.")} ${report.totalInserted.toLocaleString()} row(s) copied` +
                (report.totalRead !== report.totalInserted
                    ? dim(`, ${(report.totalRead - report.totalInserted).toLocaleString()} skipped`)
                    : ""),
            );

            // Deliberately not echoing the URL back: it may contain a password.
            if (target.dialect === "postgres") {
                console.log(
                    `\n  ${dim("To switch Pantheon to this database, add the same URL to your .env:")}\n` +
                    `    DATABASE_URL=postgres://…\n` +
                    `  ${dim("then restart the server:")} pantheon server stop && pantheon server start`,
                );
            } else {
                console.log(
                    `\n  ${dim("To use this SQLite file, unset DATABASE_URL and set:")}\n` +
                    `    PANTHEON_DB_PATH=${describeTarget(target)}\n` +
                    `  ${dim("then restart the server:")} pantheon server stop && pantheon server start`,
                );
            }
            console.log("");
        } finally {
            await closeDatabase(src);
            await closeDatabase(dst);
        }
    } catch (err) {
        fail(err);
    }
}
