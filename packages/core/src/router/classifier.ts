import OpenAI from "openai";
import type { ChatMessage, RoutingConfig, RoutingDecision } from "@pantheon/shared";
import { Tracer } from "../tracing/tracer.js";

const DEFAULT_CLASSIFIER_PROMPT = `You are a task complexity classifier for a coding assistant.
Respond with ONLY one word — no punctuation, no explanation.
Your options are: general, simple, standard, complex.

general  = greetings, small talk, factual lookups, yes/no questions, short definitions, general knowledge
simple   = short, self-contained code snippets (< 30 lines), quick fixes, minor edits, one-liner scripts
standard = multi-step code tasks (30–100 lines), moderate refactors, API integrations, test writing, summaries
complex  = architecture design, large-scale refactors, debugging sessions (especially with prior context), long code generation, multi-file changes, performance analysis, system design

IMPORTANT: When conversation history is provided, use it to judge the true scope of the current request.
For example, "debug this" alone may look simple, but if prior messages describe a complex system or a
hard-to-reproduce bug, classify it as "complex". Always consider cumulative context.`;

export class Classifier {
    private client: OpenAI;
    private config: RoutingConfig;

    constructor(client: OpenAI, config: RoutingConfig) {
        this.client = client;
        this.config = config;
    }

    /**
     * Classify the complexity of a prompt, optionally considering recent conversation history.
     * @param prompt - The current user prompt to classify.
     * @param recentMessages - The last N user messages (excluding the current prompt) for context.
     */
    async classify(prompt: string, recentMessages: ChatMessage[] = []): Promise<RoutingDecision> {
        return Tracer.startSpan(
            "router.classify",
            "routing",
            async (span) => {
                span.attributes.promptLength = prompt.length;
                span.attributes.contextDepth = recentMessages.length;

                const systemPrompt =
                    this.config.classifierPrompt ?? DEFAULT_CLASSIFIER_PROMPT;

                // Build context block from recent messages
                const contextDepth = this.config.routingContextDepth ?? 5;
                const contextMessages = recentMessages
                    .filter((m) => m.role === "user")
                    .slice(-contextDepth);

                let userContent = prompt;
                if (contextMessages.length > 0) {
                    const historyLines = contextMessages
                        .map((m, i) => `[Message ${i + 1}]: ${m.content.slice(0, 300)}`)
                        .join("\n");
                    userContent =
                        `Recent conversation history (for context only):\n${historyLines}\n\n` +
                        `Current message to classify: ${prompt}`;
                }

                // Use llama-smart for routing — removed llama-fast
                const classifierModel = this.config.tiers.general;

                const response = await this.client.chat.completions.create({
                    model: classifierModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userContent },
                    ],
                    max_tokens: 5,
                    temperature: 0,
                });

                const raw = response.choices[0]?.message?.content?.trim().toLowerCase() ?? "";

                // Normalise — if the model goes off-script, default to standard
                let tier: RoutingDecision["tier"];
                if (raw.startsWith("general")) tier = "general";
                else if (raw.startsWith("simple")) tier = "simple";
                else if (raw.startsWith("complex")) tier = "complex";
                else tier = "standard";

                const selectedModelId = this.config.tiers[tier];

                const decision: RoutingDecision = {
                    tier,
                    selectedModelId,
                    reason: `classified as ${tier} by ${classifierModel} (context depth: ${contextMessages.length})`,
                };

                span.attributes.assignedTier = tier;
                span.attributes.selectedModelId = selectedModelId;
                span.attributes.reason = decision.reason;

                return decision;
            }
        );
    }
}