import { describe, it, expect, vi, beforeEach } from "vitest";
import { QualityJudge } from "../quality-judge.js";
import type { ChatMessage } from "@pantheon/shared";

function makeMockGateway(responseContent: string) {
    return {
        complete: vi.fn(async (_messages: ChatMessage[], _modelId: string) => ({
            message: { role: "assistant" as const, content: responseContent },
            usage: { inputTokens: 5, outputTokens: 2 },
        })),
    };
}

describe("QualityJudge", () => {
    it("returns a score between 1 and 10 for a valid integer response", async () => {
        const gateway = makeMockGateway("8");
        const judge = new QualityJudge(gateway as any, "llama-smart");
        const score = await judge.score("What is 2+2?", "The answer is 4.");
        expect(score).toBe(8);
    });

    it("returns 1 (minimum) for response '1'", async () => {
        const gateway = makeMockGateway("1");
        const judge = new QualityJudge(gateway as any);
        const score = await judge.score("prompt", "poor response");
        expect(score).toBe(1);
    });

    it("returns 10 (maximum) for response '10'", async () => {
        const gateway = makeMockGateway("10");
        const judge = new QualityJudge(gateway as any);
        const score = await judge.score("prompt", "excellent response");
        expect(score).toBe(10);
    });

    it("returns null when model returns a non-numeric string", async () => {
        const gateway = makeMockGateway("good");
        const judge = new QualityJudge(gateway as any);
        const score = await judge.score("prompt", "response");
        expect(score).toBeNull();
    });

    it("returns null when model returns a number below 1", async () => {
        const gateway = makeMockGateway("0");
        const judge = new QualityJudge(gateway as any);
        const score = await judge.score("prompt", "response");
        expect(score).toBeNull();
    });

    it("returns null when model returns a number above 10", async () => {
        const gateway = makeMockGateway("11");
        const judge = new QualityJudge(gateway as any);
        const score = await judge.score("prompt", "response");
        expect(score).toBeNull();
    });

    it("handles whitespace around the score", async () => {
        const gateway = makeMockGateway("  7  ");
        const judge = new QualityJudge(gateway as any);
        const score = await judge.score("prompt", "response");
        expect(score).toBe(7);
    });

    it("returns null when gateway throws", async () => {
        const gateway = {
            complete: vi.fn(async () => { throw new Error("network error"); }),
        };
        const judge = new QualityJudge(gateway as any);
        const score = await judge.score("prompt", "response");
        expect(score).toBeNull();
    });

    it("uses the specified judge model", async () => {
        const gateway = makeMockGateway("6");
        const judge = new QualityJudge(gateway as any, "deepseek-v4-flash");
        await judge.score("prompt", "response");
        expect(gateway.complete).toHaveBeenCalledWith(
            expect.any(Array),
            "deepseek-v4-flash"
        );
    });

    it("defaults judge model to llama-smart", async () => {
        const gateway = makeMockGateway("5");
        const judge = new QualityJudge(gateway as any);
        await judge.score("prompt", "response");
        expect(gateway.complete).toHaveBeenCalledWith(
            expect.any(Array),
            "llama-smart"
        );
    });

    it("includes both prompt and response in judge input", async () => {
        const gateway = makeMockGateway("7");
        const judge = new QualityJudge(gateway as any);
        await judge.score("the user prompt", "the AI response");
        const messages = gateway.complete.mock.calls[0]![0] as ChatMessage[];
        const userMsg = messages.find((m) => m.role === "user");
        expect(userMsg?.content).toContain("the user prompt");
        expect(userMsg?.content).toContain("the AI response");
    });

    it("truncates very long prompts and responses (does not throw)", async () => {
        const gateway = makeMockGateway("7");
        const judge = new QualityJudge(gateway as any);
        const longPrompt = "x".repeat(5000);
        const longResponse = "y".repeat(5000);
        const score = await judge.score(longPrompt, longResponse);
        expect(score).toBe(7);
    });
});
