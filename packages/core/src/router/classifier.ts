import OpenAI from "openai";
import type { RoutingConfig, RoutingDecision } from "@pantheon/shared";
import { Tracer } from "../tracing/tracer.js";

const DEFAULT_CLASSIFIER_PROMPT = `You are a task complexity classifier.
Respond with ONLY one word — no punctuation, no explanation.
Your options are: simple, standard, complex.

simple   = greetings, factual lookups, one-liners, yes/no questions, short definitions
standard = multi-step explanations, summaries, moderate code (under 50 lines), comparisons
complex  = architecture design, debugging, reasoning chains, long code generation, proofs, refactors`;

export class Classifier {
    private client: OpenAI;
    private config: RoutingConfig;

    constructor(client: OpenAI, config: RoutingConfig) {
        this.client = client;
        this.config = config;
    }

    async classify(prompt: string): Promise<RoutingDecision> {
        return Tracer.startSpan(
            "router.classify",
            "routing",
            async (span) => {
                span.attributes.promptLength = prompt.length;

                const systemPrompt =
                    this.config.classifierPrompt ?? DEFAULT_CLASSIFIER_PROMPT;

                const response = await this.client.chat.completions.create({
                    model: this.config.tiers.simple,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: prompt },
                    ],
                    max_tokens: 5,
                    temperature: 0,
                });

                const raw = response.choices[0]?.message?.content?.trim().toLowerCase() ?? "";

                // Normalise — if the model adds punctuation or goes off-script, default to standard
                let tier: RoutingDecision["tier"];
                if (raw.startsWith("simple")) tier = "simple";
                else if (raw.startsWith("complex")) tier = "complex";
                else tier = "standard";

                const selectedModelId = this.config.tiers[tier];

                const decision: RoutingDecision = {
                    tier,
                    selectedModelId,
                    reason: `classified as ${tier} by ${this.config.tiers.simple}`,
                };

                span.attributes.assignedTier = tier;
                span.attributes.selectedModelId = selectedModelId;
                span.attributes.reason = decision.reason;

                return decision;
            }
        );
    }
}