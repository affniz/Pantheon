import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { UsageRecord } from "@pantheon/shared";

const DB_PATH = path.join(os.homedir(), ".pantheon", "usage.db");

export class CostTracker {
    private db: Database.Database;

    constructor() {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        this.db = new Database(DB_PATH);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_records (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp     TEXT    NOT NULL,
                modelId       TEXT    NOT NULL,
                inputTokens   INTEGER NOT NULL,
                outputTokens  INTEGER NOT NULL,
                costUsd       REAL    NOT NULL,
                promptPreview TEXT    NOT NULL
            )
        `);
    }

    record(usage: Omit<UsageRecord, "id">): void {
        this.db
            .prepare(
                `INSERT INTO usage_records
                 (timestamp, modelId, inputTokens, outputTokens, costUsd, promptPreview)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(
                usage.timestamp,
                usage.modelId,
                usage.inputTokens,
                usage.outputTokens,
                usage.costUsd,
                usage.promptPreview
            );
    }

    getSummary(): { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number } {
        return this.db
            .prepare(
                `SELECT
                    COUNT(*)        AS totalCalls,
                    SUM(inputTokens)  AS totalInputTokens,
                    SUM(outputTokens) AS totalOutputTokens,
                    SUM(costUsd)      AS totalCostUsd
                 FROM usage_records`
            )
            .get() as any;
    }

    getByModel(): Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> {
        const rows = this.db
            .prepare(
                `SELECT
                    modelId,
                    COUNT(*)         AS calls,
                    SUM(inputTokens)  AS inputTokens,
                    SUM(outputTokens) AS outputTokens,
                    SUM(costUsd)      AS costUsd
                 FROM usage_records
                 GROUP BY modelId`
            )
            .all() as any[];

        return Object.fromEntries(rows.map((r) => [r.modelId, r]));
    }

    getRecent(n = 10): UsageRecord[] {
        return this.db
            .prepare(
                `SELECT * FROM usage_records ORDER BY id DESC LIMIT ?`
            )
            .all(n) as UsageRecord[];
    }

    reset(): void {
        this.db.exec(`DELETE FROM usage_records`);
    }
}