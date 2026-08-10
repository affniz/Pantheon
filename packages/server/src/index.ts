// Load .env from the project root before anything else
try { (process as any).loadEnvFile(); } catch { /* no .env — ok */ }

import { serve } from "@hono/node-server";
import { app } from "./app.js";

const PORT = Number(process.env["PORT"] ?? 3000);

const server = serve(
    { fetch: app.fetch, port: PORT },
    (info) => {
        process.stdout.write(`\n  ◆ Pantheon API Server\n`);
        process.stdout.write(`    Listening on http://localhost:${info.port}\n\n`);
    }
);

// Graceful shutdown — close DB connections and in-flight requests cleanly
const shutdown = (signal: string) => {
    process.stdout.write(`\n[server] received ${signal}, shutting down...\n`);
    server.close(() => {
        process.stdout.write("[server] closed.\n");
        process.exit(0);
    });
    // Force-exit after 5 seconds if graceful close hangs
    setTimeout(() => process.exit(1), 5000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
