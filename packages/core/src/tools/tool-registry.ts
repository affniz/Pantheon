import type { ToolDefinition } from "@pantheon/shared";
import type { Sandbox } from "../sandbox/sandbox.js";

/**
 * A registered tool — definition (JSON Schema for LLM) + executor function.
 * All tools receive a Sandbox instance for path/command validation.
 */
export interface Tool {
    definition: ToolDefinition;
    execute: (args: Record<string, unknown>, sandbox: Sandbox) => Promise<string>;
}

/** OpenAI-compatible tool format for the chat completions API */
export interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: ToolDefinition["parameters"];
    };
}

/**
 * Registry of tools available to the agent runtime.
 * Tools are registered by name and can be looked up for execution.
 */
export class ToolRegistry {
    private tools = new Map<string, Tool>();

    /**
     * Register a tool. Throws if a tool with the same name is already registered.
     */
    register(tool: Tool): void {
        if (this.tools.has(tool.definition.name)) {
            throw new Error(
                `Tool "${tool.definition.name}" is already registered.`
            );
        }
        this.tools.set(tool.definition.name, tool);
    }

    /**
     * Get a tool by name. Returns undefined if not found.
     */
    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    /** Check if a tool name is registered */
    has(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * List all registered tools.
     */
    list(): Tool[] {
        return [...this.tools.values()];
    }

    /** Get all tools registered by a specific plugin (matched via definition.pluginName) */
    getByPlugin(pluginName: string): Tool[] {
        return this.list().filter((t) => t.definition.pluginName === pluginName);
    }

    /**
     * Get all tool definitions (for passing to the LLM in the system prompt).
     */
    getDefinitions(): ToolDefinition[] {
        return this.list().map((t) => t.definition);
    }

    /**
     * Format tools for the OpenAI chat completions API `tools` parameter.
     * Plugin tools have their plugin name prepended to the description so the LLM
     * knows where each tool comes from.
     */
    toOpenAITools(): OpenAITool[] {
        return this.list().map((t) => ({
            type: "function" as const,
            function: {
                name: t.definition.name,
                description: t.definition.pluginName
                    ? `[${t.definition.pluginName}] ${t.definition.description}`
                    : t.definition.description,
                parameters: t.definition.parameters,
            },
        }));
    }
}
