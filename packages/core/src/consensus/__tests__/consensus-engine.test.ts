import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import { ConsensusEngine } from "../../consensus/consensus-engine.js";
import type { ConsensusConfig, ChatMessage } from "@pantheon/shared";

// ── DB mock ───────────────────────────────────────────────────────────────────
let _testDb: ReturnType<typeof createTestDb> | null = null;

vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_testDb) {
                _testDb = createTestDb(new Database(":memory:"));
            }
            return _testDb;
        },
    };
});

/** Minimal Gateway mock for consensus tests */
function makeMockGateway(responses: Record<string, string>) {
    return {
        complete: vi.fn(async (messages: ChatMessage[], modelId: string) => {
            const content = responses[modelId] ?? `response from ${modelId}`;
            return {
                message: { role: "assistant" as const, content },
                usage: { inputTokens: 10, outputTokens: 20 },
            };
        }),
    };
}

describe("ConsensusEngine", () => {
    const messages: ChatMessage[] = [
        { role: "user", content: "What is 2+2?" },
    ];

    it("fans out to all configured models", async () => {
        const mockGateway = makeMockGateway({
            "model-a": "4",
            "model-b": "four",
            "model-c": "The answer is 4",
        });

        const config: ConsensusConfig = {
            models: ["model-a", "model-b", "model-c"],
            synthesisModelId: "model-a",
        };

        const engine = new ConsensusEngine(mockGateway as any, config);
        const result = await engine.run(messages);

        // Should have called complete for each model + once for synthesis
        expect(mockGateway.complete).toHaveBeenCalledTimes(4); // 3 fan-out + 1 synthesis
        expect(result.responses).toHaveLength(3);
    });

    it("returns responses for each model with correct modelIds", async () => {
        const mockGateway = makeMockGateway({
            "model-a": "Response A",
            "model-b": "Response B",
            "model-c": "Synthesis",
        });

        const config: ConsensusConfig = {
            models: ["model-a", "model-b"],
            synthesisModelId: "model-c",
        };

        const engine = new ConsensusEngine(mockGateway as any, config);
        const result = await engine.run(messages);

        const modelIds = result.responses.map((r) => r.modelId);
        expect(modelIds).toContain("model-a");
        expect(modelIds).toContain("model-b");
    });

    it("marks a model as errored when it throws", async () => {
        const mockGateway = {
            complete: vi.fn(async (_: ChatMessage[], modelId: string) => {
                if (modelId === "failing-model") {
                    throw new Error("Model unavailable");
                }
                return {
                    message: { role: "assistant" as const, content: "Good response" },
                    usage: { inputTokens: 10, outputTokens: 20 },
                };
            }),
        };

        const config: ConsensusConfig = {
            models: ["failing-model", "good-model"],
            synthesisModelId: "good-model",
        };

        const engine = new ConsensusEngine(mockGateway as any, config);
        const result = await engine.run(messages);

        const failedResponse = result.responses.find((r) => r.modelId === "failing-model");
        expect(failedResponse?.error).toBeDefined();
        expect(failedResponse?.error).toContain("unavailable");
    });

    it("skips synthesis and returns solo response when only one model succeeds", async () => {
        const mockGateway = {
            complete: vi.fn(async (_: ChatMessage[], modelId: string) => {
                if (modelId === "model-b") {
                    throw new Error("fails");
                }
                return {
                    message: { role: "assistant" as const, content: "Solo response" },
                    usage: { inputTokens: 10, outputTokens: 20 },
                };
            }),
        };

        const config: ConsensusConfig = {
            models: ["model-a", "model-b"],
            synthesisModelId: "model-a",
        };

        const engine = new ConsensusEngine(mockGateway as any, config);
        const result = await engine.run(messages);

        // Only 2 calls (model-a fan-out + model-b fan-out attempt), no synthesis
        expect(mockGateway.complete).toHaveBeenCalledTimes(2);
        expect(result.synthesizedContent).toBe("Solo response");
        expect(result.synthesisLatencyMs).toBe(0);
    });

    it("result includes a runId", async () => {
        const mockGateway = makeMockGateway({ "m": "answer", "synth": "synthesized" });
        const config: ConsensusConfig = { models: ["m"], synthesisModelId: "synth" };
        const engine = new ConsensusEngine(mockGateway as any, config);
        const result = await engine.run(messages);
        expect(typeof result.runId).toBe("string");
        expect(result.runId.length).toBeGreaterThan(0);
    });
});
