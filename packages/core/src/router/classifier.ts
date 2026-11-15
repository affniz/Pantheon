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

type Tier = RoutingDecision["tier"];
const TIER_ORDER: Tier[] = ["general", "simple", "standard", "complex"];

/** A message that is nothing but a greeting, thanks or acknowledgement. */
const SMALL_TALK = /^(hi|hello|hey|yo|hiya|howdy|good (morning|afternoon|evening|night)|thanks|thank you|thx|ty|ok|okay|cool|great|nice|got it|bye|goodbye|cheers)( there| all| everyone| a lot| so much| again)?[\s!.,?]*$/i;

const CODE_FILE = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cpp|hpp|cs|swift|sql|sh|ya?ml|json|toml|css|scss|html|vue|svelte)\b/gi;
const STACK_TRACE = /(^\s+at .+[(:]\d+:\d+\)?$)|(Traceback \(most recent call last\))|(\b\w*(Error|Exception): )/m;

/**
 * What can be told about a prompt without asking a model.
 *
 * The LLM classifier is asked to grade its own certainty, which is not a
 * dependable signal. These structural facts are: a prompt carrying code, a stack
 * trace or file names is not small talk however briefly it is worded, and a very
 * long or many-file prompt is at least a multi-step task. They are used as a
 * *floor* under the model's answer (never to lower it), and to answer pure small
 * talk with no model call at all.
 */
export function structuralSignals(prompt: string): { smallTalk: boolean; floor: Tier; reasons: string[] } {
    const text = prompt.trim();
    const reasons: string[] = [];
    let floor: Tier = "general";
    const raise = (tier: Tier, why: string) => {
        if (TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(floor)) floor = tier;
        reasons.push(why);
    };

    const files = new Set((text.match(CODE_FILE) ?? []).map((f) => f.toLowerCase()));
    if (text.includes("```")) raise("simple", "contains code");
    if (STACK_TRACE.test(text)) raise("simple", "contains an error or stack trace");
    if (files.size > 0) raise("simple", `mentions ${files.size} file${files.size === 1 ? "" : "s"}`);
    if (text.length > 600) raise("simple", "long prompt");
    if (files.size >= 3) raise("standard", "spans several files");
    if (text.length > 2500) raise("standard", "very long prompt");

    return { smallTalk: reasons.length === 0 && text.length <= 40 && SMALL_TALK.test(text), floor, reasons };
}

function atLeast(tier: Tier, floor: Tier): Tier {
    return TIER_ORDER.indexOf(floor) > TIER_ORDER.indexOf(tier) ? floor : tier;
}

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

                // The general-tier model doubles as the classifier (fast and cheap)
                const classifierModel = this.config.tiers.general;
                const signals = structuralSignals(prompt);
                span.attributes.structuralFloor = signals.floor;

                // Pure small talk, with no earlier conversation to change its meaning:
                // no need to spend a model call deciding that "thanks!" is not a refactor.
                if (signals.smallTalk && contextMessages.length === 0) {
                    span.attributes.assignedTier = "general";
                    span.attributes.selectedModelId = this.config.tiers.general;
                    span.attributes.reason = "small talk (no classifier call)";
                    return {
                        tier: "general",
                        selectedModelId: this.config.tiers.general,
                        reason: "small talk — routed without a classifier call",
                        confidence: 1,
                    };
                }

                let raw: string;
                try {
                    const response = await this.client.chat.completions.create({
                        model: classifierModel,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userContent },
                        ],
                        // Room for the optional confidence suffix (e.g. "standard 0.72")
                        max_tokens: 20,
                        temperature: 0,
                    });
                    raw = response.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
                } catch (err) {
                    // The classifier is an optimisation, not a dependency: if it is
                    // unreachable or rate-limited, route on structure alone rather than
                    // failing the user's request before it has started.
                    const tier = atLeast("standard", signals.floor);
                    const reason = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`[router] classifier unavailable (${reason}); routing as ${tier}\n`);
                    span.attributes.assignedTier = tier;
                    span.attributes.selectedModelId = this.config.tiers[tier];
                    span.attributes.classifierError = reason;
                    return {
                        tier,
                        selectedModelId: this.config.tiers[tier],
                        reason: `classifier unavailable — defaulted to ${tier}`,
                    };
                }

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

                // Structural floor: the model's answer can be raised, never lowered.
                const modelTier = tier;
                tier = atLeast(tier, signals.floor);
                const raised = tier !== modelTier;

                const selectedModelId = this.config.tiers[tier];

                const decision: RoutingDecision = {
                    tier,
                    selectedModelId,
                    reason: raised
                        ? `classified as ${modelTier} by ${classifierModel}, raised to ${tier} (${signals.reasons.join(", ")})`
                        : `classified as ${tier} by ${classifierModel} (context depth: ${contextMessages.length})`,
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