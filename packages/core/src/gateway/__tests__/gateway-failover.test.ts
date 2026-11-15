import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb, rawExecutor } from "../../db/client.js";
import { Gateway } from "../gateway.js";
import type { ChatMessage } from "@pantheon/shared";

// ── DB mock ───────────────────────────────────────────────────────────────────
let _testDb: ReturnType<typeof createTestDb> | null = null;

vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_testDb) _testDb = createTestDb(new Database(":memory:"));
            return _testDb;
        },
    };
});

// ── Registry mock builder ─────────────────────────────────────────────────────
// Gateway calls: registry.getGatewayConfig(), registry.getRoutingConfig(),
//                registry.get(modelId) (in upstreamModelName)

function makeRegistry(failoverChain?: string[], knownModels: string[] = []) {
    return {
        getGatewayConfig: vi.fn(() => ({
            baseUrl: "http://localhost:11434/v1",
            masterKey: "test-key",
            ...(failoverChain !== undefined ? { failoverChain } : {}),
        })),
        getRoutingConfig: vi.fn(() => ({
            enabled: true,
            tiers: {
                general: "llama-smart",
                simple: "llama-smart",
                standard: "deepseek-v4-flash",
                complex: "deepseek-v4-pro",
            },
            routingContextDepth: 5,
        })),
        /**
         * Called by upstreamModelName() / computeCost() — returns undefined so modelId is
         * used as-is. resolveRouting() with an explicit modelId requires the model to exist,
         * so stream() tests pass the ids they use via `knownModels`.
         */
        get: vi.fn((id: string) => (knownModels.includes(id) ? { id, provider: "test" } : undefined)),
    };
}

// ── OpenAI patch helper ───────────────────────────────────────────────────────
// Gateway creates `this.client` in the constructor. We replace the underlying
// `chat.completions.create` function on that same object.

