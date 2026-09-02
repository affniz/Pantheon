import OpenAI from "openai";
import type { ChatMessage, RoutingConfig, RoutingDecision } from "@pantheon/shared";
import { Tracer } from "../tracing/tracer.js";

const DEFAULT_CLASSIFIER_PROMPT = `You are a task complexity classifier for a coding assistant.
Respond with ONLY one or two tokens — no punctuation, no explanation.
Format: <tier> [confidence]
Examples: "general", "simple 0.9", "standard 0.65", "complex 0.8"

Tiers:
general  = greetings, small talk, factual lookups, yes/no questions, short definitions, general knowledge
simple   = short, self-contained code snippets (< 30 lines), quick fixes, minor edits, one-liner scripts
standard = multi-step code tasks (30–100 lines), moderate refactors, API integrations, test writing, summaries
complex  = architecture design, large-scale refactors, debugging sessions (especially with prior context), long code generation, multi-file changes, performance analysis, system design

The confidence value (0.0–1.0) reflects how certain you are about this classification.
Omit the confidence value only when you are completely certain (implicit 1.0).

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
                    // Increased from 5 to 20 to allow optional confidence suffix (e.g. "standard 0.72")
                    max_tokens: 20,
                    temperature: 0,
                });

                const raw = response.choices[0]?.message?.content?.trim().toLowerCase() ?? "";

                // Parse tier word (first token)
                const parts = raw.split(/\s+/);
                const tierWord = parts[0] ?? "";
                const confidenceWord = parts[1];

                // Parse confidence — float between 0 and 1, or undefined
                let confidence: number | undefined;
                if (confidenceWord !== undefined) {
                    const parsed = parseFloat(confidenceWord);
                    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
                        confidence = parsed;
                    }
                }

                // Normalise tier — if the model goes off-script, default to standard
                let tier: RoutingDecision["tier"];
                if (tierWord.startsWith("general")) tier = "general";
                else if (tierWord.startsWith("simple")) tier = "simple";
                else if (tierWord.startsWith("complex")) tier = "complex";
                else tier = "standard";

                // Confidence threshold escalation: if confidence is below threshold,
                // escalate standard → complex (safe escalation, never downgrade from complex)
                const threshold = this.config.confidenceThreshold ?? 0.6;
                if (confidence !== undefined && confidence < threshold && tier === "standard") {
                    tier = "complex";
                }

                const selectedModelId = this.config.tiers[tier];

                const decision: RoutingDecision = {
                    tier,
                    selectedModelId,
                    reason: `classified as ${tier} by ${classifierModel} (context depth: ${contextMessages.length})`,
                    ...(confidence !== undefined ? { confidence } : {}),
                };

                span.attributes.assignedTier = tier;
                span.attributes.selectedModelId = selectedModelId;
                span.attributes.reason = decision.reason;
                if (confidence !== undefined) span.attributes.confidence = confidence;

                return decision;
            }
        );
    }
}