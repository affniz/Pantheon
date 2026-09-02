import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import { Classifier } from "../classifier.js";
import type { RoutingConfig } from "@pantheon/shared";

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

describe("Classifier — confidence scoring (v0.8)", () => {
    let mockOpenAI: any;
    let config: RoutingConfig;
    let classifier: Classifier;

    beforeEach(() => {
        mockOpenAI = {
            chat: {
                completions: {
                    create: vi.fn(),
                },
            },
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
            confidenceThreshold: 0.6,
        };
        classifier = new Classifier(mockOpenAI as any, config);
    });

    it("parses confidence from 'standard 0.8' response", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 0.8" } }],
        });
        const result = await classifier.classify("Write a REST API endpoint");
        expect(result.tier).toBe("standard");
        expect(result.confidence).toBe(0.8);
    });

    it("escalates standard → complex when confidence is below threshold", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 0.4" } }],
        });
        const result = await classifier.classify("Some ambiguous task");
        // confidence 0.4 < threshold 0.6 → escalate standard to complex
        expect(result.tier).toBe("complex");
        expect(result.confidence).toBe(0.4);
        expect(result.selectedModelId).toBe("model-complex");
    });

    it("does NOT escalate when confidence is above threshold", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 0.9" } }],
        });
        const result = await classifier.classify("Multi-step refactor task");
        expect(result.tier).toBe("standard");
        expect(result.confidence).toBe(0.9);
    });

    it("does NOT downgrade complex to standard even with high confidence", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "complex 0.95" } }],
        });
        const result = await classifier.classify("Design a distributed system");
        expect(result.tier).toBe("complex");
        expect(result.confidence).toBe(0.95);
    });

    it("omits confidence when model returns only the tier word", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple" } }],
        });
        const result = await classifier.classify("Add two numbers");
        expect(result.tier).toBe("simple");
        expect(result.confidence).toBeUndefined();
    });

    it("ignores non-numeric confidence suffix", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard high" } }],
        });
        const result = await classifier.classify("Some task");
        expect(result.tier).toBe("standard");
        expect(result.confidence).toBeUndefined();
    });

    it("uses max_tokens of 20 to allow confidence suffix", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple 0.9" } }],
        });
        await classifier.classify("Quick fix");
        const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
        expect(callArgs.max_tokens).toBe(20);
    });

    it("uses default threshold of 0.6 when not configured", async () => {
        const configWithoutThreshold: RoutingConfig = {
            ...config,
            confidenceThreshold: undefined,
        };
        const classifierDefault = new Classifier(mockOpenAI as any, configWithoutThreshold);
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 0.55" } }],
        });
        // 0.55 < 0.6 default threshold → escalates
        const result = await classifierDefault.classify("borderline task");
        expect(result.tier).toBe("complex");
    });
});
