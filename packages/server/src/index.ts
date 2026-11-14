// Load .env from the project root before anything else
try { (process as any).loadEnvFile(); } catch { /* no .env — ok */ }

import { serve } from "@hono/node-server";
import { initDb, closeDb, dialectOf, describeTarget, resolveDatabaseTarget, TraceCollector } from "@pantheon/core";
import { app } from "./app.js";

const PORT = Number(process.env["PORT"] ?? 3000);

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

const server = serve(
    { fetch: app.fetch, port: PORT },
    (info) => {
        process.stdout.write(`\n  ◆ Pantheon API Server\n`);
        process.stdout.write(`    Listening on http://localhost:${info.port}\n\n`);
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
