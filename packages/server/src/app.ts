import { Hono } from "hono";
import * as Sentry from "@sentry/node";
import { initSentry, sentryMiddleware } from "./middleware/sentry.js";
import { globalRateLimiter, llmRateLimiter } from "./middleware/rate-limiter.js";
import { requestLogger } from "./middleware/request-logger.js";
import { healthRouter } from "./routes/health.js";
import { chatRouter } from "./routes/chat.js";
import { sessionsRouter } from "./routes/sessions.js";
import { modelsRouter } from "./routes/models.js";
import { costRouter } from "./routes/cost.js";
import { tracesRouter } from "./routes/traces.js";
import { agentsRouter } from "./routes/agents.js";
import { pluginsRouter } from "./routes/plugins.js";

// Initialize Sentry before the app is configured (no-op if SENTRY_DSN is unset)
initSentry();

export const app = new Hono();

// ── Middleware stack (order matters) ─────────────────────────────────────────
app.use("*", sentryMiddleware);
app.use("*", requestLogger);
app.use("*", globalRateLimiter);
app.use("/api/chat/*", llmRateLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.route("/api/health", healthRouter);
app.route("/api/chat", chatRouter);
app.route("/api/sessions", sessionsRouter);
app.route("/api/models", modelsRouter);
app.route("/api/cost", costRouter);
app.route("/api/traces", tracesRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/plugins", pluginsRouter);

// ── Global error handler ─────────────────────────────────────────────────────
app.onError((err, c) => {
    if (process.env["SENTRY_DSN"]) Sentry.captureException(err);
    process.stderr.write(`[server] unhandled error: ${err.message}\n`);
    return c.json({ error: err.message || "Internal server error" }, 500);
});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.notFound((c) => {
    return c.json({ error: `Route ${c.req.method} ${c.req.path} not found` }, 404);
});
