import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../db/client.js";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentConfig } from "../agent-runtime.js";
import type { ChatMessage, ToolCall, ToolResult, RoutingDecision } from "@pantheon/shared";
import type { Gateway } from "../../gateway/gateway.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import type { Tool } from "../../tools/tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";
import type { PermissionManager } from "../../sandbox/permission-manager.js";

// ── DB mock — redirect getDb() to an in-memory DB so TraceCollector never
// touches the on-disk ~/.pantheon/pantheon.db during tests. ──────────────────
let _testDb: ReturnType<typeof createTestDb> | null = null;

vi.mock("../../db/client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../db/client.js")>();
    return {
        ...original,
        getDb: () => {
            if (!_testDb) {
                _testDb = createTestDb(new Database(":memory:"));
            }
            return _testDb;
        },
    };
});

/**
 * Helper to create a mock Gateway with a configurable complete() sequence.
 * Each call to complete() returns the next response in the sequence.
 */
function createMockGateway(completeResponses: ChatMessage[]): Gateway {
    const completeMock = vi.fn();
    for (const resp of completeResponses) {
        completeMock.mockResolvedValueOnce({
            message: resp,
            usage: { inputTokens: 10, outputTokens: 20 },
        });
    }

    return {
        resolveRouting: vi.fn().mockResolvedValue({
            tier: "standard",
            selectedModelId: "test-model",
            reason: "mock",
        } satisfies RoutingDecision),
        complete: completeMock,
        stream: vi.fn(),
    } as unknown as Gateway;
}

function createMockSandbox(): Sandbox {
    return {
        resolvePath: vi.fn((p: string) => `/project/${p}`),
        validateCommand: vi.fn(),
    } as unknown as Sandbox;
}

function createMockPermissionManager(alwaysAllow = true): PermissionManager {
    return {
        check: vi.fn().mockResolvedValue(alwaysAllow),
    } as unknown as PermissionManager;
}

/** A simple safe tool for testing */
function createTestTool(name = "testTool"): Tool {
    return {
        definition: {
            name,
            description: `A test tool named ${name}`,
            parameters: {
                type: "object" as const,
                properties: {
                    input: {
                        type: "string" as const,
                        description: "Test input",
                    },
                },
                required: ["input"],
            },
            safety: "safe" as const,
        },
        execute: vi.fn().mockResolvedValue("tool result content"),
    };
}

