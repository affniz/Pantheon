import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../event-bus.js";

const event = { type: "agent_spawned", sessionId: "s1", data: { n: 1 } };

describe("EventBus", () => {
    it("delivers events to every subscriber, stamping a timestamp", () => {
        const bus = new EventBus();
        const a = vi.fn();
        const b = vi.fn();
        bus.subscribe(a);
        bus.subscribe(b);

        const before = Date.now();
        bus.publish(event);

        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        const received = a.mock.calls[0]![0];
        expect(received).toMatchObject(event);
        expect(received.timestamp).toBeGreaterThanOrEqual(before);
    });

    it("keeps an explicit timestamp", () => {
        const bus = new EventBus();
        const listener = vi.fn();
        bus.subscribe(listener);
        bus.publish({ ...event, timestamp: 42 });
        expect(listener.mock.calls[0]![0].timestamp).toBe(42);
    });

    it("unsubscribe stops delivery and is idempotent", () => {
        const bus = new EventBus();
        const listener = vi.fn();
        const off = bus.subscribe(listener);
        expect(bus.listenerCount).toBe(1);
        off();
        off();
        expect(bus.listenerCount).toBe(0);
        bus.publish(event);
        expect(listener).not.toHaveBeenCalled();
    });

    it("a throwing listener does not stop the others or the publisher", () => {
        const bus = new EventBus();
        const good = vi.fn();
        bus.subscribe(() => {
            throw new Error("observer bug");
        });
        bus.subscribe(good);
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            expect(() => bus.publish(event)).not.toThrow();
            expect(good).toHaveBeenCalledTimes(1);
            expect(String(stderr.mock.calls[0]?.[0])).toContain("observer bug");
        } finally {
            stderr.mockRestore();
        }
    });

    it("a listener may unsubscribe itself during delivery without skipping others", () => {
        const bus = new EventBus();
        const later = vi.fn();
        const off = bus.subscribe(() => off());
        bus.subscribe(later);
        bus.publish(event);
        bus.publish(event);
        expect(later).toHaveBeenCalledTimes(2);
        expect(bus.listenerCount).toBe(1);
    });

    it("publishing with no subscribers is a no-op", () => {
        expect(() => new EventBus().publish(event)).not.toThrow();
    });
});
