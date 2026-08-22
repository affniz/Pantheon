import * as path from "node:path";
import type { LoadedPlugin, PluginInfo, PluginTransport } from "./types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import { discoverPlugins, DEFAULT_PLUGINS_DIR } from "./loader.js";

/**
 * PluginRegistry manages the lifecycle of installed plugins.
 * It integrates with the existing ToolRegistry so plugin tools are
 * available to the AgentRuntime without any additional plumbing.
 */
export class PluginRegistry {
    private plugins = new Map<string, LoadedPlugin>();
    private toolRegistry: ToolRegistry;
    private pluginsDir: string;

    constructor(toolRegistry: ToolRegistry, pluginsDir: string = DEFAULT_PLUGINS_DIR) {
        this.toolRegistry = toolRegistry;
        this.pluginsDir = pluginsDir;
    }

    /**
     * Register a loaded plugin. Adds all plugin tools to the ToolRegistry.
     * Throws if a plugin with the same name is already registered.
     */
    registerPlugin(plugin: LoadedPlugin): void {
        const name = plugin.manifest.name;

        if (this.plugins.has(name)) {
            throw new Error(`Plugin "${name}" is already registered. Call unregisterPlugin first.`);
        }

        if (plugin.status !== "active") {
            // Register even errored plugins so they appear in listing, but don't add tools
            this.plugins.set(name, plugin);
            return;
        }

        // Register all plugin tools into the shared ToolRegistry
        for (const tool of plugin.tools) {
            try {
                this.toolRegistry.register(tool);
            } catch (error) {
                process.stderr.write(
                    `[plugins] Warning: Could not register tool "${tool.definition.name}" from plugin "${name}": ${
                        error instanceof Error ? error.message : String(error)
                    }\n`
                );
            }
        }

        this.plugins.set(name, plugin);
        process.stderr.write(
            `[plugins] Registered "${name}" v${plugin.manifest.version} (${plugin.tools.length} tool${plugin.tools.length !== 1 ? "s" : ""})\n`
        );
    }

    /**
     * Unregister a plugin. Note: ToolRegistry does not support tool removal,
     * so plugin tools remain in the registry until the process restarts.
     * This is acceptable for the current single-process architecture.
     */
    unregisterPlugin(name: string): void {
        if (!this.plugins.has(name)) {
            throw new Error(`Plugin "${name}" is not registered.`);
        }
        this.plugins.delete(name);
        process.stderr.write(`[plugins] Unregistered "${name}"\n`);
    }

    /** Check if a plugin is registered by name */
    has(name: string): boolean {
        return this.plugins.has(name);
    }

    /** Get a loaded plugin by name */
    get(name: string): LoadedPlugin | undefined {
        return this.plugins.get(name);
    }

    /** List all registered plugins as PluginInfo summaries */
    list(): PluginInfo[] {
        return [...this.plugins.values()].map((plugin) => {
            const transport = detectTransport(plugin);
            return {
                name: plugin.manifest.name,
                version: plugin.manifest.version,
                description: plugin.manifest.description,
                status: plugin.status,
                toolCount: plugin.tools.length,
                ...(transport !== undefined ? { transport } : {}),
                directory: plugin.directory,
                ...(plugin.error ? { error: plugin.error } : {}),
            };
        });
    }

    /** Get all tool names registered by a specific plugin */
    getToolNames(pluginName: string): string[] {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) return [];
        return plugin.tools.map((t) => t.definition.name);
    }

    /**
     * Discover and load all plugins from the plugins directory,
     * then register them. Returns count of successfully loaded plugins.
     */
    async loadFromDirectory(sandbox: Sandbox): Promise<number> {
        const discovered = await discoverPlugins(this.pluginsDir, sandbox);
        let successCount = 0;

        for (const plugin of discovered) {
            if (this.plugins.has(plugin.manifest.name)) {
                process.stderr.write(
                    `[plugins] Skipping "${plugin.manifest.name}" — already registered\n`
                );
                continue;
            }
            try {
                this.registerPlugin(plugin);
                if (plugin.status === "active") successCount++;
            } catch (error) {
                process.stderr.write(
                    `[plugins] Failed to register "${plugin.manifest.name}": ${
                        error instanceof Error ? error.message : String(error)
                    }\n`
                );
            }
        }

        return successCount;
    }

    /** Gracefully shut down all active plugins (e.g. close MCP connections). */
    async shutdown(): Promise<void> {
        for (const [name, plugin] of this.plugins) {
            if (plugin.mcpClient) {
                try {
                    const client = plugin.mcpClient as { close: () => Promise<void> };
                    await client.close();
                    process.stderr.write(`[plugins] Closed MCP connection for "${name}"\n`);
                } catch (error) {
                    process.stderr.write(
                        `[plugins] Error closing MCP connection for "${name}": ${
                            error instanceof Error ? error.message : String(error)
                        }\n`
                    );
                }
            }
        }
    }

    /** The plugins directory this registry is backed by */
    get directory(): string {
        return this.pluginsDir;
    }
}

function detectTransport(plugin: LoadedPlugin): PluginTransport | undefined {
    const hasMcp = !!plugin.manifest.mcp;
    const hasInline = Array.isArray(plugin.manifest.tools) && plugin.manifest.tools.length > 0;

    if (hasMcp && hasInline) return "mixed";
    if (hasMcp) return plugin.manifest.mcp!.transport;
    if (hasInline) return "inline";
    return undefined;
}