function patchCompletions(gateway: Gateway, responses: Map<string, string | Error>) {
    const mockCreate = vi.fn(async (params: { model: string }) => {
        const resp = responses.get(params.model);
        if (resp instanceof Error) throw resp;
        return {
            choices: [
                {
                    message: { role: "assistant", content: resp ?? `reply from ${params.model}` },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
        };
    });
    (gateway as any).client.chat = { completions: { create: mockCreate } };
    return mockCreate;
}

function patchCompletionsFn(gateway: Gateway, fn: (params: { model: string }) => Promise<unknown>) {
    const mockCreate = vi.fn(fn);
    (gateway as any).client.chat = { completions: { create: mockCreate } };
    return mockCreate;
}

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

/** No real sleeps between retry attempts — keeps this file fast and deterministic. */
const FAST = { retryBaseDelayMs: 0 };

describe("Gateway — failover chain (v0.8)", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    // ── completeWithFailover ──────────────────────────────────────────────────

    describe("completeWithFailover()", () => {
        it("succeeds immediately with the first model if it works", async () => {
            const registry = makeRegistry(["model-a", "model-b"]);
            const gateway = new Gateway(registry as any, undefined, FAST);
            const create = patchCompletions(gateway, new Map<string, string | Error>([
                ["model-a", "response from A"],
                ["model-b", "response from B"],
            ]));

            const result = await gateway.completeWithFailover(MESSAGES, ["model-a", "model-b"]);
            expect(result.message.content).toBe("response from A");
            // Only one call to model-a
            expect(create).toHaveBeenCalledTimes(1);
        });

        it("tries the next model when the first fails", async () => {
            const registry = makeRegistry(["model-a", "model-b"]);
            const gateway = new Gateway(registry as any, undefined, FAST);
            const create = patchCompletions(gateway, new Map<string, string | Error>([
                ["model-a", new Error("model-a down")],
                ["model-b", "response from B"],
            ]));

            const result = await gateway.completeWithFailover(MESSAGES, ["model-a", "model-b"]);
            expect(result.message.content).toBe("response from B");
            // model-a retried 3 times, then model-b succeeded once = 4 total
            expect(create).toHaveBeenCalledTimes(4);
        });

        it("invokes onModelFallback callback when failing over", async () => {
            const onFallback = vi.fn();
            const registry = makeRegistry(["model-a", "model-b"]);
            const gateway = new Gateway(registry as any, onFallback, FAST);
            patchCompletions(gateway, new Map<string, string | Error>([
                ["model-a", new Error("fail")],
                ["model-b", "ok"],
            ]));

            await gateway.completeWithFailover(MESSAGES, ["model-a", "model-b"]);
            expect(onFallback).toHaveBeenCalledOnce();
            expect(onFallback).toHaveBeenCalledWith("model-a", "model-b", expect.any(String));
        });

        it("throws when ALL models in the chain fail", async () => {
            const registry = makeRegistry(["model-a", "model-b"]);
            const gateway = new Gateway(registry as any, undefined, FAST);
            patchCompletions(gateway, new Map<string, string | Error>([
                ["model-a", new Error("A down")],
                ["model-b", new Error("B down")],
            ]));

            await expect(
                gateway.completeWithFailover(MESSAGES, ["model-a", "model-b"])
            ).rejects.toThrow();
        });

        it("does NOT call onModelFallback when first model succeeds", async () => {
            const onFallback = vi.fn();
            const registry = makeRegistry(["model-a", "model-b"]);
            const gateway = new Gateway(registry as any, onFallback, FAST);
            patchCompletions(gateway, new Map<string, string | Error>([["model-a", "ok"]]));

            await gateway.completeWithFailover(MESSAGES, ["model-a", "model-b"]);
            expect(onFallback).not.toHaveBeenCalled();
        });

        it("walks through three models if first two fail", async () => {
            const onFallback = vi.fn();
            const registry = makeRegistry(["m1", "m2", "m3"]);
            const gateway = new Gateway(registry as any, onFallback, FAST);
            patchCompletions(gateway, new Map<string, string | Error>([
                ["m1", new Error("fail")],
                ["m2", new Error("fail")],
                ["m3", "success"],
            ]));

            const result = await gateway.completeWithFailover(MESSAGES, ["m1", "m2", "m3"]);
            expect(result.message.content).toBe("success");
            // Fell back twice: m1→m2 and m2→m3
            expect(onFallback).toHaveBeenCalledTimes(2);
        });
    });

    // ── complete() failover integration ───────────────────────────────────────

    describe("complete() — failover integration", () => {
        it("activates failover when model is head of the configured chain", async () => {
            const chain = ["deepseek-v4-pro", "claude-fallback"];
            const registry = makeRegistry(chain);
            const onFallback = vi.fn();
            const gateway = new Gateway(registry as any, onFallback, FAST);
            patchCompletions(gateway, new Map<string, string | Error>([
                ["deepseek-v4-pro", new Error("pro down")],
                ["claude-fallback", "fallback response"],
            ]));

            const result = await gateway.complete(MESSAGES, "deepseek-v4-pro");
            expect(result.message.content).toBe("fallback response");
            expect(onFallback).toHaveBeenCalledWith(
                "deepseek-v4-pro",
                "claude-fallback",
                expect.any(String)
            );
        });

        it("does NOT activate failover for a model not in the chain", async () => {
            const chain = ["deepseek-v4-pro", "claude-fallback"];
            const registry = makeRegistry(chain);
            const onFallback = vi.fn();
            const gateway = new Gateway(registry as any, onFallback, FAST);
            // "llama-smart" is not the head of the chain, so no failover
            patchCompletions(gateway, new Map<string, string | Error>([["llama-smart", "direct response"]]));

            const result = await gateway.complete(MESSAGES, "llama-smart");
            expect(result.message.content).toBe("direct response");
            expect(onFallback).not.toHaveBeenCalled();
        });

        it("does NOT activate failover when chain has only one model", async () => {
            const chain = ["deepseek-v4-pro"]; // single model — no failover partner
            const registry = makeRegistry(chain);
            const onFallback = vi.fn();
            const gateway = new Gateway(registry as any, onFallback, FAST);
            patchCompletions(gateway, new Map<string, string | Error>([["deepseek-v4-pro", "ok"]]));

            await gateway.complete(MESSAGES, "deepseek-v4-pro");
            expect(onFallback).not.toHaveBeenCalled();
        });
    });

    // ── Retry logic ───────────────────────────────────────────────────────────

    describe("_completeSingleModel() retry logic", () => {
        it("retries up to 3 times before finally failing", async () => {
            // Use a chain with 1 model so no failover is triggered
            const chain = ["my-model"];
            const registry = makeRegistry(chain);
            const gateway = new Gateway(registry as any, undefined, FAST);
            const create = patchCompletions(gateway, new Map<string, string | Error>([
                ["my-model", new Error("always fails")],
            ]));

            await expect(gateway.complete(MESSAGES, "my-model")).rejects.toThrow();
            // 3 retry attempts before giving up
            expect(create).toHaveBeenCalledTimes(3);
        });

        it("succeeds on the second attempt when first is a transient failure", async () => {
            const chain = ["my-model"];
            const registry = makeRegistry(chain);
            const gateway = new Gateway(registry as any, undefined, FAST);
            let callCount = 0;
            const create = patchCompletionsFn(gateway, async (params) => {
                callCount++;
                if (callCount === 1) throw new Error("transient");
                return {
                    choices: [{ message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                };
            });

            const result = await gateway.complete(MESSAGES, "my-model");
            expect(result.message.content).toBe("recovered");
            expect(callCount).toBe(2);
        });
    });
});


// ── Helpers for streaming tests ───────────────────────────────────────────────

async function* chunksOf(text: string, usage = { prompt_tokens: 3, completion_tokens: 4 }) {
    for (const ch of text.split(" ")) {
        yield { choices: [{ delta: { content: ch + " " } }] };
    }
    yield { choices: [], usage };
}

async function* failingStream(message: string, afterChunks = 0) {
    for (let i = 0; i < afterChunks; i++) {
        yield { choices: [{ delta: { content: `part${i} ` } }] };
    }
    throw new Error(message);
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
    let out = "";
    for await (const c of gen) out += c;
    return out;
}

describe("Gateway — stream() failover", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    it("falls back to the next chain model when the head stream fails before yielding", async () => {
        const onFallback = vi.fn();
        const registry = makeRegistry(["model-a", "model-b"], ["model-a", "model-b"]);
        const gateway = new Gateway(registry as any, onFallback, FAST);
        const create = patchCompletionsFn(gateway, async (params) => {
            if (params.model === "model-a") return failingStream("a is down");
            return chunksOf("hello from b");
        });

        const { generator } = await gateway.stream(MESSAGES, "model-a");
        const text = await collect(generator);

        expect(text.trim()).toBe("hello from b");
        expect(onFallback).toHaveBeenCalledWith("model-a", "model-b", "a is down");
        expect(create).toHaveBeenCalledTimes(2);
    });

    it("does not switch models once content has been streamed", async () => {
        const onFallback = vi.fn();
        const registry = makeRegistry(["model-a", "model-b"], ["model-a", "model-b"]);
        const gateway = new Gateway(registry as any, onFallback, FAST);
        patchCompletionsFn(gateway, async (params) => {
            if (params.model === "model-a") return failingStream("mid-stream failure", 2);
            return chunksOf("should not be used");
        });

        const { generator } = await gateway.stream(MESSAGES, "model-a");
        await expect(collect(generator)).rejects.toThrow("mid-stream failure");
        expect(onFallback).not.toHaveBeenCalled();
    });

    it("does not fail over for models that are not the head of the chain", async () => {
        const onFallback = vi.fn();
        const registry = makeRegistry(["model-a", "model-b"], ["model-a", "model-b"]);
        const gateway = new Gateway(registry as any, onFallback, FAST);
        const create = patchCompletionsFn(gateway, async () => failingStream("b is down"));

        const { generator } = await gateway.stream(MESSAGES, "model-b");
        await expect(collect(generator)).rejects.toThrow("b is down");
        expect(onFallback).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("throws the last error when every model in the chain fails", async () => {
        const registry = makeRegistry(["m1", "m2"], ["m1", "m2"]);
        const gateway = new Gateway(registry as any, undefined, FAST);
        patchCompletionsFn(gateway, async (params) => failingStream(`${params.model} down`));

        const { generator } = await gateway.stream(MESSAGES, "m1");
        await expect(collect(generator)).rejects.toThrow("m2 down");
    });
});

describe("Gateway — tool-call argument parsing", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    it("does not throw on malformed tool-call JSON; returns empty arguments instead", async () => {
        const registry = makeRegistry(["solo"]);
        const gateway = new Gateway(registry as any, undefined, FAST);
        patchCompletionsFn(gateway, async () => ({
            choices: [
                {
                    message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [
                            { id: "c1", type: "function", function: { name: "read_file", arguments: "{not json" } },
                            { id: "c2", type: "function", function: { name: "grep", arguments: '{"pattern":"x"}' } },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));

        const result = await gateway.complete(MESSAGES, "solo", [
            { type: "function", function: { name: "read_file", description: "", parameters: { type: "object", properties: {}, required: [] } } },
        ]);

        expect(result.message.toolCalls).toHaveLength(2);
        expect(result.message.toolCalls?.[0]).toEqual({ id: "c1", name: "read_file", arguments: {} });
        expect(result.message.toolCalls?.[1]).toEqual({ id: "c2", name: "grep", arguments: { pattern: "x" } });
    });
});

describe("Gateway — cost computation", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    it("records costUsd from the model's configured pricing", async () => {
        const registry = makeRegistry(["priced"]);
        registry.get = vi.fn((id: string) =>
            id === "priced" ? { id, provider: "test", pricing: { inputPer1M: 1, outputPer1M: 2 } } : undefined
        ) as any;
        const gateway = new Gateway(registry as any, undefined, FAST);
        patchCompletionsFn(gateway, async () => ({
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
        }));

        await gateway.complete(MESSAGES, "priced");

        const [row] = await rawExecutor(_testDb!).all<{ cost_usd: number; model_id: string }>(
            "SELECT cost_usd, model_id FROM usage_records",
        );
        expect(row?.model_id).toBe("priced");
        expect(row?.cost_usd).toBeCloseTo(1 * 1 + 0.5 * 2, 6);
    });

    it("records costUsd = 0 when the model has no pricing", async () => {
        const registry = makeRegistry(["free"]);
        const gateway = new Gateway(registry as any, undefined, FAST);
        patchCompletionsFn(gateway, async () => ({
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
        }));

        await gateway.complete(MESSAGES, "free");
        const [row] = await rawExecutor(_testDb!).all<{ cost_usd: number }>("SELECT cost_usd FROM usage_records");
        expect(row?.cost_usd).toBe(0);
    });
});

describe("Gateway — per-session usage attribution", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    const okResponse = async () => ({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const usageRows = () =>
        rawExecutor(_testDb!).all<{ session_id: string | null; input_tokens: number }>(
            "SELECT session_id, input_tokens FROM usage_records",
        );
    const createSession = async (id: string) => {
        await rawExecutor(_testDb!).exec(
            `INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('${id}', 't', 'now', 'now')`,
        );
    };

    it("stamps usage with the gateway's sessionId", async () => {
        await createSession("sess-1");
        const gateway = new Gateway(makeRegistry() as any, undefined, { ...FAST, sessionId: "sess-1" });
        patchCompletionsFn(gateway, okResponse);
        await gateway.complete(MESSAGES, "m");
        expect(await usageRows()).toEqual([{ session_id: "sess-1", input_tokens: 7 }]);
    });

    it("falls back to the session of the active trace", async () => {
        await createSession("traced");
        const { Tracer } = await import("../../tracing/tracer.js");
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        patchCompletionsFn(gateway, okResponse);
        await Tracer.startTrace("traced", () => gateway.complete(MESSAGES, "m"));
        expect((await usageRows())[0]?.session_id).toBe("traced");
    });

    it("records usage without a session when none is known", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        patchCompletionsFn(gateway, okResponse);
        await gateway.complete(MESSAGES, "m");
        expect(await usageRows()).toEqual([{ session_id: null, input_tokens: 7 }]);
    });

    it("still records the usage when the session row does not exist", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, { ...FAST, sessionId: "never-saved" });
        patchCompletionsFn(gateway, okResponse);
        const result = await gateway.complete(MESSAGES, "m");
        expect(result.message.content).toBe("ok");
        expect(await usageRows()).toEqual([{ session_id: null, input_tokens: 7 }]);
    });

    it("a completely failing usage write never fails the model call", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        patchCompletionsFn(gateway, okResponse);
        (gateway as any).tracker = { record: vi.fn().mockRejectedValue(new Error("disk full")) };
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            await expect(gateway.complete(MESSAGES, "m")).resolves.toMatchObject({ message: { content: "ok" } });
            expect(String(stderr.mock.calls.at(-1)?.[0])).toMatch(/failed to record usage.*disk full/);
        } finally {
            stderr.mockRestore();
        }
    });
});

describe("Gateway — streaming completions (onToken)", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    type Chunk = { choices: Array<{ delta?: Record<string, unknown> }>; usage?: { prompt_tokens: number; completion_tokens: number } };
    const chunk = (delta: Record<string, unknown>): Chunk => ({ choices: [{ delta }] });
    /** A fake streaming response: yields the chunks, optionally failing part-way. */
    function streamOf(chunks: Chunk[], failAfter?: number) {
        return (async function* () {
            for (let i = 0; i < chunks.length; i++) {
                if (failAfter !== undefined && i === failAfter) throw new Error("connection reset");
                yield chunks[i]!;
            }
        })();
    }

    it("forwards text as it arrives and returns the same message a non-streaming call would", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        const create = patchCompletionsFn(gateway, async () => streamOf([
            chunk({ role: "assistant", content: "Hel" }),
            chunk({ content: "lo " }),
            chunk({ content: "world" }),
            { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
        ]) as never);

        const tokens: string[] = [];
        const result = await gateway.complete(MESSAGES, "m", undefined, { onToken: (t) => tokens.push(t) });

        expect(tokens).toEqual(["Hel", "lo ", "world"]);
        expect(result.message).toEqual({ role: "assistant", content: "Hello world" });
        expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
        expect((create.mock.calls[0]![0] as any).stream).toBe(true);
        expect((create.mock.calls[0]![0] as any).stream_options).toEqual({ include_usage: true });
    });

    it("stitches tool calls back together from fragments, including two calls interleaved by index", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        patchCompletionsFn(gateway, async () => streamOf([
            chunk({ content: "Looking." }),
            chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "" } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
            chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "grep", arguments: '{"pat' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
            chunk({ tool_calls: [{ index: 1, function: { arguments: 'tern":"x"}' } }] }),
        ]) as never);

        const tokens: string[] = [];
        const result = await gateway.complete(MESSAGES, "m", [], { onToken: (t) => tokens.push(t) });

        expect(tokens).toEqual(["Looking."]); // tool-call fragments are not text
        expect(result.message.content).toBe("Looking.");
        expect(result.message.toolCalls).toEqual([
            { id: "call_a", name: "read_file", arguments: { path: "a.ts" } },
            { id: "call_b", name: "grep", arguments: { pattern: "x" } },
        ]);
    });

    it("does not request a stream when no onToken is given", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        const create = patchCompletions(gateway, new Map([["m", "plain"]]));
        await gateway.complete(MESSAGES, "m");
        expect((create.mock.calls[0]![0] as any).stream).toBeUndefined();
    });

    it("retries a stream that failed before producing any text", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        let attempt = 0;
        const create = patchCompletionsFn(gateway, async () => {
            attempt++;
            return (attempt === 1 ? streamOf([chunk({ content: "x" })], 0) : streamOf([chunk({ content: "recovered" })])) as never;
        });
        const tokens: string[] = [];
        const result = await gateway.complete(MESSAGES, "m", undefined, { onToken: (t) => tokens.push(t) });
        expect(result.message.content).toBe("recovered");
        expect(tokens).toEqual(["recovered"]);
        expect(create).toHaveBeenCalledTimes(2);
    });

    it("never retries or fails over once text has reached the caller (it would be repeated)", async () => {
        const registry = makeRegistry(["model-a", "model-b"]);
        const onFallback = vi.fn();
        const gateway = new Gateway(registry as any, onFallback, FAST);
        const create = patchCompletionsFn(gateway, async () =>
            streamOf([chunk({ content: "Half an ans" }), chunk({ content: "wer" })], 1) as never);

        const tokens: string[] = [];
        await expect(gateway.complete(MESSAGES, "model-a", undefined, { onToken: (t) => tokens.push(t) }))
            .rejects.toThrow("connection reset");
        expect(tokens).toEqual(["Half an ans"]);
        expect(create).toHaveBeenCalledTimes(1);   // no retry on model-a
        expect(onFallback).not.toHaveBeenCalled(); // no failover to model-b
    });

    it("fails over before any text was produced", async () => {
        const registry = makeRegistry(["model-a", "model-b"]);
        const onFallback = vi.fn();
        const gateway = new Gateway(registry as any, onFallback, FAST);
        patchCompletionsFn(gateway, async (params) => {
            if (params.model === "model-a") throw new Error("503");
            return streamOf([chunk({ content: "from b" })]) as never;
        });
        const tokens: string[] = [];
        const result = await gateway.complete(MESSAGES, "model-a", undefined, { onToken: (t) => tokens.push(t) });
        expect(result.message.content).toBe("from b");
        expect(tokens).toEqual(["from b"]);
        expect(onFallback).toHaveBeenCalledWith("model-a", "model-b", expect.any(String));
    });
});

