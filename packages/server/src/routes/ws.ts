import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { eventBus, type PantheonEvent } from "@pantheon/core";
import { PANTHEON_VERSION } from "@pantheon/shared";
import { scopeUserId } from "../middleware/auth.js";

/** Drop a client that has this much unsent data queued — it is not keeping up. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Protocol-level ping interval; detects half-open connections (laptop lid closed, NAT timeout). */
const HEARTBEAT_MS = 30_000;

/** Token deltas are high-volume and only useful to the client rendering the reply. */
const DEFAULT_EXCLUDED = new Set(["text"]);

/** Open connections, so shutdown can close them instead of waiting on them. */
const openSockets = new Set<{ close(code?: number, reason?: string): void }>();

/** Close every WebSocket client (graceful shutdown). */
export function closeAllWebSockets(): void {
    for (const ws of openSockets) {
        try {
            ws.close(1001, "server shutting down");
        } catch {
            // already gone
        }
    }
    openSockets.clear();
}

export interface Subscription {
    /** Only events of this session; undefined = every session the user may see. */
    sessionId: string | undefined;
    /** Only these event types; undefined = all except `text`. */
    types: Set<string> | undefined;
    /** Only sessions owned by this user (or ownerless); undefined when auth is off. */
    userId: string | undefined;
}

export function matches(sub: Subscription, event: PantheonEvent): boolean {
    if (sub.userId !== undefined && event.userId !== undefined && event.userId !== sub.userId) return false;
    if (sub.sessionId !== undefined && event.sessionId !== sub.sessionId) return false;
    return sub.types ? sub.types.has(event.type) : !DEFAULT_EXCLUDED.has(event.type);
}

function parseTypes(raw: string | undefined): Set<string> | undefined {
    const list = raw?.split(",").map((t) => t.trim()).filter(Boolean);
    return list && list.length > 0 ? new Set(list) : undefined;
}

/**
 * Registers `GET /api/ws` — a WebSocket feed of live activity.
 *
 *   ws://host/api/ws?sessionId=<id>&types=agent_spawned,agent_completed
 *
 * Authentication is the same as for the rest of the API (the auth middleware runs
 * on the upgrade request). Browsers cannot set headers on a WebSocket, so the
 * token may also be passed as `?access_token=…`, or the session cookie is used.
 *
 * Server → client: one JSON object per message
 *   { type: "connected", version, sessionId?, types? }
 *   { type: <event>, sessionId, timestamp, data }            (see PantheonEvent)
 *   { type: "pong" } / { type: "subscribed", … } / { type: "error", message }
 *
 * Client → server (optional):
 *   { action: "subscribe", sessionId?: string | null, types?: string[] | null }
 *   { action: "ping" }
 *
 * Returns `injectWebSocket`, which must be called with the HTTP server.
 */
export function registerWebSocket(app: Hono): (server: Parameters<ReturnType<typeof createNodeWebSocket>["injectWebSocket"]>[0]) => void {
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

    app.get(
        "/api/ws",
        upgradeWebSocket((c) => {
            const sub: Subscription = {
                sessionId: c.req.query("sessionId") || undefined,
                types: parseTypes(c.req.query("types")),
                userId: scopeUserId(c),
            };
            let unsubscribe: (() => void) | undefined;
            let heartbeat: NodeJS.Timeout | undefined;

            const describe = () => ({
                ...(sub.sessionId ? { sessionId: sub.sessionId } : {}),
                ...(sub.types ? { types: [...sub.types] } : {}),
            });

            return {
                onOpen(_evt, ws) {
                    const raw = ws.raw;
                    openSockets.add(ws);
                    const send = (payload: unknown) => {
                        if (ws.readyState !== 1) return; // OPEN
                        if (raw && raw.bufferedAmount > MAX_BUFFERED_BYTES) {
                            ws.close(1013, "client too slow");
                            return;
                        }
                        ws.send(JSON.stringify(payload));
                    };

                    send({ type: "connected", version: PANTHEON_VERSION, ...describe() });
                    unsubscribe = eventBus.subscribe((event) => {
                        if (matches(sub, event)) {
                            send({ type: event.type, sessionId: event.sessionId, timestamp: event.timestamp, data: event.data });
                        }
                    });

                    if (raw) {
                        let alive = true;
                        raw.on("pong", () => {
                            alive = true;
                        });
                        heartbeat = setInterval(() => {
                            if (!alive) {
                                raw.terminate();
                                return;
                            }
                            alive = false;
                            raw.ping();
                        }, HEARTBEAT_MS);
                        heartbeat.unref();
                    }
                },

                onMessage(evt, ws) {
                    let msg: { action?: unknown; sessionId?: unknown; types?: unknown };
                    try {
                        msg = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data));
                    } catch {
                        ws.send(JSON.stringify({ type: "error", message: "Messages must be JSON." }));
                        return;
                    }

                    if (msg.action === "ping") {
                        ws.send(JSON.stringify({ type: "pong" }));
                    } else if (msg.action === "subscribe") {
                        // Filters can be narrowed or widened, but never past what the
                        // authenticated user may see (sub.userId is fixed at connect).
                        if (typeof msg.sessionId === "string") sub.sessionId = msg.sessionId || undefined;
                        else if (msg.sessionId === null) sub.sessionId = undefined;
                        if (Array.isArray(msg.types)) {
                            const types = msg.types.filter((t): t is string => typeof t === "string" && t.length > 0);
                            sub.types = types.length > 0 ? new Set(types) : undefined;
                        } else if (msg.types === null) {
                            sub.types = undefined;
                        }
                        ws.send(JSON.stringify({ type: "subscribed", ...describe() }));
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: 'Unknown action. Use "subscribe" or "ping".' }));
                    }
                },

                onClose(_evt, ws) {
                    openSockets.delete(ws);
                    unsubscribe?.();
                    if (heartbeat) clearInterval(heartbeat);
                },

                onError(_evt, ws) {
                    openSockets.delete(ws);
                    unsubscribe?.();
                    if (heartbeat) clearInterval(heartbeat);
                },
            };
        }),
    );

    return injectWebSocket;
}
