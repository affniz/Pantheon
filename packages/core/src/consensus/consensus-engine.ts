import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ChatMessage, ConsensusConfig, ConsensusResult, ConsensusResponse } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { getDb } from "../db/client.js";
import { schema } from "../db/index.js";

const DEFAULT_SYNTHESIS_PROMPT = `You are a synthesis assistant. Below are responses from multiple AI models to the same user prompt.
Your task is to synthesize the best possible answer by:
1. Taking the most accurate and complete information from each response
2. Removing contradictions (prefer the most specific/detailed answer)
3. Presenting the result as a single, coherent response

Do NOT mention the different models or that this is a synthesis. Just give the best answer.

User prompt:
{{PROMPT}}

Model responses:
{{RESPONSES}}`;

/**
 * ConsensusEngine fans out a prompt to multiple models in parallel and synthesizes
 * the best answer from all responses.
 *
 * Usage:
 *   const engine = new ConsensusEngine(gateway, config);
 *   const result = await engine.run(messages, sessionId);
 */
export class ConsensusEngine {
    private gateway: Gateway;
    private config: ConsensusConfig;

    constructor(gateway: Gateway, config: ConsensusConfig) {
        this.gateway = gateway;
        this.config = config;
    }

    /**
     * Fan out `messages` to all configured models in parallel.
     * Returns all individual responses + a synthesized result.
     */
    async run(messages: ChatMessage[], sessionId?: string): Promise<ConsensusResult> {
        const prompt = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
        const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);

        // Fan-out: call all models in parallel
        const modelIds = this.config.models;
        const fanOutResults = await Promise.allSettled(
            modelIds.map((modelId) => this._callModel(messages, modelId))
        );

        const responses: ConsensusResponse[] = fanOutResults.map((result, i) => {
            if (result.status === "fulfilled") {
                return result.value;
            }
            const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
            return {
                modelId: modelIds[i] ?? "unknown",
                content: "",
                latencyMs: 0,
                inputTokens: 0,
                outputTokens: 0,
                error: err,
            } satisfies ConsensusResponse;
        });

        // Synthesize: build a combined prompt from all successful responses
        const successfulResponses = responses.filter((r) => !r.error && r.content);

        let synthesizedContent: string;
        let synthesisLatencyMs: number;

        if (successfulResponses.length === 0) {
            // All models failed — return the last error message
            synthesizedContent = responses[0]?.error ?? "All models failed to respond.";
            synthesisLatencyMs = 0;
        } else if (successfulResponses.length === 1) {
            // Only one model succeeded — no need to synthesize
            synthesizedContent = successfulResponses[0]!.content;
            synthesisLatencyMs = 0;
        } else {
            const synthStart = Date.now();
            synthesizedContent = await this._synthesize(prompt, successfulResponses);
            synthesisLatencyMs = Date.now() - synthStart;
        }

        // Persist to DB
        const runId = randomUUID();
        try {
            const db = getDb();
            db.insert(schema.consensusRuns).values({
                id: runId,
                ...(sessionId ? { sessionId } : {}),
                promptHash,
                synthesizedContent,
                modelResponses: JSON.stringify(responses),
                synthesisLatencyMs,
                createdAt: new Date().toISOString(),
            }).run();
        } catch (e) {
            process.stderr.write(`[consensus] failed to persist run: ${e instanceof Error ? e.message : String(e)}\n`);
        }

        return { runId, responses, synthesizedContent, synthesisLatencyMs };
    }

    private async _callModel(
        messages: ChatMessage[],
        modelId: string
    ): Promise<ConsensusResponse> {
        const start = Date.now();
        const result = await this.gateway.complete(messages, modelId);
        const latencyMs = Date.now() - start;
        return {
            modelId,
            content: result.message.content,
            latencyMs,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
        };
    }

    private async _synthesize(
        prompt: string,
        responses: ConsensusResponse[]
    ): Promise<string> {
        const responsesText = responses
            .map((r, i) => `--- Model ${i + 1}: ${r.modelId} ---\n${r.content}`)
            .join("\n\n");

        const synthesisPrompt = (this.config.synthesisPrompt ?? DEFAULT_SYNTHESIS_PROMPT)
            .replace("{{PROMPT}}", prompt)
            .replace("{{RESPONSES}}", responsesText);

        const systemMessage: ChatMessage = { role: "system", content: synthesisPrompt };
        // Use a simple user message so the synthesis model has clear input
        const userMessage: ChatMessage = {
            role: "user",
            content: "Please synthesize the best answer from the model responses above.",
        };

        const result = await this.gateway.complete(
            [systemMessage, userMessage],
            this.config.synthesisModelId
        );
        return result.message.content;
    }

    /**
     * Write an LLM-judged quality score back to the persisted consensus run.
     * Called asynchronously after the response has been sent to the user.
     *
     * @param runId - The UUID returned by `run()`.
     * @param qualityScore - Score from 1–10 produced by `QualityJudge`.
     */
    updateQualityScore(runId: string, qualityScore: number): void {
        try {
            const db = getDb();
            db.update(schema.consensusRuns)
                .set({ qualityScore })
                .where(eq(schema.consensusRuns.id, runId))
                .run();
        } catch (e) {
            process.stderr.write(
                `[consensus] failed to update quality score for run ${runId}: ${e instanceof Error ? e.message : String(e)}\n`
            );
        }
    }
}
