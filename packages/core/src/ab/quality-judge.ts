import type { ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";

const JUDGE_SYSTEM_PROMPT = `You are a quality evaluator for AI responses.
Rate the following AI response on a scale from 1 to 10 based on:
- Accuracy and correctness
- Completeness and depth
- Clarity and conciseness
- Helpfulness

Respond with ONLY a single integer from 1 to 10. No explanation.`;

/**
 * QualityJudge uses an LLM to score AI responses on a 1–10 scale.
 * Scoring is asynchronous and non-blocking — results are written back to the DB
 * after the user receives the response.
 */
export class QualityJudge {
    private gateway: Gateway;
    private judgeModelId: string;

    /**
     * @param gateway - The Gateway to use for the judge LLM call.
     * @param judgeModelId - Model to use for scoring. Defaults to "llama-smart" (cheap, fast).
     */
    constructor(gateway: Gateway, judgeModelId = "llama-smart") {
        this.gateway = gateway;
        this.judgeModelId = judgeModelId;
    }

    /**
     * Score an AI response for quality. Returns 1–10 or null if the judge fails.
     *
     * @param prompt - The original user prompt.
     * @param response - The AI response to score.
     */
    async score(prompt: string, response: string): Promise<number | null> {
        try {
            const messages: ChatMessage[] = [
                { role: "system", content: JUDGE_SYSTEM_PROMPT },
                {
                    role: "user",
                    content: `User prompt: ${prompt.slice(0, 500)}\n\nAI response:\n${response.slice(0, 1000)}`,
                },
            ];

            const result = await this.gateway.complete(messages, this.judgeModelId);
            const raw = result.message.content.trim();
            const score = parseInt(raw, 10);

            if (isNaN(score) || score < 1 || score > 10) {
                process.stderr.write(`[quality-judge] non-numeric score from model: "${raw}"\n`);
                return null;
            }

            return score;
        } catch (e) {
            process.stderr.write(`[quality-judge] scoring failed: ${e instanceof Error ? e.message : String(e)}\n`);
            return null;
        }
    }
}
