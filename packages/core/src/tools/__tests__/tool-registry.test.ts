import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry, Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

describe("ToolRegistry", () => {
    let registry: ToolRegistry;
    let mockTool: Tool;

    beforeEach(() => {
        registry = new ToolRegistry();
        mockTool = {
            definition: {
                name: "testTool",
                description: "A test tool",
                parameters: { type: "object", properties: {}, required: [] },
                safety: "safe"
            },
            execute: async (args: Record<string, unknown>, sandbox: Sandbox) => "success"
        };
    });

    it("registers and gets a tool", () => {
        registry.register(mockTool);
        expect(registry.get("testTool")).toBe(mockTool);
    });

    it("throws when registering a duplicate tool", () => {
        registry.register(mockTool);
        expect(() => registry.register(mockTool)).toThrowError(/already registered/);
    });

    it("list() returns all registered tools", () => {
        registry.register(mockTool);
        expect(registry.list()).toEqual([mockTool]);
    });

    it("getDefinitions() returns tool definitions", () => {
        registry.register(mockTool);
        expect(registry.getDefinitions()).toEqual([mockTool.definition]);
    });

    it("toOpenAITools() formats correctly", () => {
        registry.register(mockTool);
        const expected = [{
            type: "function",
            function: {
                name: "testTool",
                description: "A test tool",
                parameters: { type: "object", properties: {}, required: [] }
            }
        }];
        expect(registry.toOpenAITools()).toEqual(expected);
    });

    it("get() returns undefined for unknown tool", () => {
        expect(registry.get("unknown")).toBeUndefined();
    });
});
