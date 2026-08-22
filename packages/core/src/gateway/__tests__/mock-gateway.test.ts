import { describe, it, expect } from "vitest";
import { MockGateway } from "./mock-gateway.js";

describe("MockGateway", () => {
    it("returns queued text responses in order", async () => {
        const mock = new MockGateway();
        mock.addTextResponse("first").addTextResponse("second");

        const r1 = await mock.complete([], "test-model");
        expect(r1.message.content).toBe("first");

        const r2 = await mock.complete([], "test-model");
        expect(r2.message.content).toBe("second");
    });

    it("returns tool call responses", async () => {
        const mock = new MockGateway();
        mock.addToolCallResponse([{ id: "call_1", name: "read_file", arguments: { path: "foo.ts" } }]);

        const r = await mock.complete([], "test-model");
        expect(r.message.toolCalls).toHaveLength(1);
        expect(r.message.toolCalls?.[0]?.name).toBe("read_file");
    });

    it("records all calls made", async () => {
        const mock = new MockGateway();
        mock.addTextResponse("a").addTextResponse("b");

        await mock.complete([{ role: "user", content: "hello" }], "model-x");
        await mock.complete([{ role: "user", content: "world" }], "model-y");

        const calls = mock.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls[0]?.modelId).toBe("model-x");
        expect(calls[1]?.modelId).toBe("model-y");
    });

    it("returns a fallback when queue is empty", async () => {
        const mock = new MockGateway();
        const r = await mock.complete([], "m");
        expect(r.message.content).toContain("no more queued responses");
    });

    it("reset() clears the queue and call log", async () => {
        const mock = new MockGateway();
        mock.addTextResponse("hello");
        await mock.complete([], "m");

        mock.reset();
        expect(mock.pendingCount).toBe(0);
        expect(mock.getCalls()).toHaveLength(0);
    });

    it("resolveRouting() returns standard tier", async () => {
        const mock = new MockGateway();
        const decision = await mock.resolveRouting([]);
        expect(decision.tier).toBe("standard");
    });
});
