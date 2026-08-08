import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentConfig } from "../agent-runtime.js";
import type { ChatMessage, ToolCall, ToolResult, RoutingDecision } from "@pantheon/shared";
import type { Gateway } from "../../gateway/gateway.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import type { Tool } from "../../tools/tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";
import type { PermissionManager } from "../../sandbox/permission-manager.js";

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
