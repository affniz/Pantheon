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

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_records_session_id ON usage_records(session_id);
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
