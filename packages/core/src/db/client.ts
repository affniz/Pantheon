import Database from "better-sqlite3";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";
import { loadConfig } from "../config/loader.js";
import {
    runMigrations,
    runMigrationsSync,
    getSchemaVersion,
    LATEST_SCHEMA_VERSION,
    type Dialect,
    type RawExecutor,
} from "./migrations.js";

export type { Dialect } from "./migrations.js";

/**
 * The database handle used throughout Pantheon.
 *
 * Pantheon runs on SQLite (default, local-first) or PostgreSQL. Both are driven
 * through one statically-typed handle: the type is the SQLite Drizzle database, and
 * a PostgreSQL handle is presented under the same type. That is sound because
 *   • the two schemas produce identical row types (see schema.pg.ts), and
 *   • stores only use the query-builder surface the dialects share, always `await`
 *     the builder (never the SQLite-only `.run()` / `.all()` / `.get()`), and get
 *     their table objects from `tablesFor(db)` rather than importing a schema.
 * The store test-suite runs against both backends to keep this honest.
 */
export type PantheonDatabase = BetterSQLite3Database<typeof sqliteSchema>;

/** Table objects for the dialect a handle is connected to (typed as the SQLite schema). */
export type Tables = typeof sqliteSchema;

/** Where the database lives. */
export type DatabaseTarget =
    | { dialect: "sqlite"; path: string }
    | { dialect: "postgres"; url: string };

interface DbMeta {
    dialect: Dialect;
    tables: Tables;
    target: DatabaseTarget;
    raw: RawExecutor;
    /** Run migrations (serialised across processes where the backend supports it). */
    migrate(): Promise<number[]>;
    close(): Promise<void>;
}

const META = new WeakMap<object, DbMeta>();

function meta(db: PantheonDatabase): DbMeta {
    const m = META.get(db);
    if (!m) {
        throw new Error("Unknown database handle — create it with getDb(), openDatabase() or createTestDb().");
    }
    return m;
}

/** Table objects matching the dialect of `db`. Always use this instead of importing a schema file. */
export function tablesFor(db: PantheonDatabase): Tables {
    return meta(db).tables;
}

/** Which backend `db` is connected to. */
export function dialectOf(db: PantheonDatabase): Dialect {
    return meta(db).dialect;
}

/** Raw-SQL escape hatch for `db` (migrations, diagnostics, sequence fix-ups). */
export function rawExecutor(db: PantheonDatabase): RawExecutor {
    return meta(db).raw;
}

// ─── Target resolution ───────────────────────────────────────────────────────

function isPostgresUrl(url: string): boolean {
    return /^postgres(ql)?:\/\//i.test(url);
}

/** Parse a user-supplied location: a postgres:// URL, a sqlite:/file: URL, or a plain file path. */
export function parseDatabaseTarget(location: string): DatabaseTarget {
    const value = location.trim();
    if (isPostgresUrl(value)) return { dialect: "postgres", url: value };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^(sqlite|file):/i.test(value)) {
        throw new Error(
            `Unsupported database URL "${redactUrl(value)}". Use postgres://… for PostgreSQL or a file path for SQLite.`,
        );
    }
    let filePath = value.replace(/^(sqlite|file):(\/\/)?/i, "");
    if (filePath.startsWith("~")) filePath = path.join(os.homedir(), filePath.slice(1));
    return { dialect: "sqlite", path: path.resolve(filePath) };
}

/** Default SQLite location: ~/.pantheon/pantheon.db */
export function defaultSqlitePath(): string {
    return path.join(os.homedir(), ".pantheon", "pantheon.db");
}

/**
 * Decide which database Pantheon should use.
 *
 * Precedence: `DATABASE_URL` env → `database.url` in config.yml → `PANTHEON_DB_PATH` env
 * → `database.sqlitePath` in config.yml → `~/.pantheon/pantheon.db`.
 */