describe("AgentRuntime", () => {
    let sandbox: Sandbox;
    let permissionManager: PermissionManager;
    let config: AgentConfig;

    beforeEach(() => {
        sandbox = createMockSandbox();
        permissionManager = createMockPermissionManager(true);
        config = {
            maxIterations: 10,
            sandbox,
            permissionManager,
        };
    });

    it("returns text response when LLM does not call tools", async () => {
        const gateway = createMockGateway([
            { role: "assistant", content: "Hello, I can help with that!" },
        ]);
        const registry = new ToolRegistry();
        const runtime = new AgentRuntime(gateway, registry, config);

        const result = await runtime.run([
            { role: "user", content: "Hi" },
        ]);

        expect(result.response).toBe("Hello, I can help with that!");
        expect(result.toolCalls).toHaveLength(0);
        expect(result.toolResults).toHaveLength(0);
        expect(result.iterations).toBe(1);
        expect(result.decision.selectedModelId).toBe("test-model");
    });

    it("executes a single tool call and returns final response", async () => {
        const toolCall: ToolCall = {
            id: "call-1",
            name: "testTool",
            arguments: { input: "hello" },
        };

        const gateway = createMockGateway([
            // First response: LLM wants to call a tool
            { role: "assistant", content: "", toolCalls: [toolCall] },
            // Second response: LLM gives final text after seeing tool result
            { role: "assistant", content: "The tool returned: tool result content" },
        ]);

        const tool = createTestTool();
        const registry = new ToolRegistry();
        registry.register(tool);

        const runtime = new AgentRuntime(gateway, registry, config);
        const result = await runtime.run([
            { role: "user", content: "Use the test tool" },
        ]);

        expect(result.response).toBe("The tool returned: tool result content");
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]!.name).toBe("testTool");
        expect(result.toolResults).toHaveLength(1);
        expect(result.toolResults[0]!.content).toBe("tool result content");
        expect(result.toolResults[0]!.isError).toBe(false);
        expect(result.iterations).toBe(2);

        // Tool should have been executed
        expect(tool.execute).toHaveBeenCalledWith({ input: "hello" }, sandbox);
    });

    it("handles multi-iteration tool use (chained calls)", async () => {
        const call1: ToolCall = { id: "call-1", name: "testTool", arguments: { input: "step1" } };
        const call2: ToolCall = { id: "call-2", name: "testTool", arguments: { input: "step2" } };

        const gateway = createMockGateway([
            { role: "assistant", content: "", toolCalls: [call1] },
            { role: "assistant", content: "", toolCalls: [call2] },
            { role: "assistant", content: "Done after two tool calls." },
        ]);

        const tool = createTestTool();
        const registry = new ToolRegistry();
        registry.register(tool);

        const runtime = new AgentRuntime(gateway, registry, config);
        const result = await runtime.run([
            { role: "user", content: "Do two things" },
        ]);

        expect(result.response).toBe("Done after two tool calls.");
        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolResults).toHaveLength(2);
        expect(result.iterations).toBe(3);
        expect(tool.execute).toHaveBeenCalledTimes(2);
    });

    it("handles unknown tool gracefully", async () => {
        const toolCall: ToolCall = {
            id: "call-1",
            name: "nonExistentTool",
            arguments: {},
        };

        const gateway = createMockGateway([
            { role: "assistant", content: "", toolCalls: [toolCall] },
            { role: "assistant", content: "Sorry, that tool doesn't exist." },
        ]);

        const registry = new ToolRegistry();
        // No tools registered

        const runtime = new AgentRuntime(gateway, registry, config);
        const result = await runtime.run([
            { role: "user", content: "Use a fake tool" },
        ]);

        expect(result.toolResults).toHaveLength(1);
        expect(result.toolResults[0]!.isError).toBe(true);
        expect(result.toolResults[0]!.content).toContain("Unknown tool");
        expect(result.toolResults[0]!.content).toContain("nonExistentTool");
    });

    it("respects permission denial", async () => {
        const deniedPermissions = createMockPermissionManager(false);
        const deniedConfig: AgentConfig = { ...config, permissionManager: deniedPermissions };

        const toolCall: ToolCall = {
            id: "call-1",
            name: "testTool",
            arguments: { input: "test" },
        };

        const gateway = createMockGateway([
            { role: "assistant", content: "", toolCalls: [toolCall] },
            { role: "assistant", content: "OK, I won't use that tool." },
        ]);

        const tool = createTestTool();
        const registry = new ToolRegistry();
        registry.register(tool);

        const runtime = new AgentRuntime(gateway, registry, deniedConfig);
        const result = await runtime.run([
            { role: "user", content: "Do something" },
        ]);

        // Tool should NOT have been executed
        expect(tool.execute).not.toHaveBeenCalled();
        // But the denial should be recorded as a tool result
        expect(result.toolResults).toHaveLength(1);
        expect(result.toolResults[0]!.isError).toBe(true);
        expect(result.toolResults[0]!.content).toContain("denied");
    });

    it("caps at maxIterations and forces a final response", async () => {
        const maxIter = 3;
        const cappedConfig: AgentConfig = { ...config, maxIterations: maxIter };

        // Every call returns tool calls — the loop should stop at maxIterations
        const responses: ChatMessage[] = [];
        for (let i = 0; i < maxIter; i++) {
            responses.push({
                role: "assistant",
                content: "",
                toolCalls: [{
                    id: `call-${i}`,
                    name: "testTool",
                    arguments: { input: `iter-${i}` },
                }],
            });
        }
        // The final forced text response after max iterations
        responses.push({
            role: "assistant",
            content: "Reached max iterations, here's what I found.",
        });

        const gateway = createMockGateway(responses);
        const tool = createTestTool();
        const registry = new ToolRegistry();
        registry.register(tool);

        const runtime = new AgentRuntime(gateway, registry, cappedConfig);
        const result = await runtime.run([
            { role: "user", content: "Keep calling tools forever" },
        ]);

        expect(result.iterations).toBe(maxIter);
        expect(result.toolCalls).toHaveLength(maxIter);
        expect(result.response).toBe("Reached max iterations, here's what I found.");
    });

    it("handles tool execution errors", async () => {
        const toolCall: ToolCall = {
            id: "call-1",
            name: "testTool",
            arguments: { input: "crash" },
        };

        const gateway = createMockGateway([
            { role: "assistant", content: "", toolCalls: [toolCall] },
            { role: "assistant", content: "The tool failed, let me try another approach." },
        ]);

        const tool = createTestTool();
        (tool.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("File not found: /does/not/exist")
        );

        const registry = new ToolRegistry();
        registry.register(tool);

        const runtime = new AgentRuntime(gateway, registry, config);
        const result = await runtime.run([
            { role: "user", content: "Read a missing file" },
        ]);

        expect(result.toolResults).toHaveLength(1);
        expect(result.toolResults[0]!.isError).toBe(true);
        expect(result.toolResults[0]!.content).toContain("Error executing tool");
        expect(result.toolResults[0]!.content).toContain("File not found");
    });

    it("fires onToolCall and onToolResult callbacks", async () => {
        const onToolCall = vi.fn();
        const onToolResult = vi.fn();
        const callbackConfig: AgentConfig = { ...config, onToolCall, onToolResult };

        const toolCall: ToolCall = {
            id: "call-1",
            name: "testTool",
            arguments: { input: "test" },
        };

        const gateway = createMockGateway([
            { role: "assistant", content: "", toolCalls: [toolCall] },
            { role: "assistant", content: "Done." },
        ]);

        const tool = createTestTool();
        const registry = new ToolRegistry();
        registry.register(tool);

        const runtime = new AgentRuntime(gateway, registry, callbackConfig);
        await runtime.run([{ role: "user", content: "Do something" }]);

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall).toHaveBeenCalledWith(toolCall, "safe");
        expect(onToolResult).toHaveBeenCalledTimes(1);
        expect(onToolResult).toHaveBeenCalledWith(
            expect.objectContaining({
                toolCallId: "call-1",
                name: "testTool",
                content: "tool result content",
                isError: false,
            })
        );
    });

    it("passes modelId to resolveRouting", async () => {
        const gateway = createMockGateway([
            { role: "assistant", content: "Response" },
        ]);

        const registry = new ToolRegistry();
        const runtime = new AgentRuntime(gateway, registry, config);

        await runtime.run(
            [{ role: "user", content: "Hello" }],
            "custom-model"
        );

        expect(gateway.resolveRouting).toHaveBeenCalledWith(
            [{ role: "user", content: "Hello" }],
            "custom-model"
        );
    });
});


