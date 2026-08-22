import type { Tool } from "../tools/tool-registry.js";
import type { ToolParameter } from "@pantheon/shared";

export interface PluginToolConfig {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, ToolParameter>;
        required: string[];
    };
    safety: "safe" | "destructive";
    /** Path to the tool handler module relative to the plugin directory */
    handler: string;
    /** Exported function name in the handler module. Default: "execute" */
    exportName?: string;
}

export interface MCPServerConfig {
    transport: "stdio" | "sse";
    /** For stdio transport: command to spawn the MCP server */
    command?: string;
    /** Arguments for the stdio command */
    args?: string[];
    /** For SSE transport: URL of the remote MCP server */
    url?: string;
    /** Environment variables to pass to the MCP subprocess */
    env?: Record<string, string>;
}

export interface PluginEnvSpec {
    description: string;
    required: boolean;
    default?: string;
}

export interface PluginManifest {
    /** NPM-style package name, e.g. "@pantheon-plugins/github" */
    name: string;
    version: string;
    description: string;
    author?: string;
    license?: string;
    /** Inline tool implementations */
    tools?: PluginToolConfig[];
    /** MCP server configuration */
    mcp?: MCPServerConfig;
    /** Required environment variables */
    env?: Record<string, PluginEnvSpec>;
    /** Plugin-specific settings */
    settings?: Record<string, unknown>;
}

export type PluginStatus = "active" | "error" | "disabled";
export type PluginTransport = "stdio" | "sse" | "inline" | "mixed";

export interface LoadedPlugin {
    manifest: PluginManifest;
    directory: string;
    status: PluginStatus;
    /** Error message if status is "error" */
    error?: string;
    /** Resolved Tool instances registered from this plugin */
    tools: Tool[];
    /** Active MCP client (if this plugin provides an MCP server) */
    mcpClient?: unknown; // typed as MCPClient when mcp module is imported
}

export interface PluginInfo {
    name: string;
    version: string;
    description: string;
    status: PluginStatus;
    toolCount: number;
    transport?: PluginTransport;
    directory: string;
    error?: string;
}

export interface PluginValidationError {
    field: string;
    message: string;
}

export interface PluginValidationResult {
    valid: boolean;
    errors: PluginValidationError[];
}