export function resolveDatabaseTarget(): DatabaseTarget {
    const envUrl = process.env["DATABASE_URL"]?.trim();
    if (envUrl) return parseDatabaseTarget(envUrl);

    let cfg: ReturnType<typeof loadConfig>["database"];
    try {
        cfg = loadConfig().database;
    } catch {
        cfg = undefined; // an unreadable config must not take the database down with it
    }
    if (cfg?.url?.trim()) return parseDatabaseTarget(cfg.url);

    const envPath = process.env["PANTHEON_DB_PATH"]?.trim();
    if (envPath) return parseDatabaseTarget(envPath);
    if (cfg?.sqlitePath?.trim()) return parseDatabaseTarget(cfg.sqlitePath);

    return { dialect: "sqlite", path: defaultSqlitePath() };
}

/** Hide the password in a connection URL so it is safe to print. */
export function redactUrl(url: string): string {
    // user:password@ — the password runs to the last "@" before the host, and cannot
    // contain an unencoded "/" (so a "@" later in the path or query is left alone).
    return url.replace(/(\/\/[^:/@]+):[^/]*@/, "$1:***@");
}

/** Human-readable, credential-free description of a target. */
export function describeTarget(target: DatabaseTarget): string {
    return target.dialect === "postgres" ? redactUrl(target.url) : target.path;
}

// ─── Opening handles ─────────────────────────────────────────────────────────

function wrapSqlite(sqlite: Database.Database, target: DatabaseTarget): PantheonDatabase {
    sqlite.pragma("foreign_keys = ON");
    const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
    const raw: RawExecutor = {
        async exec(sql) {
            sqlite.exec(sql);
        },
        async all<T>(sql: string) {
            return sqlite.prepare(sql).all() as T[];
        },
    };
    META.set(db, {
        dialect: "sqlite",
        tables: sqliteSchema,
        target,
        raw,
        async migrate() {
            migrateSqliteSync(sqlite);
            return [];
        },
        async close() {
            if (sqlite.open) sqlite.close();
        },
    });
    return db;
}

/**
 * better-sqlite3 is synchronous, so SQLite migrations run without awaiting.
 * This keeps `getDb()` / `createTestDb()` synchronous for the default backend.
 */
function migrateSqliteSync(sqlite: Database.Database): void {
    runMigrationsSync(
        {
            exec: (sql) => void sqlite.exec(sql),
            all: <T>(sql: string) => sqlite.prepare(sql).all() as T[],
        },
        "sqlite",
    );
}

function openSqlite(target: Extract<DatabaseTarget, { dialect: "sqlite" }>): PantheonDatabase {
    if (target.path !== ":memory:") fs.mkdirSync(path.dirname(target.path), { recursive: true });
    const sqlite = new Database(target.path);
    if (target.path !== ":memory:") sqlite.pragma("journal_mode = WAL");
    // The server and CLI (`pantheon db …`, `doctor`) may have the file open at once;
    // wait for a competing writer instead of failing immediately with SQLITE_BUSY.
    sqlite.pragma("busy_timeout = 5000");
    return wrapSqlite(sqlite, target);
}

/** Arbitrary constant identifying Pantheon's migration lock in pg_advisory_lock(). */
const PG_MIGRATION_LOCK_ID = 7_265_110_116; // "pant" in ASCII codes, roughly

