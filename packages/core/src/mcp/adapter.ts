import type { MCPToolDefinition, MCPToolCallResult, MCPContentBlock } from "./protocol.js";
import type { MCPClient } from "./client.js";
import type { Tool } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { ToolParameter } from "@pantheon/shared";

/**
 * Convert an MCP tool definition to a Pantheon ToolDefinition.
 * Maps the MCP inputSchema to our ToolDefinition.parameters format.
 */
export function mcpToolToDefinition(
    mcpTool: MCPToolDefinition,
    pluginName: string
): Tool["definition"] {
    const inputSchema = mcpTool.inputSchema;

    // Convert MCP input schema properties to Pantheon ToolParameter format
    const properties: Record<string, ToolParameter> = {};
    const rawProps = inputSchema.properties ?? {};

    for (const [key, val] of Object.entries(rawProps)) {
        const prop = val as Record<string, unknown>;
        properties[key] = {
            type: normalizeParamType(prop.type as string),
            description: typeof prop.description === "string" ? prop.description : `Parameter: ${key}`,
            ...(Array.isArray(prop.enum) ? { enum: prop.enum as string[] } : {}),
            ...(prop.items !== undefined ? { items: convertItems(prop.items) } : {}),
        };
    }

    return {
        name: mcpTool.name,
        description: mcpTool.description ?? `Tool provided by ${pluginName}`,
        parameters: {
            type: "object",
            properties,
            required: inputSchema.required ?? [],
        },
        // MCP tools are treated as destructive (may have side effects) unless overridden
        safety: "destructive",
        pluginName,
    };
}

/**
 * Create a Pantheon Tool from an MCP tool definition.
 * The tool's execute function calls the MCP server via the provided MCPClient.
 */
export function createMCPTool(client: MCPClient, mcpTool: MCPToolDefinition, pluginName: string): Tool {
    return {
        definition: mcpToolToDefinition(mcpTool, pluginName),
        execute: async (args: Record<string, unknown>, _sandbox: Sandbox): Promise<string> => {
            try {
                if (!client.isConnected) {
                    return `Error: MCP server "${client.serverName}" is not connected`;
                }

                const result: MCPToolCallResult = await client.callTool(mcpTool.name, args);
                return formatMCPResult(result);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `Error calling MCP tool "${mcpTool.name}": ${message}`;
            }
        },
    };
}

/**
 * Convert a list of MCP tool definitions to Pantheon Tool instances.
 */
export function createMCPTools(
    client: MCPClient,
    mcpTools: MCPToolDefinition[],
    pluginName: string
): Tool[] {
    return mcpTools.map((tool) => createMCPTool(client, tool, pluginName));
}

/** Format an MCP tool result as a plain string for the agent runtime */
function formatMCPResult(result: MCPToolCallResult): string {
    const parts: string[] = [];

    for (const block of result.content) {
        parts.push(formatContentBlock(block));
    }

    const output = parts.join("\n");
    return result.isError ? `Error: ${output}` : output;
}

function formatContentBlock(block: MCPContentBlock): string {
    switch (block.type) {
        case "text":
            return block.text ?? "";
        case "image":
            return `[Image: ${block.mimeType ?? "unknown type"}, base64 data omitted]`;
        case "resource":
            return `[Resource: ${JSON.stringify(block.resource ?? {})}]`;
        default:
            return JSON.stringify(block);
    }
}

function normalizeParamType(type: string | undefined): ToolParameter["type"] {
    switch (type) {
        case "string": return "string";
        case "number":
        case "integer": return "number";
        case "boolean": return "boolean";
        case "array": return "array";
        case "object": return "object";
        default: return "string"; // default to string for unknown types
    }
}

function convertItems(items: unknown): ToolParameter {
    if (!items || typeof items !== "object") {
        return { type: "string", description: "Item" };
    }
    const i = items as Record<string, unknown>;
    return {
        type: normalizeParamType(i.type as string),
        description: typeof i.description === "string" ? i.description : "Item",
    };
}
