import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema.js";

export type PantheonDatabase = ReturnType<typeof drizzle<typeof schema>>;

// Raw CREATE TABLE statements — we avoid drizzle-kit push for local-first simplicity.
const INIT_SQL = `
    CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        model_id    TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        tool_calls    TEXT,
        tool_call_id  TEXT,
        created_at    TEXT NOT NULL,
        token_count   INTEGER
    );

    CREATE TABLE IF NOT EXISTS usage_records (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        timestamp     TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd      REAL NOT NULL,
        prompt_preview TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_summaries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        summary     TEXT NOT NULL,
        created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spans (
        id              TEXT PRIMARY KEY,
        trace_id        TEXT NOT NULL,
        parent_span_id  TEXT,
        session_id      TEXT,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        start_time      INTEGER NOT NULL,
        end_time        INTEGER NOT NULL,
        duration_ms     INTEGER NOT NULL,
        status          TEXT NOT NULL,
        error_message   TEXT,
        attributes      TEXT,
        created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_records_session_id ON usage_records(session_id);
    CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_spans_session_id ON spans(session_id);

    CREATE TABLE IF NOT EXISTS agent_nodes (
        agent_id        TEXT PRIMARY KEY,
        role            TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        parent_agent_id TEXT,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        task_id         TEXT,
        status          TEXT NOT NULL,
        result          TEXT,
        error           TEXT,
        start_time      INTEGER NOT NULL,
        end_time        INTEGER,
        created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_plans (
        plan_id         TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        original_prompt TEXT NOT NULL,
        created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sub_tasks (
        id              TEXT PRIMARY KEY,
        plan_id         TEXT NOT NULL REFERENCES task_plans(plan_id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL,
        dependencies    TEXT,
        status          TEXT NOT NULL,
        result          TEXT,
        error           TEXT,
        agent_id        TEXT,
        created_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_nodes_session_id ON agent_nodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_nodes_parent ON agent_nodes(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_task_plans_session_id ON task_plans(session_id);
    CREATE INDEX IF NOT EXISTS idx_sub_tasks_plan_id ON sub_tasks(plan_id);
`;

let _db: PantheonDatabase | null = null;
let _sqlite: Database.Database | null = null;

/**
 * Returns the path to the Pantheon database file.
 * Creates the parent directory if it doesn't exist.
 */
function getDbPath(): string {
    const dir = path.join(os.homedir(), ".pantheon");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "pantheon.db");
}

/**
 * Returns the singleton Drizzle database instance.
 * Initializes the database and creates tables on first call.
 */
export function getDb(): PantheonDatabase {
    if (_db) return _db;

    const dbPath = getDbPath();
    _sqlite = new Database(dbPath);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("foreign_keys = ON");
    _sqlite.exec(INIT_SQL);

    _db = drizzle(_sqlite, { schema });

    // Background pruning: delete trace spans older than 7 days.
    // Runs via queueMicrotask so it never blocks the getDb() caller.
    // Raw SQL is used here to avoid a circular import with TraceStore.
    queueMicrotask(() => {
        try {
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const result = _sqlite!.prepare(
                "DELETE FROM spans WHERE created_at < ?"
            ).run(cutoff);
            if (result.changes > 0) {
                process.stderr.write(`[db] pruned ${result.changes} old trace span(s)\n`);
            }
        } catch {
            // Best-effort — pruning failures must never crash the startup path
        }
    });

    return _db;
}

/**
 * Create a Drizzle database instance for testing with a custom SQLite instance.
 * Does NOT use the singleton — each call returns a fresh instance.
 */
export function createTestDb(sqlite: Database.Database): PantheonDatabase {
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(INIT_SQL);
    return drizzle(sqlite, { schema });
}

/**
 * Close the singleton database connection.
 * Call this during graceful shutdown.
 */
export function closeDb(): void {
    if (_sqlite) {
        _sqlite.close();
        _sqlite = null;
        _db = null;
    }
}
