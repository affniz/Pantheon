/**
 * Versioned schema migrations for both supported backends.
 *
 * The DDL is written once and rendered per dialect, so SQLite and PostgreSQL can
 * never drift structurally. Applied versions are recorded in `schema_migrations`;
 * `runMigrations()` is idempotent and safe to call on every startup.
 *
 * Adding a migration: append an entry to MIGRATIONS with the next version number.
 * Never edit or reorder an entry that has already shipped.
 */

export type Dialect = "sqlite" | "postgres";

/** Minimal raw-SQL surface the migration runner needs from an asynchronous driver. */
export interface RawExecutor {
    /** Execute one or more statements; no result. */
    exec(sql: string): Promise<void>;
    /** Run a single query and return its rows. */
    all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}

/** Same surface for a synchronous driver (better-sqlite3). */
export interface SyncRawExecutor {
    exec(sql: string): void;
    all<T = Record<string, unknown>>(sql: string): T[];
}

/**
 * A migration step. Migrations are generators that *yield* the SQL they want run
 * and receive the rows back, so the very same definition can be driven by a
 * synchronous driver (SQLite, inside `getDb()`) or an asynchronous one (Postgres).
 */
type Op = { exec: string } | { all: string };
type Rows = Array<Record<string, unknown>>;
type Steps<T = void> = Generator<Op, T, Rows>;

interface Migration {
    version: number;
    name: string;
    up(dialect: Dialect): Steps;
}

/** Physical column types that differ between the two dialects. */
function types(dialect: Dialect) {
    const pg = dialect === "postgres";
    return {
        autoId: pg ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT",
        /** Epoch milliseconds — exceeds int4, so BIGINT on Postgres. */
        epochMs: pg ? "BIGINT" : "INTEGER",
        float: pg ? "DOUBLE PRECISION" : "REAL",
        bool: (dflt: boolean) =>
            pg ? `BOOLEAN NOT NULL DEFAULT ${dflt ? "TRUE" : "FALSE"}` : `INTEGER NOT NULL DEFAULT ${dflt ? 1 : 0}`,
    };
}

/** The complete v0.8 schema, expressed as idempotent CREATE … IF NOT EXISTS statements. */
export function baselineDDL(dialect: Dialect): string {
    const t = types(dialect);
    return `
    CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        model_id    TEXT,
        is_archived ${t.bool(false)}
    );

    CREATE TABLE IF NOT EXISTS messages (
        id            ${t.autoId},
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        tool_calls    TEXT,
        tool_call_id  TEXT,
        created_at    TEXT NOT NULL,
        token_count   INTEGER
    );

    CREATE TABLE IF NOT EXISTS usage_records (
        id            ${t.autoId},
        session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        timestamp     TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd      ${t.float} NOT NULL,
        prompt_preview TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_summaries (
        id          ${t.autoId},
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
        start_time      ${t.epochMs} NOT NULL,
        end_time        ${t.epochMs} NOT NULL,
        duration_ms     INTEGER NOT NULL,
        status          TEXT NOT NULL,
        error_message   TEXT,
        attributes      TEXT,
        created_at      ${t.epochMs} NOT NULL
    );

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
        start_time      ${t.epochMs} NOT NULL,
        end_time        ${t.epochMs},
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
        task_role       TEXT,
        status          TEXT NOT NULL,
        result          TEXT,
        error           TEXT,
        agent_id        TEXT,
        created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installed_plugins (
        name          TEXT PRIMARY KEY,
        version       TEXT NOT NULL,
        source        TEXT NOT NULL,
        installed_at  ${t.epochMs} NOT NULL,
        enabled       ${t.bool(true)},
        config        TEXT,
        directory     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consensus_runs (
        id                    TEXT PRIMARY KEY,
        session_id            TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_hash           TEXT NOT NULL,
        synthesized_content   TEXT NOT NULL,
        model_responses       TEXT NOT NULL,
        synthesis_latency_ms  INTEGER NOT NULL,
        quality_score         ${t.float},
        created_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ab_runs (
        id              TEXT PRIMARY KEY,
        experiment_id   TEXT NOT NULL,
        session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_hash     TEXT NOT NULL,
        arm             TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        latency_ms      INTEGER NOT NULL,
        input_tokens    INTEGER NOT NULL,
        output_tokens   INTEGER NOT NULL,
        quality_score   ${t.float},
        created_at      TEXT NOT NULL
    );
    `;
}

const BASELINE_INDEXES = `
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_records_session_id ON usage_records(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_spans_session_id ON spans(session_id);
    CREATE INDEX IF NOT EXISTS idx_spans_start_time ON spans(start_time);
    CREATE INDEX IF NOT EXISTS idx_agent_nodes_session_id ON agent_nodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_nodes_parent ON agent_nodes(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_task_plans_session_id ON task_plans(session_id);
    CREATE INDEX IF NOT EXISTS idx_sub_tasks_plan_id ON sub_tasks(plan_id);
    CREATE INDEX IF NOT EXISTS idx_installed_plugins_enabled ON installed_plugins(enabled);
    CREATE INDEX IF NOT EXISTS idx_consensus_runs_session_id ON consensus_runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_ab_runs_experiment_id ON ab_runs(experiment_id);
    CREATE INDEX IF NOT EXISTS idx_ab_runs_session_id ON ab_runs(session_id);
`;

/**
 * Columns that were added to already-shipped tables between v0.6 and v0.8 using
 * swallow-the-error ALTER TABLEs. SQLite databases created by those versions may be
 * missing them, so the baseline adds whichever are absent.
 */
const LEGACY_SQLITE_COLUMNS: Array<{ table: string; column: string; type: string }> = [
    { table: "sub_tasks", column: "task_role", type: "TEXT" },
    { table: "consensus_runs", column: "quality_score", type: "REAL" },
];

