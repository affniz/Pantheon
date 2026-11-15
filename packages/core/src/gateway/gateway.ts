import OpenAI from "openai";
import type { ChatMessage, RoutingConfig, RoutingDecision, ToolCall } from "@pantheon/shared";
import type { ModelRegistry } from "../registry/model-registry.js";
import type { OpenAITool } from "../tools/tool-registry.js";
import { Classifier } from "../router/classifier.js";
import { CostTracker } from "../cost/tracker.js";
import { Tracer } from "../tracing/tracer.js";

/** Fallback models tried, in order, after the complex-tier model when no chain is configured. */
const DEFAULT_FALLBACK_MODELS = ["claude-fallback", "gpt-fallback"] as const;

/** Per-call options for `complete()`. */
export interface CompleteOptions {
    /**
     * Receive the assistant's text as it is generated. The request is then made in
     * streaming mode; the returned message is identical to the non-streaming one.
     */
    onToken?: (delta: string) => void;
}

/** The slice of a chat-completion response `complete()` consumes — same shape streamed or not. */
interface CompletionResponse {
    choices: Array<{
        message: {
            content?: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> | null;
        };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Marks an error raised after text had already been streamed to the caller. */
class PartialStreamError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "PartialStreamError";
    }
}

/** Callback invoked when the gateway falls back to a different model. */
export type ModelFallbackCallback = (from: string, to: string, reason: string) => void;

export interface GatewayOptions {
    /**
     * Base delay between retry attempts of a single model call. Attempt N waits
     * `retryBaseDelayMs * N`. Default: 500ms. Tests pass 0 to avoid real sleeps.
     */
    retryBaseDelayMs?: number;
    /**
     * Chat session this gateway is serving. Stamped on every usage record so cost
     * can be broken down per session. When omitted, the session of the active
     * trace (if any) is used.
     */
    sessionId?: string;
}

/** Number of attempts made against a single model before giving up on it. */
const MAX_ATTEMPTS = 3;

export class Gateway {
    private client: OpenAI;
    private registry: ModelRegistry;
    private classifier: Classifier;
    private tracker: CostTracker;
    private onModelFallback?: ModelFallbackCallback;
    private retryBaseDelayMs: number;
    private sessionId: string | undefined;

