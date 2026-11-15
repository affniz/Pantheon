/**
 * In-process publish/subscribe for live activity (routing decisions, tool calls,
 * agent lifecycle, orchestration progress).
 *
 * The chat route publishes every event it streams to its own client here as well,
 * so *other* observers — the WebSocket feed at /api/ws, `pantheon agents watch`,
 * a future dashboard — can follow any session in real time without being the
 * client that started it.
 *
 * Scope: one server process. Events are not persisted and not shared between
 * processes; durable history lives in the trace and agent tables.
 */
export interface PantheonEvent {
    /** Event name — same vocabulary as the chat SSE stream (`routing`, `tool_call`, `agent_spawned`, …). */
    type: string;
    /** Chat session the activity belongs to. */
    sessionId: string;
    /** Owner of that session, when it has one. Used to decide who may observe it. */
    userId?: string | undefined;
    /** Epoch milliseconds at publish time. */
    timestamp: number;
    data: unknown;
}

export type EventListener = (event: PantheonEvent) => void;

export class EventBus {
    private listeners = new Set<EventListener>();

    /** Deliver an event to every subscriber. Never throws: a broken observer must not break a chat turn. */
    publish(event: Omit<PantheonEvent, "timestamp"> & { timestamp?: number }): void {
        if (this.listeners.size === 0) return;
        const full: PantheonEvent = { ...event, timestamp: event.timestamp ?? Date.now() };
        // Copy: a listener may unsubscribe (or subscribe another) while being notified
        for (const listener of [...this.listeners]) {
            try {
                listener(full);
            } catch (err) {
                process.stderr.write(`[events] listener failed: ${err instanceof Error ? err.message : String(err)}\n`);
            }
        }
    }

    /** Register a listener; returns the function that removes it. */
    subscribe(listener: EventListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    get listenerCount(): number {
        return this.listeners.size;
    }
}

/** The process-wide bus. */
export const eventBus = new EventBus();