/**
 * ALTER TABLE … ADD COLUMN, skipped when the column is already there. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and a migration interrupted between its ALTER and the
 * version bookkeeping must be safe to run again.
 */
function* addColumnIfMissing(dialect: Dialect, table: string, column: string, definition: string): Steps {
    const rows = dialect === "sqlite"
        ? yield { all: `PRAGMA table_info(${table})` }
        : yield { all: `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}'` };
    if (!rows.some((r) => r["name"] === column)) {
        yield { exec: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};` };
    }
}

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        name: "baseline (v0.8 schema)",
        *up(dialect) {
            yield { exec: baselineDDL(dialect) };
            if (dialect === "sqlite") {
                for (const { table, column, type } of LEGACY_SQLITE_COLUMNS) {
                    yield* addColumnIfMissing(dialect, table, column, type);
                }
            }
            yield { exec: BASELINE_INDEXES };
        },
    },
    {
        version: 2,
        name: "index spans.created_at for retention pruning",
        *up() {
            yield { exec: "CREATE INDEX IF NOT EXISTS idx_spans_created_at ON spans(created_at);" };
        },
    },
    {
        version: 3,
        name: "auth: users, api_tokens, sessions.user_id",
        *up(dialect) {
            yield {
                exec: `
    CREATE TABLE IF NOT EXISTS users (
        id                TEXT PRIMARY KEY,
        email             TEXT NOT NULL UNIQUE,
        name              TEXT,
        provider          TEXT NOT NULL,
        provider_user_id  TEXT NOT NULL,
        role              TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        last_login_at     TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_identity ON users(provider, provider_user_id);

    CREATE TABLE IF NOT EXISTS api_tokens (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        token_hash    TEXT NOT NULL UNIQUE,
        token_prefix  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT,
        expires_at    TEXT,
        revoked_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
    `,
            };
            // Sessions created before auth existed (or with auth off) have no owner.
            yield* addColumnIfMissing(dialect, "sessions", "user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL");
            yield { exec: "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);" };
        },
    },
    {
        version: 4,
        name: "semantic memory: memory_chunks",
        *up(dialect) {
            // The embedding is stored as JSON text so the table is identical on both
            // backends (and survives `pantheon db migrate`). On PostgreSQL with the
            // pgvector extension, MemoryStore adds and maintains a native `vector`
            // column next to it at runtime — see memory/memory-store.ts.
            yield {
                exec: `
    CREATE TABLE IF NOT EXISTS memory_chunks (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id       INTEGER NOT NULL,
        chunk_index      INTEGER NOT NULL,
        role             TEXT NOT NULL,
        content          TEXT NOT NULL,
        embedding        TEXT NOT NULL,
        embedding_model  TEXT NOT NULL,
        dimensions       INTEGER NOT NULL,
        created_at       ${types(dialect).epochMs} NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_session_id ON memory_chunks(session_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_model ON memory_chunks(embedding_model, created_at);
    `,
            };
        },
    },
];

/** Highest schema version this build knows about. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const CREATE_MIGRATIONS_TABLE =
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);";

/** Read the applied schema version (0 = nothing applied yet). */
function* readVersion(): Steps<number> {
    yield { exec: CREATE_MIGRATIONS_TABLE };
    const rows = yield { all: "SELECT MAX(version) AS v FROM schema_migrations" };
    return Number(rows[0]?.["v"] ?? 0);
}

/**
 * Apply every migration newer than the database's recorded version; returns the
 * versions applied (empty when up to date).
 *
 * A database whose recorded version is newer than this build's is rejected —
 * running old code against a newer schema silently corrupts data.
 */
function* migrate(dialect: Dialect): Steps<number[]> {
    const current = yield* readVersion();
    if (current > LATEST_SCHEMA_VERSION) {
        throw new Error(
            `Database schema is at version ${current}, but this build of Pantheon only supports up to ` +
            `version ${LATEST_SCHEMA_VERSION}. Upgrade Pantheon before using this database.`,
        );
    }

    const applied: number[] = [];
    for (const migration of MIGRATIONS) {
        if (migration.version <= current) continue;
        yield* migration.up(dialect);
        const name = migration.name.replace(/'/g, "''");
        yield {
            exec: `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${name}', '${new Date().toISOString()}');`,
        };
        applied.push(migration.version);
    }
    return applied;
}

async function drive<T>(steps: Steps<T>, exec: RawExecutor): Promise<T> {
    let next = steps.next();
    while (!next.done) {
        const op = next.value;
        try {
            if ("exec" in op) {
                await exec.exec(op.exec);
                next = steps.next([]);
            } else {
                next = steps.next(await exec.all(op.all));
            }
        } catch (err) {
            steps.return(undefined as never);
            throw err;
        }
    }
    return next.value;
}

function driveSync<T>(steps: Steps<T>, exec: SyncRawExecutor): T {
    let next = steps.next();
    while (!next.done) {
        const op = next.value;
        if ("exec" in op) {
            exec.exec(op.exec);
            next = steps.next([]);
        } else {
            next = steps.next(exec.all(op.all));
        }
    }
    return next.value;
}

/** Schema version currently applied to the database (0 = nothing applied yet). */
export function getSchemaVersion(exec: RawExecutor): Promise<number> {
    return drive(readVersion(), exec);
}

/** Bring an asynchronous backend up to date. Idempotent; safe on every startup. */
export function runMigrations(exec: RawExecutor, dialect: Dialect): Promise<number[]> {
    return drive(migrate(dialect), exec);
}

/** Bring a synchronous backend (better-sqlite3) up to date. Idempotent. */
export function runMigrationsSync(exec: SyncRawExecutor, dialect: Dialect): number[] {
    return driveSync(migrate(dialect), exec);
}
