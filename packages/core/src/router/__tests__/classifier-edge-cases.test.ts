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

describe("structural routing signals", () => {
    it("recognises pure small talk", async () => {
        const { structuralSignals } = await import("../classifier.js");
        for (const text of ["hi", "Hello!", "hey there", "thanks a lot", "Thank you!!", "ok", "good morning", "bye."]) {
            expect(structuralSignals(text).smallTalk, text).toBe(true);
        }
        for (const text of ["hi, can you fix the build?", "thanks, now refactor it", "ok do it", "hello world in rust", "why is the sky blue"]) {
            expect(structuralSignals(text).smallTalk, text).toBe(false);
        }
    });

    it("raises the floor for code, errors, file names and length", async () => {
        const { structuralSignals } = await import("../classifier.js");
        expect(structuralSignals("what does this do?").floor).toBe("general");
        expect(structuralSignals("fix this\n```ts\nconst a = 1\n```").floor).toBe("simple");
        expect(structuralSignals("TypeError: Cannot read properties of undefined").floor).toBe("simple");
        expect(structuralSignals("it crashes\n    at run (/app/src/index.ts:10:5)").floor).toBe("simple");
        expect(structuralSignals("rename the export in utils.ts").floor).toBe("simple");
        expect(structuralSignals("x".repeat(700)).floor).toBe("simple");
        expect(structuralSignals("update a.ts, b.tsx and c.py to use the new API").floor).toBe("standard");
        expect(structuralSignals("x".repeat(3000)).floor).toBe("standard");
        expect(structuralSignals("update a.ts and b.ts").reasons).toEqual(["mentions 2 files"]);
    });
});

describe("Classifier — robustness", () => {
    function make() {
        const create = vi.fn();
        const client = { chat: { completions: { create } } } as any;
        const config = {
            enabled: true,
            tiers: { general: "small", simple: "mid", standard: "mid", complex: "big" },
            routingContextDepth: 5,
            confidenceThreshold: 0.6,
        };
        return { create, config, client };
    }
    const reply = (content: string) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });

    it("answers small talk without calling the model — unless there is conversation history", async () => {
        const { Classifier } = await import("../classifier.js");
        const { create, client, config } = make();
        const classifier = new Classifier(client, config);

        expect(await classifier.classify("thanks!")).toMatchObject({ tier: "general", selectedModelId: "small", confidence: 1 });
        expect(create).not.toHaveBeenCalled();

        create.mockResolvedValue(reply("complex"));
        const followUp = await classifier.classify("ok", [{ role: "user", content: "the migration deadlocks under load" }]);
        expect(create).toHaveBeenCalledTimes(1);
        expect(followUp.tier).toBe("complex");
    });

    it("never routes below the structural floor, and says why", async () => {
        const { Classifier } = await import("../classifier.js");
        const { create, client, config } = make();
        create.mockResolvedValue(reply("general 0.95"));
        const decision = await new Classifier(client, config).classify("why does this fail?\nTypeError: x is not a function");
        expect(decision.tier).toBe("simple");
        expect(decision.selectedModelId).toBe("mid");
        expect(decision.reason).toContain("raised to simple (contains an error or stack trace)");
    });

    it("never lowers the model's answer", async () => {
        const { Classifier } = await import("../classifier.js");
        const { create, client, config } = make();
        create.mockResolvedValue(reply("complex 0.9"));
        expect((await new Classifier(client, config).classify("redesign the storage layer")).tier).toBe("complex");
    });

    it("falls back to a sensible tier when the classifier call fails", async () => {
        const { Classifier } = await import("../classifier.js");
        const { create, client, config } = make();
        create.mockRejectedValue(new Error("429 rate limited"));
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const decision = await new Classifier(client, config).classify("add input validation to the signup form");
            expect(decision).toMatchObject({ tier: "standard", selectedModelId: "mid" });
            expect(decision.reason).toContain("classifier unavailable");
        } finally {
            stderr.mockRestore();
        }
    });

    it("reports usage through the callback, and a failing callback does not break routing", async () => {
        const { Classifier } = await import("../classifier.js");
        const { create, client, config } = make();
        create.mockResolvedValue(reply("simple"));
        const onUsage = vi.fn().mockRejectedValue(new Error("db down"));
        const decision = await new Classifier(client, config, onUsage).classify("write a function that reverses a string");
        expect(decision.tier).toBe("simple");
        expect(onUsage).toHaveBeenCalledWith("small", 5, 1, "write a function that reverses a string");
    });
});
