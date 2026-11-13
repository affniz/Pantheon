import { afterAll } from "vitest";
import { closeTestDbs, closeDb } from "./packages/core/src/db/client.js";

/**
 * Close every SQLite handle opened during a test file before its worker context
 * is disposed. better-sqlite3's native `Database` destructor must not run after
 * the Node environment is gone — when it does, Node aborts the whole worker
 * (`RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`),
 * which made the suite fail intermittently.
 */
afterAll(() => {
    closeTestDbs();
    closeDb();
});
