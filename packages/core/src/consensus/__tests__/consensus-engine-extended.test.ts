import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import { ConsensusEngine } from "../consensus-engine.js";
import type { ConsensusConfig, ChatMessage } from "@pantheon/shared";

// ── DB mock ───────────────────────────────────────────────────────────────────
// IMPORTANT: We do NOT reset _testDb in beforeEach here.
// ConsensusEngine calls getDb() during run(). If beforeEach replaced _testDb
// with a fresh DB after the engine already wrote a row, the test would read
// from an empty DB. So we keep one DB alive for the whole test file.
let _testDb: ReturnType<typeof createTestDb> | null = null;

vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_testDb) _testDb = createTestDb(new Database(":memory:"));
            return _testDb;
        },
    };
});

function makeMockGateway(responses: Record<string, string | Error>) {
    return {
        complete: vi.fn(async (messages: ChatMessage[], modelId: string) => {
            const resp = responses[modelId];
            if (resp instanceof Error) throw resp;
            return {
                message: { role: "assistant" as const, content: resp ?? `reply from ${modelId}` },
                usage: { inputTokens: 10, outputTokens: 20 },
            };
        }),
    };
}

const MESSAGES: ChatMessage[] = [{ role: "user", content: "Explain recursion" }];

const BASE_CONFIG: ConsensusConfig = {
    models: ["model-a", "model-b"],
    synthesisModelId: "model-synth",
};

describe("ConsensusEngine (extended)", () => {

    // ── Basic fan-out ─────────────────────────────────────────────────────────

    it("calls each fan-out model exactly once", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "synth" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        await engine.run(MESSAGES);
        const calls = gateway.complete.mock.calls.map(([, modelId]) => modelId);
        expect(calls).toContain("model-a");
        expect(calls).toContain("model-b");
    });

    it("calls synthesis model after fan-out", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "synthesized" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        await engine.run(MESSAGES);
        const calls = gateway.complete.mock.calls.map(([, modelId]) => modelId);
        expect(calls).toContain("model-synth");
    });

    it("returns synthesized content from synthesis model", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "SYNTHESIZED" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES);
        expect(result.synthesizedContent).toBe("SYNTHESIZED");
    });

    it("populates response latencyMs (>= 0)", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "S" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES);
        for (const r of result.responses) {
            expect(r.latencyMs).toBeGreaterThanOrEqual(0);
        }
    });

    it("populates token counts from gateway", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "S" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES);
        const aResp = result.responses.find((r) => r.modelId === "model-a")!;
        expect(aResp.inputTokens).toBe(10);
        expect(aResp.outputTokens).toBe(20);
    });

    // ── Error handling ────────────────────────────────────────────────────────

    it("records error message for failed models", async () => {
        const gateway = makeMockGateway({
            "model-a": new Error("timeout"),
            "model-b": "B",
            "model-synth": "S",
        });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES);
        const failed = result.responses.find((r) => r.modelId === "model-a")!;
        expect(failed.error).toContain("timeout");
        expect(failed.content).toBe("");
    });

    it("sets latencyMs=0 for failed models", async () => {
        const gateway = makeMockGateway({
            "model-a": new Error("fail"),
            "model-b": "B",
            "model-synth": "S",
        });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES);
        const failed = result.responses.find((r) => r.modelId === "model-a")!;
        expect(failed.latencyMs).toBe(0);
    });

    it("uses solo response when only one model succeeds (no synthesis call)", async () => {
        const gateway = makeMockGateway({
            "model-a": new Error("fail"),
            "model-b": "Solo B",
        });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES);
        expect(result.synthesizedContent).toBe("Solo B");
        expect(result.synthesisLatencyMs).toBe(0);
        // synthesis model should NOT be called
        const synthCalls = gateway.complete.mock.calls.filter(([, id]) => id === "model-synth");
        expect(synthCalls).toHaveLength(0);
    });

    it("returns error message when ALL models fail", async () => {
        const gateway = makeMockGateway({
            "model-a": new Error("fail A"),
            "model-b": new Error("fail B"),
        });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES);
        expect(result.synthesizedContent).toBeTruthy();
        // synthesis model should NOT be called
        const synthCalls = gateway.complete.mock.calls.filter(([, id]) => id === "model-synth");
        expect(synthCalls).toHaveLength(0);
    });

    // ── DB persistence ────────────────────────────────────────────────────────

    it("persists run to DB and returns a runId", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "S" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        // No sessionId — consensusRuns.sessionId has a FK to sessions.id,
        // passing a non-existent ID would silently fail inside the engine's try/catch.
        const result = await engine.run(MESSAGES);
        expect(typeof result.runId).toBe("string");
        expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("persists model responses as JSON in DB (no sessionId)", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "S" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES); // no sessionId

        const { schema } = await import("../../db/index.js");
        const db = _testDb!;
        const rows = db.select().from(schema.consensusRuns).all();
        const row = rows.find((r) => r.id === result.runId);
        expect(row).toBeTruthy();
        expect(JSON.parse(row!.modelResponses)).toHaveLength(2);
        expect(row!.synthesisLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("stores sessionId in DB when a valid session exists", async () => {
        // Create a real session first to satisfy the FK constraint
        const { schema } = await import("../../db/index.js");
        const db = _testDb!;
        const realSessionId = "sess-" + Math.random().toString(36).slice(2, 10);
        const now = new Date().toISOString();
        db.insert(schema.sessions).values({
            id: realSessionId,
            title: "test session",
            createdAt: now,
            updatedAt: now,
        }).run();

        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "S" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        const result = await engine.run(MESSAGES, realSessionId);

        const rows = db.select().from(schema.consensusRuns).all();
        const row = rows.find((r) => r.id === result.runId);
        expect(row?.sessionId).toBe(realSessionId);
    });


    // ── Synthesis prompt ──────────────────────────────────────────────────────

    it("passes responses to synthesis model in the prompt", async () => {
        const gateway = makeMockGateway({ "model-a": "AAA answer", "model-b": "BBB answer", "model-synth": "final" });
        const engine = new ConsensusEngine(gateway as any, BASE_CONFIG);
        await engine.run(MESSAGES);

        const synthCall = gateway.complete.mock.calls.find(([, id]) => id === "model-synth")!;
        const synthMessages = synthCall[0] as ChatMessage[];
        const promptText = synthMessages.map((m) => m.content).join(" ");
        expect(promptText).toContain("AAA answer");
        expect(promptText).toContain("BBB answer");
    });

    it("uses custom synthesisPrompt when configured", async () => {
        const gateway = makeMockGateway({ "model-a": "A", "model-b": "B", "model-synth": "S" });
        const customConfig: ConsensusConfig = {
            ...BASE_CONFIG,
            synthesisPrompt: "CUSTOM PROMPT: {{PROMPT}} RESPONSES: {{RESPONSES}}",
        };
        const engine = new ConsensusEngine(gateway as any, customConfig);
        await engine.run(MESSAGES);

        const synthCall = gateway.complete.mock.calls.find(([, id]) => id === "model-synth")!;
        const synthMessages = synthCall[0] as ChatMessage[];
        const systemMsg = synthMessages.find((m) => m.role === "system")!;
        expect(systemMsg.content).toContain("CUSTOM PROMPT:");
        expect(systemMsg.content).toContain("Explain recursion");
    });
});
