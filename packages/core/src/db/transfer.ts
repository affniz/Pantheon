import { asc, getTableColumns, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { dialectOf, rawExecutor, tablesFor, type PantheonDatabase, type Tables } from "./client.js";

/**
 * Tables in foreign-key-safe copy order, with the primary-key column used for
 * stable paging and whether that key is an auto-incrementing integer.
 */
const COPY_PLAN: Array<{ key: keyof Tables; sqlName: string; pk: string; serial: boolean }> = [
    { key: "sessions", sqlName: "sessions", pk: "id", serial: false },
    { key: "messages", sqlName: "messages", pk: "id", serial: true },
    { key: "usageRecords", sqlName: "usage_records", pk: "id", serial: true },
    { key: "sessionSummaries", sqlName: "session_summaries", pk: "id", serial: true },
    { key: "spans", sqlName: "spans", pk: "id", serial: false },
    { key: "agentNodes", sqlName: "agent_nodes", pk: "agentId", serial: false },
    { key: "taskPlans", sqlName: "task_plans", pk: "planId", serial: false },
    { key: "subTasks", sqlName: "sub_tasks", pk: "id", serial: false },
    { key: "installedPlugins", sqlName: "installed_plugins", pk: "name", serial: false },
    { key: "consensusRuns", sqlName: "consensus_runs", pk: "id", serial: false },
    { key: "abRuns", sqlName: "ab_runs", pk: "id", serial: false },
];

export interface TransferOptions {
    /** Rows read and written per round-trip. Default: 500. */
    batchSize?: number;
    /** Called after each table finishes. */
    onTable?: (table: string, result: { read: number; inserted: number }) => void;
}

export interface TransferReport {
    /** Per-table counts: rows read from the source and rows actually inserted. */
    tables: Record<string, { read: number; inserted: number }>;
    totalRead: number;
    totalInserted: number;
}

/**
 * Copy every row from `source` into `target` (any combination of SQLite and
 * PostgreSQL). This is the v0.9 migration path: `pantheon db migrate --to <url>`.
 *
 * • Both databases must already be at the current schema version (`openDatabase`
 *   guarantees this).
 * • Rows whose primary key already exists in the target are skipped, so an
 *   interrupted copy can simply be re-run and never duplicates data.
 * • Primary keys are preserved; on PostgreSQL the SERIAL sequences are advanced
 *   past the copied ids afterwards so new inserts do not collide.
 * • The source is only read, never modified.
 */
export async function copyDatabase(
    source: PantheonDatabase,
    target: PantheonDatabase,
    options: TransferOptions = {},
): Promise<TransferReport> {
    if (source === target) throw new Error("Source and target databases are the same handle.");

    const batchSize = Math.max(1, options.batchSize ?? 500);
    const src = tablesFor(source);
    const dst = tablesFor(target);
    const report: TransferReport = { tables: {}, totalRead: 0, totalInserted: 0 };

    for (const { key, sqlName, pk, serial } of COPY_PLAN) {
        const srcTable = src[key] as SQLiteTable;
        const dstTable = dst[key] as SQLiteTable;
        const srcPk = (getTableColumns(srcTable) as Record<string, SQLiteColumn>)[pk]!;
        const dstPk = (getTableColumns(dstTable) as Record<string, SQLiteColumn>)[pk]!;

        let read = 0;
        let inserted = 0;
        let cursor: string | number | null = null;

        // Keyset pagination: stable under concurrent writes and O(n) overall,
        // unlike OFFSET which re-scans every skipped row.
        for (;;) {
            const rows = (await source
                .select()
                .from(srcTable)
                .where(cursor === null ? undefined : sql`${srcPk} > ${cursor}`)
                .orderBy(asc(srcPk))
                .limit(batchSize)) as Array<Record<string, unknown>>;
            if (rows.length === 0) break;

            read += rows.length;
            cursor = rows[rows.length - 1]![pk] as string | number;

            const written = (await target
                .insert(dstTable)
                .values(rows)
                .onConflictDoNothing()
                .returning({ pk: dstPk })) as unknown[];
            inserted += written.length;

            if (rows.length < batchSize) break;
        }

        if (serial && dialectOf(target) === "postgres") {
            // Explicit ids do not advance a SERIAL sequence — do it by hand.
            await rawExecutor(target).exec(
                `SELECT setval(pg_get_serial_sequence('${sqlName}', 'id'), ` +
                `GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${sqlName}), 1), ` +
                `(SELECT COUNT(*) > 0 FROM ${sqlName}))`,
            );
        }

        report.tables[sqlName] = { read, inserted };
        report.totalRead += read;
        report.totalInserted += inserted;
        options.onTable?.(sqlName, { read, inserted });
    }

    return report;
}
