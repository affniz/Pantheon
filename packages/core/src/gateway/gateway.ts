import OpenAI from "openai";
import type { ChatMessage, RoutingDecision } from "@pantheon/shared";
import type { ModelRegistry } from "../registry/model-registry.js";
import { Classifier } from "../router/classifier.js";
import { CostTracker } from "../cost/tracker.js";

export class Gateway {
    private client: OpenAI;
    private registry: ModelRegistry;
    private classifier: Classifier;
    private tracker: CostTracker;

    constructor(registry: ModelRegistry) {
        this.registry = registry;
        const { baseUrl, masterKey } = registry.getGatewayConfig();

        this.client = new OpenAI({ baseURL: baseUrl, apiKey: masterKey });
        this.classifier = new Classifier(this.client, registry.getRoutingConfig());
        this.tracker = new CostTracker();
    }

    async stream(
        messages: ChatMessage[],
        modelId?: string
    ): Promise<{ generator: AsyncGenerator<string>; decision: RoutingDecision }> {
        const routingConfig = this.registry.getRoutingConfig();

        let decision: RoutingDecision;

        if (modelId) {
            // Manual override — bypass classifier
            const model = this.registry.get(modelId);
            if (!model) throw new Error(`Model "${modelId}" not found.`);
            decision = {
                tier: "standard",
                selectedModelId: modelId,
                reason: "manual override",
            };
        } else if (routingConfig.enabled) {
            // Auto-routing — classify the last user message
            const lastUserMessage =
                [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
            decision = await this.classifier.classify(lastUserMessage);
        } else {
            // Routing disabled, fall back to default model
            const model = this.registry.getDefault();
            if (!model) throw new Error("No models configured.");
            decision = {
                tier: "standard",
                selectedModelId: model.id,
                reason: "routing disabled, using default",
            };
        }

        const generator = this._streamCompletion(messages, decision);
        return { generator, decision };
    }

    private async *_streamCompletion(
        messages: ChatMessage[],
        decision: RoutingDecision
    ): AsyncGenerator<string> {
        const stream = await this.client.chat.completions.create({
            model: decision.selectedModelId,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
            stream_options: { include_usage: true },
        });

        let inputTokens = 0;
        let outputTokens = 0;

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) yield delta;

            if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens;
                outputTokens = chunk.usage.completion_tokens;
            }
        }

        this.tracker.record({
            timestamp: new Date().toISOString(),
            modelId: decision.selectedModelId,
            inputTokens,
            outputTokens,
            costUsd: 0,
            promptPreview: messages.at(-1)?.content.slice(0, 200) ?? "",
        });
    }
}