function openPostgres(target: Extract<DatabaseTarget, { dialect: "postgres" }>): PantheonDatabase {
    const pool = new pg.Pool({
        connectionString: target.url,
        max: Number(process.env["PANTHEON_DB_POOL_SIZE"] ?? 10),
    });
    // An idle client erroring (server restart, network drop) must not crash the process.
    pool.on("error", (err) => {
        process.stderr.write(`[db] postgres pool error: ${err.message}\n`);
    });

    const db = drizzlePg(pool, { schema: pgSchema }) as unknown as PantheonDatabase;
    const raw: RawExecutor = {
        async exec(sql) {
            await pool.query(sql);
        },
        async all<T>(sql: string) {
            return (await pool.query(sql)).rows as T[];
        },
    };
    META.set(db, {
        dialect: "postgres",
        tables: pgSchema as unknown as Tables,
        target,
        raw,
        async migrate() {
            // One dedicated connection holding an advisory lock, so several server
            // processes starting together cannot run the same migration twice.
            const client = await pool.connect();
            try {
                await client.query(`SELECT pg_advisory_lock(${PG_MIGRATION_LOCK_ID})`);
                try {
                    return await runMigrations(
                        {
                            async exec(sql) {
                                await client.query(sql);
                            },
                            async all<T>(sql: string) {
                                return (await client.query(sql)).rows as T[];
                            },
                        },
                        "postgres",
                    );
                } finally {
                    await client.query(`SELECT pg_advisory_unlock(${PG_MIGRATION_LOCK_ID})`);
                }
            } finally {
                client.release();
            }
        },
        async close() {
            await pool.end();
        },
    });
    return db;
}

/**
 * Open a standalone (non-singleton) connection to `target` and bring its schema up
 * to date. The caller owns the handle and must `closeDatabase()` it.
 * Used by `pantheon db migrate` to hold a source and a destination at once.
 */
export async function openDatabase(target: DatabaseTarget): Promise<PantheonDatabase> {
    const db = target.dialect === "postgres" ? openPostgres(target) : openSqlite(target);
    try {
        await meta(db).migrate();
    } catch (err) {
        await meta(db).close().catch(() => {});
        throw err;
    }
    return db;
}

/** Close a handle obtained from `openDatabase()`. */
export async function closeDatabase(db: PantheonDatabase): Promise<void> {
    await meta(db).close();
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _db: PantheonDatabase | null = null;
let _ready = false;
let _initPromise: Promise<PantheonDatabase> | null = null;

const SPAN_RETENTION_DAYS = 7;

/** Best-effort retention: drop trace spans older than a week. Never throws. */
function pruneOldSpansInBackground(db: PantheonDatabase): void {
    const cutoff = Date.now() - SPAN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    queueMicrotask(() => {
        rawExecutor(db)
            .exec(`DELETE FROM spans WHERE created_at < ${cutoff}`)
            .catch(() => {
                // Pruning failures must never affect the startup path
            });
    });
}

/**
 * Connect to the configured database and apply pending migrations.
 *
 * Call this once at process start (the API server does). It is required for
 * PostgreSQL, whose driver is asynchronous; for SQLite it is optional because
 * `getDb()` can initialise synchronously on first use.
 */
export function initDb(): Promise<PantheonDatabase> {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        if (_db && _ready) return _db;
        const target = resolveDatabaseTarget();
        // SQLite initialises synchronously; going through getDb() means a concurrent
        // getDb() call can never open a second handle to the same file.
        if (target.dialect === "sqlite") return getDb();
        const db = await openDatabase(target);
        _db = db;
        _ready = true;
        pruneOldSpansInBackground(db);
        return db;
    })();
    // A failed init (e.g. Postgres not up yet) must be retryable.
    _initPromise.catch(() => {
        _initPromise = null;
    });
    return _initPromise;
}

/**
 * Returns the singleton database handle.
 *
 * SQLite is opened and migrated on first call. PostgreSQL cannot be initialised
 * synchronously, so `await initDb()` must have completed first.
 */
export function getDb(): PantheonDatabase {
    if (_db && _ready) return _db;

    const target = resolveDatabaseTarget();
    if (target.dialect === "postgres") {
        throw new Error(
            "PostgreSQL database is not initialised yet — `await initDb()` must complete before the database is used.",
        );
    }

    const db = openSqlite(target);
    try {
        migrateSqliteSync((db as unknown as { $client: Database.Database }).$client);
    } catch (err) {
        void meta(db).close();
        throw err;
    }
    _db = db;
    _ready = true;
    pruneOldSpansInBackground(db);
    return db;
}

