import { describe, it, expect, vi, beforeEach } from "vitest";
import { Classifier } from "../classifier.js";
import type { RoutingConfig } from "@pantheon/shared";

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
                simple: "model-simple",
                standard: "model-standard",
                complex: "model-complex"
            }
        };

        classifier = new Classifier(mockOpenAI as any, config);
    });

    it("classifies 'simple' response", async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: "simple" } }]
        });

        const result = await classifier.classify("Hello");
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
});
