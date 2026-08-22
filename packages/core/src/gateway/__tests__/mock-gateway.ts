import type { ChatMessage, ToolCall } from "@pantheon/shared";
import type { OpenAITool } from "../../tools/tool-registry.js";

export interface MockTextResponse {
    type: "text";
    content: string;
}

export interface MockToolCallResponse {
    type: "tool_call";
    toolCalls: ToolCall[];
    content?: string; // Optional text alongside tool calls
}

export type MockResponse = MockTextResponse | MockToolCallResponse;

export interface GatewayCall {
    messages: ChatMessage[];
    modelId: string;
    tools?: OpenAITool[];
}

/**
 * Deterministic mock Gateway for use in tests.
 *
 * Usage:
 * ```typescript
 * const mock = new MockGateway();
 * mock.addTextResponse("Hello world");
 * mock.addToolCallResponse([{ id: "1", name: "read_file", arguments: { path: "foo.ts" } }]);
 * mock.addTextResponse("Here's the file content...");
 *
 * const agent = new AgentRuntime(mock as unknown as Gateway, registry, config);
 * ```
 */
export class MockGateway {
    private queue: MockResponse[] = [];
    private calls: GatewayCall[] = [];

    /** Queue a plain text response */
    addTextResponse(content: string): this {
        this.queue.push({ type: "text", content });
        return this;
    }

    /** Queue a tool-call response (LLM requests one or more tools) */
    addToolCallResponse(toolCalls: ToolCall[], content = ""): this {
        this.queue.push({ type: "tool_call", toolCalls, content });
        return this;
    }

    /** Get all calls made (for assertions) */
    getCalls(): GatewayCall[] {
        return [...this.calls];
    }

    /** Number of responses still queued */
    get pendingCount(): number {
        return this.queue.length;
    }

    /** Clear all queued responses and call history */
    reset(): this {
        this.queue = [];
        this.calls = [];
        return this;
    }

    /** Simulates Gateway.complete() — pops the next queued response */
    async complete(
        messages: ChatMessage[],
        modelId: string,
        tools?: OpenAITool[]
    ): Promise<{ message: ChatMessage; usage: { inputTokens: number; outputTokens: number } }> {
        this.calls.push({ messages: [...messages], modelId, ...(tools ? { tools } : {}) });

        const next = this.queue.shift();
        if (!next) {
            // Return a plain done response if queue is empty
            return {
                message: { role: "assistant", content: "[MockGateway: no more queued responses]" },
                usage: { inputTokens: 0, outputTokens: 0 },
            };
        }

        if (next.type === "text") {
            return {
                message: { role: "assistant", content: next.content },
                usage: { inputTokens: 10, outputTokens: 20 },
            };
        }

        // Tool call response
        return {
            message: {
                role: "assistant",
                content: next.content ?? "",
                toolCalls: next.toolCalls,
            },
            usage: { inputTokens: 10, outputTokens: 30 },
        };
    }

    /** Simulates Gateway.resolveRouting() — always returns "standard" routing */
    async resolveRouting(
        _messages: ChatMessage[],
        modelId?: string
    ): Promise<{ tier: string; selectedModelId: string; reason: string }> {
        return {
            tier: "standard",
            selectedModelId: modelId ?? "mock-model",
            reason: "mock routing",
        };
    }

    /** Simulates Gateway.stream() — wraps text response as an async generator */
    async stream(
        messages: ChatMessage[],
        modelId?: string
    ): Promise<{ generator: AsyncGenerator<string>; decision: { tier: string; selectedModelId: string; reason: string } }> {
        const next = this.queue.shift() ?? { type: "text" as const, content: "" };
        const content = next.type === "text" ? next.content : JSON.stringify(next.toolCalls);

        async function* gen(): AsyncGenerator<string> {
            yield content;
        }

        return {
            generator: gen(),
            decision: { tier: "standard", selectedModelId: modelId ?? "mock-model", reason: "mock" },
        };
    }
}