/** Close the singleton database connection. Call during graceful shutdown. */
export async function closeDb(): Promise<void> {
    const db = _db;
    _db = null;
    _ready = false;
    _initPromise = null;
    if (db) await meta(db).close();
}

/** Diagnostic snapshot of a database: where it is, its schema version and row counts. */
export interface DatabaseStatus {
    dialect: Dialect;
    location: string;
    schemaVersion: number;
    latestSchemaVersion: number;
    tables: Record<string, number>;
}

/** Table names in foreign-key-safe order (parents before children). */
export const TABLE_NAMES = [
    "users",
    "api_tokens",
    "sessions",
    "messages",
    "memory_chunks",
    "usage_records",
    "session_summaries",
    "spans",
    "agent_nodes",
    "task_plans",
    "sub_tasks",
    "installed_plugins",
    "consensus_runs",
    "ab_runs",
] as const;

export async function getDatabaseStatus(db: PantheonDatabase): Promise<DatabaseStatus> {
    const m = meta(db);
    const tables: Record<string, number> = {};
    for (const name of TABLE_NAMES) {
        const rows = await m.raw.all<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${name}`);
        tables[name] = Number(rows[0]?.n ?? 0);
    }
    return {
        dialect: m.dialect,
        location: describeTarget(m.target),
        schemaVersion: await getSchemaVersion(m.raw),
        latestSchemaVersion: LATEST_SCHEMA_VERSION,
        tables,
    };
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Handles created through the test helpers. They are closed by closeTestDbs()
 * (called from the Vitest setup file after each test file) so that no native
 * better-sqlite3 `Database` is left to be garbage-collected after the test worker's
 * environment is torn down — that late finalizer aborts the Node process
 * ("RemoveEnvironmentCleanupHook ... (env) != nullptr").
 */
const _testHandles = new Set<PantheonDatabase>();

/**
 * Create a migrated SQLite database for tests. Defaults to a fresh in-memory
 * database; pass a `better-sqlite3` instance to keep a raw handle for assertions.
 * Does NOT touch the singleton.
 */
export function createTestDb(sqlite: Database.Database = new Database(":memory:")): PantheonDatabase {
    const db = wrapSqlite(sqlite, { dialect: "sqlite", path: sqlite.name || ":memory:" });
    migrateSqliteSync(sqlite);
    _testHandles.add(db);
    return db;
}

/**
 * Create a migrated in-process PostgreSQL database (PGlite — real Postgres compiled
 * to WASM) for tests. Lets the suite exercise the Postgres dialect with no server.
 * Requires the `@electric-sql/pglite` dev dependency.
 */
export async function createTestPgDb(): Promise<PantheonDatabase> {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    // pgvector is made *available* (as on a server with the package installed); it is
    // only created in a database when something runs CREATE EXTENSION.
    const client = new PGlite({ extensions: { vector } });
    const target: DatabaseTarget = { dialect: "postgres", url: "postgres://pglite/in-memory" };
    const db = drizzlePglite(client, { schema: pgSchema }) as unknown as PantheonDatabase;
    const raw: RawExecutor = {
        async exec(sql) {
            await client.exec(sql);
        },
        async all<T>(sql: string) {
            return (await client.query(sql)).rows as T[];
        },
    };
    META.set(db, {
        dialect: "postgres",
        tables: pgSchema as unknown as Tables,
        target,
        raw,
        migrate: () => runMigrations(raw, "postgres"),
        async close() {
            if (!client.closed) await client.close();
        },
    });
    await runMigrations(raw, "postgres");
    _testHandles.add(db);
    return db;
}

/** Close every handle created via the test helpers. Safe to call repeatedly. */
export async function closeTestDbs(): Promise<void> {
    const handles = [..._testHandles];
    _testHandles.clear();
    for (const db of handles) {
        try {
            await meta(db).close();
        } catch {
            // Already closed or unusable — nothing to do
        }
    }
}
