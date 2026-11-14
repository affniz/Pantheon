import { afterAll, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
    createTestDb,
    createTestPgDb,
    openDatabase,
    closeDatabase,
    dialectOf,
    rawExecutor,
    TABLE_NAMES,
    type Dialect,
    type PantheonDatabase,
} from "../client.js";

/**
 * The storage backends every store test runs against.
 *
 * • `sqlite`   — in-memory better-sqlite3.
 * • `postgres` — PGlite: real PostgreSQL compiled to WASM, in-process, so the suite
 *                needs no database server locally or in CI.
 * • `postgres-server` — only when `PANTHEON_TEST_POSTGRES_URL` points at a running
 *                server. Exercises the production `pg` driver, whose wire behaviour
 *                differs from PGlite (e.g. COUNT/SUM/BIGINT arrive as strings).
 *                Every handle gets its own throw-away database, dropped afterwards.
 */
export interface Backend {
    name: string;
    dialect: Dialect;
    open(): Promise<PantheonDatabase>;
}

const SERVER_URL = process.env["PANTHEON_TEST_POSTGRES_URL"]?.trim();

const scratchDatabases: Array<{ db: PantheonDatabase; name: string }> = [];

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

async function openScratchServerDb(): Promise<PantheonDatabase> {
    const name = `pantheon_test_${randomUUID().replace(/-/g, "")}`;
    await withAdmin((c) => c.query(`CREATE DATABASE ${name}`));
    const url = new URL(SERVER_URL!);
    url.pathname = `/${name}`;
    const db = await openDatabase({ dialect: "postgres", url: url.toString() });
    scratchDatabases.push({ db, name });
    return db;
}

// Registered on whichever test file imports this module.
afterAll(async () => {
    for (const { db, name } of scratchDatabases.splice(0)) {
        await closeDatabase(db).catch(() => {});
        await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch(() => {});
    }
});

export const BACKENDS: Backend[] = [
    { name: "sqlite", dialect: "sqlite", open: async () => createTestDb() },
    { name: "postgres", dialect: "postgres", open: () => createTestPgDb() },
    ...(SERVER_URL ? [{ name: "postgres-server", dialect: "postgres" as const, open: openScratchServerDb }] : []),
];

/** Remove every row (and reset auto-increment counters) without re-creating the schema. */
export async function resetDb(db: PantheonDatabase): Promise<void> {
    const raw = rawExecutor(db);
    if (dialectOf(db) === "postgres") {
        await raw.exec(`TRUNCATE ${TABLE_NAMES.join(", ")} RESTART IDENTITY CASCADE`);
        return;
    }
    // Children first so foreign keys are never violated
    for (const table of [...TABLE_NAMES].reverse()) {
        await raw.exec(`DELETE FROM ${table}`);
    }
    await raw.exec("DELETE FROM sqlite_sequence");
}

/**
 * Open one database for the enclosing `describe` and empty it before each test.
 * (A fresh PGlite instance per test would dominate the suite's runtime.)
 * Returns a getter because the handle only exists once `beforeAll` has run.
 */
export function useBackend(backend: Backend): () => PantheonDatabase {
    let db: PantheonDatabase;
    beforeAll(async () => {
        db = await backend.open();
    });
    beforeEach(async () => {
        await resetDb(db);
    });
    return () => db;
}

let _sharedPg: Promise<PantheonDatabase> | null = null;

/**
 * An emptied PostgreSQL database, reused across the tests of one file. Booting
 * PGlite costs ~1.5s, so tests that just need "a clean Postgres" should use this
 * rather than opening a new one. Not for tests that alter the schema.
 * Uses the real server when `PANTHEON_TEST_POSTGRES_URL` is set.
 */
export async function cleanPgDb(): Promise<PantheonDatabase> {
    _sharedPg ??= SERVER_URL ? openScratchServerDb() : createTestPgDb();
    const db = await _sharedPg;
    await resetDb(db);
    return db;
}
