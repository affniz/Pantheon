import OpenAI from "openai";
import type { ChatMessage, RoutingDecision, ToolCall } from "@pantheon/shared";
import type { ModelRegistry } from "../registry/model-registry.js";
import type { OpenAITool } from "../tools/tool-registry.js";
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

    /** Returns the correct OpenAI client for the given model id. */
    private clientFor(_modelId: string): OpenAI {
        return this.client;
    }

    /** Returns the real upstream model name for the given model id. */
    private upstreamModelName(modelId: string): string {
        const model = this.registry.get(modelId);
        return model?.modelName ?? modelId;
    }

    /**
     * Resolve routing decision based on modelId override, auto-routing, or default.
     * Shared between stream() and complete().
     */
    async resolveRouting(
        messages: ChatMessage[],
        modelId?: string
    ): Promise<RoutingDecision> {
        if (modelId) {
            const model = this.registry.get(modelId);
            if (!model) throw new Error(`Model "${modelId}" not found.`);
            return {
                tier: "standard",
                selectedModelId: modelId,
                reason: "manual override",
            };
        }

        const routingConfig = this.registry.getRoutingConfig();

        if (routingConfig.enabled) {
            const lastUserMessage =
                [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
            return this.classifier.classify(lastUserMessage);
        }

        const model = this.registry.getDefault();
        if (!model) throw new Error("No models configured.");
        return {
            tier: "standard",
            selectedModelId: model.id,
            reason: "routing disabled, using default",
        };
    }

    async stream(
        messages: ChatMessage[],
        modelId?: string
    ): Promise<{ generator: AsyncGenerator<string>; decision: RoutingDecision }> {
        const decision = await this.resolveRouting(messages, modelId);
        const generator = this._streamCompletion(messages, decision);
        return { generator, decision };
    }

    /**
     * Non-streaming completion with optional tool calling support.
     * Used by the agent runtime for tool-call turns where we need the full response
     * to parse tool calls before proceeding.
     */
    async complete(
        messages: ChatMessage[],
        modelId: string,
        tools?: OpenAITool[]
    ): Promise<{
        message: ChatMessage;
        usage: { inputTokens: number; outputTokens: number };
    }> {
        const openaiMessages = messages.map((m) => {
            if (m.role === "tool") {
                return {
                    role: "tool" as const,
                    content: m.content,
                    tool_call_id: m.toolCallId ?? "",
                };
            }
            if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
                return {
                    role: "assistant" as const,
                    content: m.content || null,
                    tool_calls: m.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: "function" as const,
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },
                    })),
                };
            }
            return {
                role: m.role as "system" | "user" | "assistant",
                content: m.content,
            };
        });

        const requestParams: Record<string, unknown> = {
            model: modelId,
            messages: openaiMessages,
        };

        if (tools && tools.length > 0) {
            requestParams["tools"] = tools;
            requestParams["tool_choice"] = "auto";
            // Force one tool call per turn. Some Groq Llama variants produce
            // malformed JSON when generating multiple tool calls simultaneously.
            requestParams["parallel_tool_calls"] = false;
        }

        let response;
        let lastError: unknown;
        // Retry up to 3 times total. Groq/Llama models occasionally generate
        // malformed tool-call output that causes a 400; retrying usually succeeds.
        const client = this.clientFor(modelId);
        const upstreamModel = this.upstreamModelName(modelId);
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                response = await client.chat.completions.create(
                    { ...requestParams, model: upstreamModel } as any
                );
                break; // success
            } catch (err) {
                lastError = err;
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[gateway] attempt ${attempt} failed: ${msg}\n`);
                if (attempt < 3) {
                    // Small backoff before retry
                    await new Promise((r) => setTimeout(r, 500 * attempt));
                }
            }
        }

        if (!response) {
            // All tool-enabled attempts failed. Fall back to plain text so the
            // model can at least give a useful response from its knowledge.
            process.stderr.write(`[gateway] all tool-call attempts failed, falling back to text-only\n`);
            if (tools && tools.length > 0) {
                const fallbackParams = { model: upstreamModel, messages: openaiMessages };
                response = await client.chat.completions.create(
                    fallbackParams as any
                );
            } else {
                throw lastError;
            }
        }


        const choice = response.choices[0];
        if (!choice) throw new Error("No response from model.");

        const inputTokens = response.usage?.prompt_tokens ?? 0;
        const outputTokens = response.usage?.completion_tokens ?? 0;

        // Parse tool calls from the response
        let toolCalls: ToolCall[] | undefined;
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            toolCalls = choice.message.tool_calls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
            }));
        }

        const message: ChatMessage = {
            role: "assistant",
            content: choice.message.content ?? "",
            ...(toolCalls ? { toolCalls } : {}),
        };

        // Record usage
        this.tracker.record({
            timestamp: new Date().toISOString(),
            modelId,
            inputTokens,
            outputTokens,
            costUsd: 0,
            promptPreview: messages.at(-1)?.content.slice(0, 200) ?? "",
        });

        return { message, usage: { inputTokens, outputTokens } };
    }

    private async *_streamCompletion(
        messages: ChatMessage[],
        decision: RoutingDecision
    ): AsyncGenerator<string> {
        const modelId = decision.selectedModelId;
        const client = this.clientFor(modelId);
        const upstreamModel = this.upstreamModelName(modelId);

        const stream = await client.chat.completions.create({
            model: upstreamModel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })) as any,
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