import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry } from "../registry.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import type { LoadedPlugin } from "../types.js";

function makePlugin(name: string, toolCount = 1): LoadedPlugin {
    const toolRegistry = new ToolRegistry();
    const tools = Array.from({ length: toolCount }, (_, i) => ({
        definition: {
            name: `${name}.tool_${i}`,
            description: `Tool ${i} from ${name}`,
            parameters: { type: "object" as const, properties: {}, required: [] },
            safety: "safe" as const,
            pluginName: name,
        },
        execute: async (_args: Record<string, unknown>) => `result from ${name}.tool_${i}`,
    }));
    return {
        manifest: { name, version: "1.0.0", description: `Plugin ${name}` },
        directory: `/fake/${name}`,
        status: "active",
        tools,
    };
}

describe("PluginRegistry", () => {
    let toolRegistry: ToolRegistry;
    let pluginRegistry: PluginRegistry;

    beforeEach(() => {
        toolRegistry = new ToolRegistry();
        pluginRegistry = new PluginRegistry(toolRegistry, "/tmp/fake-plugins");
    });

    it("registers a plugin and its tools", () => {
        const plugin = makePlugin("test-plugin", 2);
        pluginRegistry.registerPlugin(plugin);

        expect(pluginRegistry.has("test-plugin")).toBe(true);
        expect(toolRegistry.has("test-plugin.tool_0")).toBe(true);
        expect(toolRegistry.has("test-plugin.tool_1")).toBe(true);
    });

    it("list() returns PluginInfo for all plugins", () => {
        pluginRegistry.registerPlugin(makePlugin("plugin-a", 1));
        pluginRegistry.registerPlugin(makePlugin("plugin-b", 3));

        const infos = pluginRegistry.list();
        expect(infos).toHaveLength(2);
        const a = infos.find((p) => p.name === "plugin-a");
        expect(a?.toolCount).toBe(1);
        const b = infos.find((p) => p.name === "plugin-b");
        expect(b?.toolCount).toBe(3);
    });

    it("throws if the same plugin is registered twice", () => {
        pluginRegistry.registerPlugin(makePlugin("dup"));
        expect(() => pluginRegistry.registerPlugin(makePlugin("dup"))).toThrow(/already registered/);
    });

    it("unregisterPlugin() removes the plugin from the registry", () => {
        pluginRegistry.registerPlugin(makePlugin("removable"));
        expect(pluginRegistry.has("removable")).toBe(true);
        pluginRegistry.unregisterPlugin("removable");
        expect(pluginRegistry.has("removable")).toBe(false);
    });

    it("unregisterPlugin() throws for unknown plugins", () => {
        expect(() => pluginRegistry.unregisterPlugin("ghost")).toThrow(/not registered/);
    });

    it("registers errored plugins without adding their tools", () => {
        const erroredPlugin: LoadedPlugin = {
            ...makePlugin("broken", 2),
            status: "error",
            error: "Import failed",
        };
        pluginRegistry.registerPlugin(erroredPlugin);
        expect(pluginRegistry.has("broken")).toBe(true);
        // No tools should be added for errored plugins
        expect(toolRegistry.has("broken.tool_0")).toBe(false);
        const info = pluginRegistry.list().find((p) => p.name === "broken");
        expect(info?.status).toBe("error");
    });

    it("getToolNames() returns tool names for a plugin", () => {
        pluginRegistry.registerPlugin(makePlugin("named", 3));
        const names = pluginRegistry.getToolNames("named");
        expect(names).toHaveLength(3);
        expect(names).toContain("named.tool_0");
    });

    it("getToolNames() returns empty array for unknown plugin", () => {
        expect(pluginRegistry.getToolNames("unknown")).toEqual([]);
    });
});