    constructor(registry: ModelRegistry, onModelFallback?: ModelFallbackCallback, options: GatewayOptions = {}) {
        this.registry = registry;
        if (onModelFallback !== undefined) this.onModelFallback = onModelFallback;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
        this.sessionId = options.sessionId;
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
     * Embed texts with `modelId` through the gateway's OpenAI-compatible
     * `/embeddings` endpoint. Returns one vector per input, in input order.
     */
    async embed(texts: string[], modelId: string): Promise<number[][]> {
        if (texts.length === 0) return [];
        return Tracer.startSpan("llm.embedding", "llm", async (span) => {
            span.attributes.modelId = modelId;
            span.attributes.inputCount = texts.length;
            const response = await this.clientFor(modelId).embeddings.create({
                model: this.upstreamModelName(modelId),
                input: texts,
            });
            // The API may return items out of order; `index` is authoritative.
            const vectors: number[][] = new Array(texts.length);
            for (const item of response.data) {
                vectors[item.index] = item.embedding;
            }
            if (vectors.some((v) => !Array.isArray(v))) {
                throw new Error(`Embedding model "${modelId}" returned ${response.data.length} vectors for ${texts.length} inputs.`);
            }
            const inputTokens = response.usage?.prompt_tokens ?? 0;
            span.attributes.inputTokens = inputTokens;
            await this.recordUsage(modelId, inputTokens, 0, [{ role: "user", content: `[embedding × ${texts.length}]` }]);
            return vectors;
        });
    }

    /** An `Embedder` bound to one embedding model (for SemanticMemory). */
    embedder(modelId: string): { modelId: string; embed(texts: string[]): Promise<number[][]> } {
        return { modelId, embed: (texts) => this.embed(texts, modelId) };
    }

    /** Routing configuration (tiers, thresholds) from the underlying registry. */
    getRoutingConfig(): RoutingConfig {
        return this.registry.getRoutingConfig();
    }

    /**
     * The application-level failover chain: the configured one, or the complex-tier
     * model followed by the default fallbacks.
     */
    private failoverChain(): string[] {
        return this.registry.getGatewayConfig().failoverChain
            ?? [this.registry.getRoutingConfig().tiers.complex, ...DEFAULT_FALLBACK_MODELS];
    }

    /**
     * Compute the USD cost of a call from the model's configured pricing.
     * Returns 0 when no pricing is configured so usage is still recorded.
     */
    private computeCost(modelId: string, inputTokens: number, outputTokens: number): number {
        const pricing = this.registry.get(modelId)?.pricing;
        if (!pricing) return 0;
        return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000;
    }

    /**
     * Parse tool-call arguments emitted by the model. Models occasionally emit
     * malformed JSON; instead of failing the whole completion we surface the
     * problem to the agent loop as an empty argument object plus a parse error,
     * which the tool will reject with a clear message the model can act on.
     */
    private parseToolArguments(raw: string): { args: Record<string, unknown>; parseError?: string } {
        if (!raw || raw.trim() === "") return { args: {} };
        try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return { args: parsed as Record<string, unknown> };
            }
            return { args: {}, parseError: `tool arguments must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}` };
        } catch (err) {
            return { args: {}, parseError: err instanceof Error ? err.message : String(err) };
        }
    }

    /** Provider-specific request parameters configured for the model (`models[].extraParams`). */
    private extraParams(modelId: string): Record<string, unknown> {
        return this.registry.get(modelId)?.extraParams ?? {};
    }

    /**
     * Issue one chat-completion request. With `onToken`, the request is streamed:
     * text deltas are forwarded as they arrive and tool-call fragments are stitched
     * back together, yielding the same response shape as a non-streaming call.
     */
    private async requestCompletion(
        client: OpenAI,
        params: Record<string, unknown>,
        onToken?: (delta: string) => void,
    ): Promise<CompletionResponse> {
        if (!onToken) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (await client.chat.completions.create(params as any)) as unknown as CompletionResponse;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = (await (client.chat.completions.create as any)({
            ...params,
            stream: true,
            stream_options: { include_usage: true },
        })) as AsyncIterable<{
            choices: Array<{
                delta?: {
                    content?: string | null;
                    tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
                };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        }>;

        let content = "";
        let emitted = false;
        const calls: Array<{ id: string; function: { name: string; arguments: string } }> = [];
        let usage: CompletionResponse["usage"];

        try {
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                if (delta?.content) {
                    content += delta.content;
                    emitted = true;
                    onToken(delta.content);
                }
                for (const fragment of delta?.tool_calls ?? []) {
                    // Fragments of one call share an index; id and name arrive once,
                    // the JSON arguments in pieces.
                    const index = fragment.index ?? calls.length - 1;
                    const call = (calls[index] ??= { id: "", function: { name: "", arguments: "" } });
                    if (fragment.id) call.id = fragment.id;
                    if (fragment.function?.name) call.function.name += fragment.function.name;
                    if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
                }
                if (chunk.usage) usage = chunk.usage;
            }
        } catch (err) {
            // Text already reached the user: retrying or failing over would repeat it.
            throw emitted ? new PartialStreamError(err) : err;
        }

        const toolCalls = calls.filter(Boolean).filter((c) => c.function.name);
        return {
            choices: [{ message: { content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) } }],
            ...(usage ? { usage } : {}),
        };
    }

    /**
     * Resolve routing decision based on modelId override, auto-routing, or default.
     * Passes previous messages as context so the classifier can judge cumulative complexity.
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
            // The last user message is the prompt to classify.
            // All earlier messages provide conversation history for context.
            const lastUserIdx = [...messages].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "user")?.i ?? -1;
            const currentPrompt = lastUserIdx >= 0 ? messages[lastUserIdx]!.content : "";
            const recentHistory = lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : [];
            return this.classifier.classify(currentPrompt, recentHistory);
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
        const generator = this._streamWithFailover(messages, decision);
        return { generator, decision };
    }

    /**
     * Streaming counterpart of `complete()`'s failover: when the selected model is
     * the head of the failover chain, a stream that fails before producing any
     * output falls back to the next model in the chain (emitting `onModelFallback`).
     * Once content has been yielded we cannot transparently switch models, so the
     * error is propagated instead.
     */
    private async *_streamWithFailover(
        messages: ChatMessage[],
        decision: RoutingDecision
    ): AsyncGenerator<string> {
        const chain = this.failoverChain();
        const candidates =
            chain.indexOf(decision.selectedModelId) === 0 && chain.length > 1
                ? chain
                : [decision.selectedModelId];

        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
            const modelId = candidates[i]!;
            let yielded = false;
            try {
                for await (const chunk of this._streamCompletion(messages, modelId)) {
                    yielded = true;
                    yield chunk;
                }
                return;
            } catch (err) {
                if (yielded) throw err;
                lastError = err;
                const reason = err instanceof Error ? err.message : String(err);
                const nextModel = candidates[i + 1];
                if (!nextModel) break;
                process.stderr.write(`[gateway] stream failover: model "${modelId}" failed: ${reason}\n`);
                process.stderr.write(`[gateway] stream failover: trying "${nextModel}"\n`);
                this.onModelFallback?.(modelId, nextModel, reason);
            }
        }
        throw lastError;
    }

    /**
     * Non-streaming completion with optional tool calling support.
     * For complex-tier models, automatically falls back through the configured
     * failover chain on transient 4xx/5xx or network errors.
     * Used by the agent runtime for tool-call turns.
     */
    async complete(
        messages: ChatMessage[],
        modelId: string,
        tools?: OpenAITool[],
        options: CompleteOptions = {},
    ): Promise<{
        message: ChatMessage;
        usage: { inputTokens: number; outputTokens: number };
    }> {
        // Determine if this model is part of the failover chain
        const failoverChain = this.failoverChain();
        const chainIdx = failoverChain.indexOf(modelId);

        // Only apply failover if the requested model is the head of the chain
        if (chainIdx === 0 && failoverChain.length > 1) {
            return this.completeWithFailover(messages, failoverChain, tools, options);
        }

        return this._completeSingleModel(messages, modelId, tools, options);
    }

    /**
     * Walks the failover chain in order, trying each model until one succeeds.
     * Calls onModelFallback when switching models so callers can emit SSE events.
     */
    async completeWithFailover(
        messages: ChatMessage[],
        chain: string[],
        tools?: OpenAITool[],
        options: CompleteOptions = {},
    ): Promise<{
        message: ChatMessage;
        usage: { inputTokens: number; outputTokens: number };
    }> {
        let lastError: unknown;
        for (let i = 0; i < chain.length; i++) {
            const modelId = chain[i]!;
            try {
                const result = await this._completeSingleModel(messages, modelId, tools, options);
                return result;
            } catch (err) {
                // Part of the answer was already streamed — another model would repeat it.
                if (err instanceof PartialStreamError) throw err;
                lastError = err;
                const reason = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[gateway] failover: model "${modelId}" failed: ${reason}\n`);

                const nextModel = chain[i + 1];
                if (nextModel) {
                    process.stderr.write(`[gateway] failover: trying "${nextModel}"\n`);
                    this.onModelFallback?.(modelId, nextModel, reason);
                }
            }
        }
        throw lastError;
    }

    /**
     * Internal: single-model completion with 3-attempt retry on transient errors.
     */
    private async _completeSingleModel(
        messages: ChatMessage[],
        modelId: string,
        tools?: OpenAITool[],
        options: CompleteOptions = {},
    ): Promise<{
        message: ChatMessage;
        usage: { inputTokens: number; outputTokens: number };
    }> {
        return Tracer.startSpan(
            "llm.completion",
            "llm",
            async (span) => {
                span.attributes.model = modelId;
                span.attributes.toolCount = tools?.length ?? 0;
                span.attributes.messageCount = messages.length;

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
                    // Provider-specific parameters from the model's config
                    ...this.extraParams(modelId),
                };

                if (tools && tools.length > 0) {
                    requestParams["tools"] = tools;
                    requestParams["tool_choice"] = "auto";
                    // Force one tool call per turn. Some Groq Llama variants produce
                    // malformed JSON when generating multiple tool calls simultaneously.
                    requestParams["parallel_tool_calls"] = false;
                }

                let response: CompletionResponse | undefined;
                let lastError: unknown;
                // Retry up to 3 times total. Groq/Llama models occasionally generate
                // malformed tool-call output that causes a 400; retrying usually succeeds.
                const client = this.clientFor(modelId);
                const upstreamModel = this.upstreamModelName(modelId);
                for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    try {
                        response = await this.requestCompletion(
                            client,
                            { ...requestParams, model: upstreamModel },
                            options.onToken,
                        );
                        break; // success
                    } catch (err) {
                        if (err instanceof PartialStreamError) throw err; // never retry over streamed text
                        lastError = err;
                        const msg = err instanceof Error ? err.message : String(err);
                        process.stderr.write(`[gateway] attempt ${attempt} failed: ${msg}\n`);
                        if (attempt < MAX_ATTEMPTS && this.retryBaseDelayMs > 0) {
                            // Small linear backoff before retry
                            await new Promise((r) => setTimeout(r, this.retryBaseDelayMs * attempt));
                        }
                    }
                }

                if (!response) {
                    // All tool-enabled attempts failed. Fall back to plain text so the
                    // model can at least give a useful response from its knowledge.
                    process.stderr.write(`[gateway] all tool-call attempts failed, falling back to text-only\n`);
                    if (tools && tools.length > 0) {
                        const fallbackParams = { model: upstreamModel, messages: openaiMessages };
                        response = await this.requestCompletion(client, fallbackParams, options.onToken);
                    } else {
                        throw lastError;
                    }
                }

                const choice = response.choices[0];
                if (!choice) throw new Error("No response from model.");

                const inputTokens = response.usage?.prompt_tokens ?? 0;
                const outputTokens = response.usage?.completion_tokens ?? 0;

                // Capture token usage in span attributes
                span.attributes.inputTokens = inputTokens;
                span.attributes.outputTokens = outputTokens;

                // Parse tool calls from the response
                let toolCalls: ToolCall[] | undefined;
                if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
                    const parseErrors: string[] = [];
                    toolCalls = choice.message.tool_calls.map((tc) => {
                        const { args, parseError } = this.parseToolArguments(tc.function.arguments);
                        if (parseError) {
                            parseErrors.push(`${tc.function.name}: ${parseError}`);
                            process.stderr.write(
                                `[gateway] malformed tool arguments for "${tc.function.name}": ${parseError}\n`
                            );
                        }
                        return { id: tc.id, name: tc.function.name, arguments: args };
                    });
                    span.attributes.returnedToolCalls = toolCalls.map((tc) => tc.name);
                    if (parseErrors.length > 0) span.attributes.toolArgumentParseErrors = parseErrors;
                }

                const message: ChatMessage = {
                    role: "assistant",
                    content: choice.message.content ?? "",
                    ...(toolCalls ? { toolCalls } : {}),
                };

                // Record usage
                await this.recordUsage(modelId, inputTokens, outputTokens, messages);

                return { message, usage: { inputTokens, outputTokens } };
            }
        );
    }


    private async *_streamCompletion(
        messages: ChatMessage[],
        modelId: string
    ): AsyncGenerator<string> {
        const client = this.clientFor(modelId);
        const upstreamModel = this.upstreamModelName(modelId);

        const extraParams = this.extraParams(modelId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = (await (client.chat.completions.create as any)({
            model: upstreamModel,
            messages: plainConversation(messages),
            stream: true,
            stream_options: { include_usage: true },
            ...extraParams,
        })) as import("openai/streaming").Stream<import("openai/resources").ChatCompletionChunk>;

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

        await this.recordUsage(modelId, inputTokens, outputTokens, messages);
    }

    /**
     * Persist token usage and cost for one LLM call. Best-effort: a database
     * problem must never turn a successful model response into a failed request.
     */
    private async recordUsage(
        modelId: string,
        inputTokens: number,
        outputTokens: number,
        messages: ChatMessage[],
    ): Promise<void> {
        const record = {
            timestamp: new Date().toISOString(),
            modelId,
            inputTokens,
            outputTokens,
            costUsd: this.computeCost(modelId, inputTokens, outputTokens),
            promptPreview: messages.at(-1)?.content.slice(0, 200) ?? "",
        };
        const sessionId = this.sessionId ?? Tracer.currentSessionId();
        try {
            if (sessionId) {
                try {
                    await this.tracker.record({ ...record, sessionId });
                    return;
                } catch {
                    // The session row may not exist (unsaved chat, deleted mid-turn).
                    // Losing the attribution is acceptable; losing the usage is not.
                }
            }
            await this.tracker.record(record);
        } catch (err) {
            process.stderr.write(
                `[gateway] failed to record usage for ${modelId}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
        }
    }
}

/**
 * Messages for a tool-less completion. Persisted sessions also contain tool-call
 * and tool-result messages; without the matching tool definitions a provider
 * rejects those, so only the conversational turns with actual text are sent.
 */
function plainConversation(messages: ChatMessage[]): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    return messages
        .filter((m) => m.role !== "tool" && m.content.trim() !== "")
        .map((m) => ({ role: m.role as "system" | "user" | "assistant", content: m.content }));
}
