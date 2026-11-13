import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import { Classifier } from "../classifier.js";
import type { RoutingConfig } from "@pantheon/shared";

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

function makeClassifier(thresholdOverride?: number) {
    const mockOpenAI = {
        chat: {
            completions: {
                create: vi.fn(),
            },
        },
    };
    const config: RoutingConfig = {
        enabled: true,
        tiers: {
            general:  "model-general",
            simple:   "model-simple",
            standard: "model-standard",
            complex:  "model-complex",
        },
        routingContextDepth: 5,
        ...(thresholdOverride !== undefined ? { confidenceThreshold: thresholdOverride } : {}),
    };
    return { classifier: new Classifier(mockOpenAI as any, config), mockOpenAI };
}

describe("Classifier — edge cases", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    // ── Tier mapping ──────────────────────────────────────────────────────────

    it("maps 'general' tier to general model", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "general 0.95" } }],
        });
        const result = await classifier.classify("hi");
        expect(result.tier).toBe("general");
        expect(result.selectedModelId).toBe("model-general");
    });

    it("maps 'simple' tier to simple model", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple 0.99" } }],
        });
        const result = await classifier.classify("what is 2+2");
        expect(result.tier).toBe("simple");
        expect(result.selectedModelId).toBe("model-simple");
    });

    it("maps 'complex' tier to complex model", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "complex 0.95" } }],
        });
        const result = await classifier.classify("design a full distributed system");
        expect(result.tier).toBe("complex");
        expect(result.selectedModelId).toBe("model-complex");
    });

    it("maps unrecognized tier word to 'standard' (safe fallback)", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "turbo 0.9" } }],
        });
        const result = await classifier.classify("some task");
        // Line 99: unknown tier → "standard" (not complex — just safest non-escalating choice)
        expect(result.tier).toBe("standard");
        expect(result.selectedModelId).toBe("model-standard");
    });

    // ── General/Simple never escalate ─────────────────────────────────────────

    it("does NOT escalate 'general' tier even with very low confidence", async () => {
        const { classifier, mockOpenAI } = makeClassifier(0.9);
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "general 0.1" } }],
        });
        // Escalation only applies to "standard" tier (classifier.ts line 104)
        const result = await classifier.classify("hi");
        expect(result.tier).toBe("general");
    });

    it("does NOT escalate 'simple' tier even with very low confidence", async () => {
        const { classifier, mockOpenAI } = makeClassifier(0.9);
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple 0.05" } }],
        });
        const result = await classifier.classify("2+2");
        expect(result.tier).toBe("simple");
    });

    it("does NOT downgrade 'complex' tier even with very high confidence", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "complex 1.0" } }],
        });
        const result = await classifier.classify("some complex thing");
        expect(result.tier).toBe("complex");
    });

    // ── Confidence boundary ───────────────────────────────────────────────────

    it("does NOT escalate when confidence == threshold exactly", async () => {
        const { classifier, mockOpenAI } = makeClassifier(0.6);
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 0.6" } }],
        });
        // 0.6 >= 0.6 → no escalation
        const result = await classifier.classify("borderline task");
        expect(result.tier).toBe("standard");
    });

    it("escalates when confidence is just below threshold", async () => {
        const { classifier, mockOpenAI } = makeClassifier(0.6);
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 0.59" } }],
        });
        // 0.59 < 0.6 → escalate
        const result = await classifier.classify("borderline task");
        expect(result.tier).toBe("complex");
    });

    it("escalates when confidence is 0.0", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 0.0" } }],
        });
        const result = await classifier.classify("ambiguous");
        expect(result.tier).toBe("complex");
        expect(result.confidence).toBe(0);
    });

    it("does NOT escalate when confidence is 1.0", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard 1.0" } }],
        });
        const result = await classifier.classify("clear task");
        expect(result.tier).toBe("standard");
        expect(result.confidence).toBe(1);
    });

    // ── Input hygiene ─────────────────────────────────────────────────────────

    it("strips leading/trailing whitespace from LLM response", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "  standard 0.8  " } }],
        });
        const result = await classifier.classify("task");
        expect(result.tier).toBe("standard");
        expect(result.confidence).toBe(0.8);
    });

    it("handles UPPERCASE tier response gracefully (lowercase normalisation)", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "STANDARD 0.8" } }],
        });
        const result = await classifier.classify("task");
        // The raw is lower-cased before parsing, so "standard" is recognised
        expect(result.tier).toBe("standard");
    });

    it("includes prompt text in messages sent to classifier model", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "standard" } }],
        });
        await classifier.classify("my specific task description");
        const callArgs = mockOpenAI.chat.completions.create.mock.calls[0]![0];
        const messagesText = JSON.stringify(callArgs.messages);
        expect(messagesText).toContain("my specific task description");
    });

    it("includes conversation history when recentMessages are provided", async () => {
        const { classifier, mockOpenAI } = makeClassifier();
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "complex" } }],
        });
        const history = [{ role: "user" as const, content: "previous question about architecture" }];
        await classifier.classify("can you debug this?", history);
        const callArgs = mockOpenAI.chat.completions.create.mock.calls[0]![0];
        const userMsg = callArgs.messages.find((m: { role: string }) => m.role === "user");
        expect(userMsg.content).toContain("previous question about architecture");
    });
});
