import OpenAI from "openai";
import type { ChatMessage } from "@pantheon/shared";
import type { ModelRegistry } from "../registry/model-registry.js";

export class Gateway {
    private client: OpenAI;
    private registry: ModelRegistry;

    constructor(registry: ModelRegistry) {
        this.registry = registry;
        const { baseUrl, masterKey } = registry.getGatewayConfig();

        this.client = new OpenAI({
            baseURL: baseUrl,
            apiKey: masterKey,
        });
    }

    async *stream(
        messages: ChatMessage[],
        modelId?: string
    ): AsyncGenerator<string> {
        const model = modelId
            ? this.registry.get(modelId)
            : this.registry.getDefault();

        if (!model) {
            throw new Error(
                modelId ? `Model "${modelId}" not found.` : "No models configured."
            );
        }

        const stream = await this.client.chat.completions.create({
            model: model.id,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
        });

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) yield delta;
        }
    }
}