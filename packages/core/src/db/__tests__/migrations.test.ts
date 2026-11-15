import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { Table } from "drizzle-orm";
import {
    createTestDb,
    rawExecutor,
    getDatabaseStatus,
    TABLE_NAMES,
} from "../client.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations, getSchemaVersion } from "../migrations.js";
import * as sqliteSchema from "../schema.sqlite.js";
import * as pgSchema from "../schema.pg.js";
import { BACKENDS, cleanPgDb } from "./backends.js";

/** table name → { TS property → SQL column name } for a Drizzle schema module. */
function describeSchema(schema: Record<string, unknown>): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const table of Object.values(schema)) {
        const columns = getTableColumns(table as Table);
        out[getTableName(table as Table)] = Object.fromEntries(
            Object.entries(columns).map(([key, col]) => [key, col.name]),
        );
    }
    return out;
}

describe("schema parity", () => {
    it("SQLite and PostgreSQL schemas declare the same tables, properties and column names", () => {
        expect(describeSchema(pgSchema)).toEqual(describeSchema(sqliteSchema));
    });

    it("every schema table is listed in TABLE_NAMES (status, reset and copy rely on it)", () => {
        expect(Object.keys(describeSchema(sqliteSchema)).sort()).toEqual([...TABLE_NAMES].sort());
    });

    it("column nullability and primary keys match between dialects", () => {
        const shape = (schema: Record<string, unknown>) =>
            Object.values(schema).flatMap((table) =>
                Object.values(getTableColumns(table as Table)).map(
                    (c) => `${getTableName(table as Table)}.${c.name} notNull=${c.notNull} pk=${c.primary}`,
                ),
            ).sort();
        expect(shape(pgSchema)).toEqual(shape(sqliteSchema));
    });
});

describe.each(BACKENDS)("migrations [$name]", (backend) => {
    it("brings a fresh database to the latest schema version", async () => {
        const db = await backend.open();
        const status = await getDatabaseStatus(db);
        expect(status.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(status.latestSchemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(status.dialect).toBe(backend.dialect);
        expect(Object.keys(status.tables).sort()).toEqual([...TABLE_NAMES].sort());
        expect(Object.values(status.tables).every((n) => n === 0)).toBe(true);
    });

    it("is idempotent — re-running applies nothing", async () => {
        const db = await backend.open();
        const applied = await runMigrations(rawExecutor(db), backend.dialect);
        expect(applied).toEqual([]);
        expect(await getSchemaVersion(rawExecutor(db))).toBe(LATEST_SCHEMA_VERSION);
    });

    it("records one row per migration", async () => {
        const db = await backend.open();
        const rows = await rawExecutor(db).all<{ version: number }>(
            "SELECT version FROM schema_migrations ORDER BY version",
        );
        expect(rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
    });

    it("refuses a database that is newer than this build", async () => {
        const db = await backend.open();
        const raw = rawExecutor(db);
        await raw.exec(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${LATEST_SCHEMA_VERSION + 1}, 'from the future', 'x')`,
        );
        await expect(runMigrations(raw, backend.dialect)).rejects.toThrow(/Upgrade Pantheon/);
    });

    it("the real tables contain exactly the columns the Drizzle schema declares", async () => {
        const db = await backend.open();
        const raw = rawExecutor(db);
        const declared = describeSchema(backend.dialect === "postgres" ? pgSchema : sqliteSchema);

        for (const [table, columns] of Object.entries(declared)) {
            const actual = backend.dialect === "postgres"
                ? (await raw.all<{ column_name: string }>(
                    `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`,
                )).map((r) => r.column_name)
                : (await raw.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name);
            expect(actual.sort(), `columns of ${table}`).toEqual(Object.values(columns).sort());
        }
    });
});

describe("migrations — upgrading a pre-v0.9 SQLite database", () => {
    /** The schema as v0.7 created it: no schema_migrations, no task_role, no quality_score. */
    function legacyDatabase(): Database.Database {
        const sqlite = new Database(":memory:");
        sqlite.exec(`
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, model_id TEXT, is_archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT,
                created_at TEXT NOT NULL, token_count INTEGER
            );
            CREATE TABLE task_plans (
                plan_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                original_prompt TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE sub_tasks (
                id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL REFERENCES task_plans(plan_id) ON DELETE CASCADE,
                title TEXT NOT NULL, description TEXT NOT NULL, dependencies TEXT,
                status TEXT NOT NULL, result TEXT, error TEXT, agent_id TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE consensus_runs (
                id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                prompt_hash TEXT NOT NULL, synthesized_content TEXT NOT NULL,
                model_responses TEXT NOT NULL, synthesis_latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL
            );
            INSERT INTO sessions VALUES ('s1', 'Old session', '2026-01-01', '2026-01-02', NULL, 0);
            INSERT INTO messages (session_id, role, content, created_at) VALUES ('s1', 'user', 'hello from v0.7', '2026-01-01');
            INSERT INTO task_plans VALUES ('p1', 's1', 'do it', '2026-01-01');
            INSERT INTO sub_tasks VALUES ('t1', 'p1', 'T', 'D', '[]', 'completed', 'ok', NULL, NULL, '2026-01-01');
        `);
        return sqlite;
    }

    it("adds the missing columns and tables without losing data", async () => {
        const sqlite = legacyDatabase();
        const db = createTestDb(sqlite);

        const subTaskCols = (sqlite.prepare("PRAGMA table_info(sub_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
        const consensusCols = (sqlite.prepare("PRAGMA table_info(consensus_runs)").all() as Array<{ name: string }>).map((c) => c.name);
        expect(subTaskCols).toContain("task_role");
        expect(consensusCols).toContain("quality_score");

        const status = await getDatabaseStatus(db);
        expect(status.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(status.tables).toMatchObject({ sessions: 1, messages: 1, task_plans: 1, sub_tasks: 1, ab_runs: 0, spans: 0 });

        const msg = sqlite.prepare("SELECT content FROM messages").get() as { content: string };
        expect(msg.content).toBe("hello from v0.7");
    });

    it("can be opened repeatedly (second open is a no-op)", () => {
        const sqlite = legacyDatabase();
        createTestDb(sqlite);
        expect(() => createTestDb(sqlite)).not.toThrow();
        const versions = sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
        expect(versions.n).toBe(MIGRATIONS.length);
    });
});

describe("PostgreSQL column types", () => {
    it("stores epoch-millisecond timestamps without int4 overflow and booleans as booleans", async () => {
        const db = await cleanPgDb();
        const types = await rawExecutor(db).all<{ table_name: string; column_name: string; data_type: string }>(
            `SELECT table_name, column_name, data_type FROM information_schema.columns
             WHERE (table_name, column_name) IN (
                ('spans','start_time'), ('spans','created_at'), ('agent_nodes','end_time'),
                ('sessions','is_archived'), ('usage_records','cost_usd'), ('messages','id'))`,
        );
        const typeOf = (t: string, c: string) => types.find((r) => r.table_name === t && r.column_name === c)?.data_type;
        expect(typeOf("spans", "start_time")).toBe("bigint");
        expect(typeOf("spans", "created_at")).toBe("bigint");
        expect(typeOf("agent_nodes", "end_time")).toBe("bigint");
        expect(typeOf("sessions", "is_archived")).toBe("boolean");
        expect(typeOf("usage_records", "cost_usd")).toBe("double precision");
        expect(typeOf("messages", "id")).toBe("integer");
    });
});
