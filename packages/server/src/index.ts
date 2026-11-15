// Load .env from the project root before anything else
try { (process as any).loadEnvFile(); } catch { /* no .env — ok */ }

import { serve } from "@hono/node-server";
import { initDb, closeDb, dialectOf, describeTarget, resolveDatabaseTarget, TraceCollector } from "@pantheon/core";
import { app } from "./app.js";
import { getAuthConfig } from "./auth/config.js";
import { jwtSecret } from "./auth/jwt.js";

const PORT = Number(process.env["PORT"] ?? 3000);
/**
 * Listen on localhost only unless told otherwise. The API can run shell commands
 * and read files, so it must not be reachable from the network by accident —
 * set HOST=0.0.0.0 (and PANTHEON_AUTH=required) to expose it deliberately.
 */
const HOST = process.env["HOST"]?.trim() || "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// Connect and migrate before accepting traffic. Required for PostgreSQL (async
// driver); for SQLite it surfaces a bad path or schema problem at boot instead of
// on the first request.
try {
    const db = await initDb();
    process.stdout.write(`[db] ${dialectOf(db)} · ${describeTarget(resolveDatabaseTarget())}\n`);
} catch (err) {
    process.stderr.write(
        `[db] failed to initialise database: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
}

const authConfig = getAuthConfig();
if (authConfig.mode === "required") {
    jwtSecret(); // fail at boot, not on the first sign-in, if PANTHEON_JWT_SECRET is unusable
    const providers = Object.keys(authConfig.providers);
    process.stdout.write(
        `[auth] required · sign-in providers: ${providers.length > 0 ? providers.join(", ") : "none (API tokens only — `pantheon auth token create`)"}\n`,
    );
} else if (!LOOPBACK.has(HOST)) {
    process.stderr.write(
        `[auth] WARNING: listening on ${HOST} with authentication OFF. Anyone who can reach this port can run\n` +
        `       commands and read files through the agent. Set PANTHEON_AUTH=required.\n`,
    );
}

const server = serve(
    { fetch: app.fetch, port: PORT, hostname: HOST },
    (info) => {
        process.stdout.write(`\n  ◆ Pantheon API Server\n`);
        process.stdout.write(`    Listening on http://${LOOPBACK.has(HOST) ? "localhost" : HOST}:${info.port}\n\n`);
    }
);

// Graceful shutdown — stop accepting requests, flush buffered trace spans, then
// close the database (releases the SQLite WAL / returns Postgres connections).
let shuttingDown = false;
const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n[server] received ${signal}, shutting down...\n`);
    // Force-exit after 5 seconds if graceful close hangs
    setTimeout(() => process.exit(1), 5000).unref();
    server.close(() => {
        TraceCollector.flush()
            .then(() => closeDb())
            .catch(() => {})
            .finally(() => {
                process.stdout.write("[server] closed.\n");
                process.exit(0);
            });
    });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
