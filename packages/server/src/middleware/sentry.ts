import * as Sentry from "@sentry/node";
import { createMiddleware } from "hono/factory";

const DSN = process.env["SENTRY_DSN"];

/** Initialize Sentry — only if SENTRY_DSN is set. No-op in local dev. */
export function initSentry() {
    if (!DSN) return;
    Sentry.init({
        dsn: DSN,
        environment: process.env["NODE_ENV"] ?? "development",
        tracesSampleRate: process.env["NODE_ENV"] === "production" ? 0.2 : 1.0,
        beforeSend(event) {
            // Redact any authorization headers before sending to Sentry
            if (event.request?.headers) {
                delete event.request.headers["authorization"];
            }
            return event;
        },
    });
}

/**
 * Hono middleware that captures unhandled exceptions into Sentry.
 * If SENTRY_DSN is not set, this is a transparent pass-through.
 */
export const sentryMiddleware = createMiddleware(async (c, next) => {
    try {
        await next();
    } catch (err) {
        if (DSN) Sentry.captureException(err);
        throw err;
    }
});
