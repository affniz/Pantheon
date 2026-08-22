import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import { Classifier } from "../classifier.js";
import type { RoutingConfig, ChatMessage } from "@pantheon/shared";

// ── DB mock — redirect getDb() to an in-memory DB so TraceCollector never
// touches the on-disk ~/.pantheon/pantheon.db during tests. ──────────────────
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

describe("Classifier", () => {
    let mockOpenAI: any;
    let config: RoutingConfig;
    let classifier: Classifier;

    beforeEach(() => {
        mockOpenAI = {
            chat: {
                completions: {
                    create: vi.fn()
                }
            }
        };

        config = {
            enabled: true,
            tiers: {
                general:  "model-general",
                simple:   "model-simple",
                standard: "model-standard",
                complex:  "model-complex",
            },
            routingContextDepth: 5,
        };

        classifier = new Classifier(mockOpenAI as any, config);
    });

    it("classifies 'general' response (greetings, Q&A)", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "general" } }]
        });

        const result = await classifier.classify("Hello, how are you?");
        expect(result.tier).toBe("general");
        expect(result.selectedModelId).toBe("model-general");
    });

    it("classifies 'simple' response", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple" } }]
        });

        const result = await classifier.classify("Write a function to add two numbers");
        expect(result.tier).toBe("simple");
        expect(result.selectedModelId).toBe("model-simple");
    });

    it("classifies 'complex' response", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "complex" } }]
        });

        const result = await classifier.classify("Design a distributed system");
        expect(result.tier).toBe("complex");
        expect(result.selectedModelId).toBe("model-complex");
    });

    it("defaults to 'standard' for ambiguous response", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "unknown-tier" } }]
        });

        const result = await classifier.classify("What is this?");
        expect(result.tier).toBe("standard");
        expect(result.selectedModelId).toBe("model-standard");
    });

    it("passes conversation history as context when recentMessages provided", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "complex" } }]
        });

        const recentMessages: ChatMessage[] = [
            { role: "user", content: "I'm working on a distributed microservices architecture" },
            { role: "assistant", content: "I can help with that." },
            { role: "user", content: "The service mesh is failing under load" },
        ];

        const result = await classifier.classify("debug this", recentMessages);
        expect(result.tier).toBe("complex");

        // Verify the API was called with context in the user message
        const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
        const userMessage = callArgs.messages.find((m: any) => m.role === "user");
        expect(userMessage.content).toContain("Recent conversation history");
        expect(userMessage.content).toContain("distributed microservices architecture");
        expect(userMessage.content).toContain("debug this");
    });

    it("includes reason with context depth in the routing decision", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple" } }]
        });

        const recentMessages: ChatMessage[] = [
            { role: "user", content: "prior message" },
        ];

        const result = await classifier.classify("short question", recentMessages);
        expect(result.reason).toContain("context depth: 1");
    });

    it("classifies without context when no recentMessages provided", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple" } }]
        });

        const result = await classifier.classify("Quick question");

        const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
        const userMessage = callArgs.messages.find((m: any) => m.role === "user");
        expect(userMessage.content).toBe("Quick question");
        expect(userMessage.content).not.toContain("Recent conversation history");
    });

    it("uses general tier model for classification (llama-smart, not removed llama-fast)", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple" } }]
        });

        await classifier.classify("test prompt");

        const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
        // Classifier should use tiers.general (llama-smart) not a removed model
        expect(callArgs.model).toBe("model-general");
    });
});