describe("Gateway — model parameters come from config", () => {
    beforeEach(() => {
        _testDb = createTestDb(new Database(":memory:"));
    });

    it("sends a model's extraParams with every request, and nothing extra for other models", async () => {
        const registry = makeRegistry();
        registry.get = vi.fn((id: string) =>
            id === "reasoner" ? { id, provider: "x", extraParams: { thinking: { type: "enabled" }, reasoning_effort: "high" } } : { id, provider: "x" },
        ) as any;
        const gateway = new Gateway(registry as any, undefined, FAST);
        const create = patchCompletions(gateway, new Map());

        await gateway.complete(MESSAGES, "reasoner");
        await gateway.complete(MESSAGES, "plain");

        expect(create.mock.calls[0]![0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
        expect(create.mock.calls[1]![0]).not.toHaveProperty("thinking");
    });

    it("the default failover chain starts at the configured complex-tier model", async () => {
        const registry = makeRegistry(); // no explicit chain; tiers.complex = deepseek-v4-pro
        const onFallback = vi.fn();
        const gateway = new Gateway(registry as any, onFallback, FAST);
        patchCompletions(gateway, new Map<string, string | Error>([["deepseek-v4-pro", new Error("down")], ["claude-fallback", "rescued"]]));
        const result = await gateway.complete(MESSAGES, "deepseek-v4-pro");
        expect(result.message.content).toBe("rescued");
        expect(onFallback).toHaveBeenCalledWith("deepseek-v4-pro", "claude-fallback", expect.any(String));
    });

    it("records the classifier's own token usage", async () => {
        const gateway = new Gateway(makeRegistry() as any, undefined, FAST);
        patchCompletionsFn(gateway, async () => ({
            choices: [{ message: { role: "assistant", content: "standard 0.9" } }],
            usage: { prompt_tokens: 120, completion_tokens: 3 },
        }));
        await gateway.resolveRouting([{ role: "user", content: "refactor the session manager to use transactions" }]);
        const rows = await rawExecutor(_testDb!).all<{ model_id: string; input_tokens: number; prompt_preview: string }>(
            "SELECT model_id, input_tokens, prompt_preview FROM usage_records",
        );
        expect(rows).toEqual([{ model_id: "llama-smart", input_tokens: 120, prompt_preview: expect.stringContaining("[routing]") }]);
    });
});