describe("AgentRuntime — run options", () => {
    let sandbox: Sandbox;
    let permissionManager: PermissionManager;
    let config: AgentConfig;

    beforeEach(() => {
        sandbox = createMockSandbox();
        permissionManager = createMockPermissionManager(true);
        config = { maxIterations: 10, sandbox, permissionManager };
    });

    it("uses a caller-provided routing decision instead of re-classifying", async () => {
        const gateway = createMockGateway([{ role: "assistant", content: "done" }]);
        const runtime = new AgentRuntime(gateway, new ToolRegistry(), config);
        const preset: RoutingDecision = { tier: "general", selectedModelId: "llama-smart", reason: "preset" };

        const result = await runtime.run([{ role: "user", content: "hi" }], undefined, { decision: preset });

        expect(gateway.resolveRouting).not.toHaveBeenCalled();
        expect(result.decision).toEqual(preset);
        // The preset model is the one actually used for the completion
        const completeCall = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(completeCall[1]).toBe("llama-smart");
    });

    it("sums token usage across every LLM call in the turn", async () => {
        const toolCall: ToolCall = { id: "tc1", name: "testTool", arguments: { input: "x" } };
        const gateway = createMockGateway([
            { role: "assistant", content: "", toolCalls: [toolCall] },
            { role: "assistant", content: "final" },
        ]);
        const registry = new ToolRegistry();
        registry.register(createTestTool());
        const runtime = new AgentRuntime(gateway, registry, config);

        const result = await runtime.run([{ role: "user", content: "go" }]);

        // Two completions × (10 in / 20 out) from createMockGateway
        expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 40 });
        expect(result.iterations).toBe(2);
    });

    describe("repo map refresh (v0.9)", () => {
        const writeTool = (name: string): Tool => ({
            definition: {
                name,
                description: name,
                parameters: { type: "object" as const, properties: { path: { type: "string" as const, description: "p" } }, required: ["path"] },
                safety: "safe" as const,
            },
            execute: vi.fn().mockResolvedValue("Successfully wrote 3 lines"),
        });
        const call = (id: string, name: string, path: string): ChatMessage => ({
            role: "assistant",
            content: "",
            toolCalls: [{ id, name, arguments: { path } }],
        });
        /**
         * System prompt the gateway saw on its Nth complete() call. Captured at call
         * time: the runtime passes its live message array, so inspecting the mock's
         * recorded arguments afterwards would only ever show the final state.
         */
        const seenPrompts = new WeakMap<Gateway, string[]>();
        const systemPromptOf = (gateway: Gateway, n: number): string => seenPrompts.get(gateway)![n]!;
        const createMockGateway = (responses: ChatMessage[]): Gateway => {
            const prompts: string[] = [];
            const queue = [...responses];
            const gateway = {
                resolveRouting: vi.fn().mockResolvedValue({ tier: "standard", selectedModelId: "test-model", reason: "mock" }),
                complete: vi.fn(async (msgs: ChatMessage[]) => {
                    prompts.push(msgs[0]!.content);
                    return { message: queue.shift()!, usage: { inputTokens: 1, outputTokens: 1 } };
                }),
                stream: vi.fn(),
            } as unknown as Gateway;
            seenPrompts.set(gateway, prompts);
            return gateway;
        };

        it("rebuilds the map after a source file is written and uses it for the next LLM call", async () => {
            const gateway = createMockGateway([
                call("1", "write_file", "src/new-module.ts"),
                { role: "assistant", content: "done" },
            ]);
            const registry = new ToolRegistry();
            registry.register(writeTool("write_file"));
            const refreshRepoMap = vi.fn().mockResolvedValue("MAP v2: new-module.ts exports fn added()");

            const runtime = new AgentRuntime(gateway, registry, { ...config, repoMap: "MAP v1", refreshRepoMap });
            await runtime.run([{ role: "user", content: "add a module" }]);

            expect(refreshRepoMap).toHaveBeenCalledTimes(1);
            expect(systemPromptOf(gateway, 0)).toContain("MAP v1");
            expect(systemPromptOf(gateway, 1)).toContain("MAP v2: new-module.ts exports fn added()");
            expect(systemPromptOf(gateway, 1)).not.toContain("MAP v1");
        });

        it("refreshes once per iteration even when several files are edited", async () => {
            const gateway = createMockGateway([
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [
                        { id: "1", name: "edit_file", arguments: { path: "a.ts" } },
                        { id: "2", name: "edit_file", arguments: { path: "b.tsx" } },
                    ],
                },
                { role: "assistant", content: "done" },
            ]);
            const registry = new ToolRegistry();
            registry.register(writeTool("edit_file"));
            const refreshRepoMap = vi.fn().mockResolvedValue("fresh");

            await new AgentRuntime(gateway, registry, { ...config, repoMap: "old", refreshRepoMap })
                .run([{ role: "user", content: "x" }]);
            expect(refreshRepoMap).toHaveBeenCalledTimes(1);
        });

        it("does not refresh for non-source files, read-only tools, or failed writes", async () => {
            const failing = writeTool("edit_file");
            vi.mocked(failing.execute).mockResolvedValue("Error: targetContent not found");
            const gateway = createMockGateway([
                call("1", "write_file", "README.md"),
                call("2", "testTool", "src/a.ts"),
                call("3", "edit_file", "src/a.ts"),
                { role: "assistant", content: "done" },
            ]);
            const registry = new ToolRegistry();
            registry.register(writeTool("write_file"));
            registry.register(failing);
            registry.register(createTestTool());
            const refreshRepoMap = vi.fn().mockResolvedValue("fresh");

            await new AgentRuntime(gateway, registry, { ...config, repoMap: "old", refreshRepoMap })
                .run([{ role: "user", content: "x" }]);
            expect(refreshRepoMap).not.toHaveBeenCalled();
        });

        it("keeps the previous map when the refresh fails", async () => {
            const gateway = createMockGateway([
                call("1", "write_file", "src/a.ts"),
                { role: "assistant", content: "done" },
            ]);
            const registry = new ToolRegistry();
            registry.register(writeTool("write_file"));
            const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            try {
                const result = await new AgentRuntime(gateway, registry, {
                    ...config,
                    repoMap: "MAP v1",
                    refreshRepoMap: vi.fn().mockRejectedValue(new Error("ts-morph blew up")),
                }).run([{ role: "user", content: "x" }]);

                expect(result.response).toBe("done");
                expect(systemPromptOf(gateway, 1)).toContain("MAP v1");
            } finally {
                stderr.mockRestore();
            }
        });

        it("adds a map on refresh even when none was supplied initially", async () => {
            const gateway = createMockGateway([
                call("1", "write_file", "src/first.ts"),
                { role: "assistant", content: "done" },
            ]);
            const registry = new ToolRegistry();
            registry.register(writeTool("write_file"));

            await new AgentRuntime(gateway, registry, { ...config, refreshRepoMap: async () => "BRAND NEW MAP" })
                .run([{ role: "user", content: "x" }]);
            expect(systemPromptOf(gateway, 0)).not.toContain("## Codebase Map");
            expect(systemPromptOf(gateway, 1)).toContain("## Codebase Map\nBRAND NEW MAP");
        });
    });

    describe("prompt versioning in traces (v0.9)", () => {
        async function turnSpanAttributes(cfg: Partial<AgentConfig>): Promise<Record<string, unknown>> {
            const { TraceCollector } = await import("../../tracing/collector.js");
            const { TraceStore } = await import("../../tracing/store.js");
            _testDb = createTestDb(new Database(":memory:"));
            const gateway = createMockGateway([{ role: "assistant", content: "hi" }]);
            await new AgentRuntime(gateway, new ToolRegistry(), { ...config, ...cfg }).run([{ role: "user", content: "x" }]);
            await TraceCollector.flush();
            const store = new TraceStore(_testDb);
            const [trace] = await store.listTraces(1);
            const spans = await store.getSpans(trace!.traceId);
            return spans.find((s) => s.name === "agent.turn")!.attributes;
        }

        it("records a stable hash of the system prompt on the agent.turn span", async () => {
            const { hashPrompt } = await import("../agent-runtime.js");
            const a = await turnSpanAttributes({});
            const b = await turnSpanAttributes({});
            expect(a["systemPromptHash"]).toMatch(/^[0-9a-f]{12}$/);
            expect(a["systemPromptHash"]).toBe(b["systemPromptHash"]);
            expect(hashPrompt("x")).toBe(hashPrompt("x"));
            expect(hashPrompt("x")).not.toBe(hashPrompt("y"));
        });

        it("changes when the instructions change, but not when only the repo map does", async () => {
            const base = await turnSpanAttributes({});
            const custom = await turnSpanAttributes({ systemPrompt: "Always answer in French." });
            const withMap = await turnSpanAttributes({ repoMap: "some map" });
            expect(custom["systemPromptHash"]).not.toBe(base["systemPromptHash"]);
            expect(withMap["systemPromptHash"]).toBe(base["systemPromptHash"]);
        });
    });

    describe("live text and turn transcript (v0.9.1)", () => {
        const toolCall = (id: string): ChatMessage => ({ role: "assistant", content: "Let me check.", toolCalls: [{ id, name: "testTool", arguments: { input: "x" } }] });

        it("returns every message the turn produced, in order", async () => {
            const gateway = createMockGateway([toolCall("t1"), { role: "assistant", content: "All done." }]);
            const registry = new ToolRegistry();
            registry.register(createTestTool());
            const result = await new AgentRuntime(gateway, registry, config).run([{ role: "user", content: "go" }]);

            expect(result.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
            expect(result.messages[0]).toMatchObject({ content: "Let me check.", toolCalls: [{ id: "t1", name: "testTool" }] });
            expect(result.messages[1]).toMatchObject({ content: "tool result content", toolCallId: "t1" });
            expect(result.messages[2]).toMatchObject({ content: "All done." });
            expect(result.messages.every((m) => m.timestamp instanceof Date)).toBe(true);
            // The user's own message is not part of what the turn added
            expect(result.messages.some((m) => m.role === "user")).toBe(false);
        });

        it("records failed and unknown tool calls in the transcript too", async () => {
            const gateway = createMockGateway([
                { role: "assistant", content: "", toolCalls: [{ id: "u1", name: "no_such_tool", arguments: {} }] },
                { role: "assistant", content: "That tool does not exist." },
            ]);
            const result = await new AgentRuntime(gateway, new ToolRegistry(), config).run([{ role: "user", content: "go" }]);
            expect(result.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
            expect(result.messages[1]!.content).toContain('Unknown tool "no_such_tool"');
        });

        it("forwards text through onText — the whole response, exactly once, with a break between iterations", async () => {
            // This mock does not stream, so each message arrives in one piece
            const gateway = createMockGateway([toolCall("t1"), { role: "assistant", content: "All done." }]);
            const registry = new ToolRegistry();
            registry.register(createTestTool());
            const chunks: string[] = [];
            const result = await new AgentRuntime(gateway, registry, { ...config, onText: (d) => chunks.push(d) })
                .run([{ role: "user", content: "go" }]);

            expect(chunks).toEqual(["Let me check.", "\n\n", "All done."]);
            expect(chunks.join("").endsWith(result.response)).toBe(true);
        });

        it("uses the gateway's token stream when it provides one, without sending the text again", async () => {
            const gateway = {
                resolveRouting: vi.fn().mockResolvedValue({ tier: "standard", selectedModelId: "m", reason: "mock" }),
                complete: vi.fn(async (_m: ChatMessage[], _model: string, _tools: unknown, options?: { onToken?: (d: string) => void }) => {
                    options?.onToken?.("Str");
                    options?.onToken?.("eamed");
                    return { message: { role: "assistant" as const, content: "Streamed" }, usage: { inputTokens: 1, outputTokens: 1 } };
                }),
                stream: vi.fn(),
            } as unknown as Gateway;
            const chunks: string[] = [];
            await new AgentRuntime(gateway, new ToolRegistry(), { ...config, onText: (d) => chunks.push(d) })
                .run([{ role: "user", content: "go" }]);
            expect(chunks).toEqual(["Str", "eamed"]);
        });

        it("does not ask the gateway to stream when nobody is listening", async () => {
            const gateway = createMockGateway([{ role: "assistant", content: "quiet" }]);
            await new AgentRuntime(gateway, new ToolRegistry(), config).run([{ role: "user", content: "go" }]);
            expect(vi.mocked(gateway.complete).mock.calls[0]![3]).toBeUndefined();
        });
    });
});
