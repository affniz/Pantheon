// JSON-RPC 2.0 base types
export interface JSONRPCRequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
    jsonrpc: "2.0";
    id: number | string;
    result?: unknown;
    error?: JSONRPCError;
}

export interface JSONRPCNotification {
    jsonrpc: "2.0";
    method: string;
    params?: Record<string, unknown>;
}

export interface JSONRPCError {
    code: number;
    message: string;
    data?: unknown;
}

// Standard JSON-RPC error codes
export const RPC_ERROR_CODES = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
} as const;

// MCP protocol version
export const MCP_PROTOCOL_VERSION = "2024-11-05";

// MCP capability types
export interface ServerCapabilities {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    logging?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
}

export interface ClientCapabilities {
    roots?: { listChanged?: boolean };
    sampling?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
}

// MCP initialize request/response
export interface InitializeParams {
    protocolVersion: string;
    capabilities: ClientCapabilities;
    clientInfo: { name: string; version: string };
}

export interface InitializeResult {
    protocolVersion: string;
    capabilities: ServerCapabilities;
    serverInfo: { name: string; version: string };
}

// MCP tool types
export interface MCPToolDefinition {
    name: string;
    description?: string;
    inputSchema: {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

export interface MCPToolsListResult {
    tools: MCPToolDefinition[];
    nextCursor?: string;
}

export interface MCPToolCallParams {
    name: string;
    arguments?: Record<string, unknown>;
}

export interface MCPContentBlock {
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: unknown;
}

export interface MCPToolCallResult {
    content: MCPContentBlock[];
    isError?: boolean;
}

// MCP resource types (for future use)
export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface MCPResourcesListResult {
    resources: MCPResource[];
    nextCursor?: string;
}
