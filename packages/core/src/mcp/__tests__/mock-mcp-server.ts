import type { JSONRPCRequest, JSONRPCResponse, MCPToolDefinition } from "../protocol.js";
import { MCP_PROTOCOL_VERSION } from "../protocol.js";


/**
 * In-process mock MCP server for testing.
 *
 * Instead of spawning a real subprocess, this mock intercepts calls
 * at the StdioTransport level by replacing process.stdin/stdout.
 *
 * For simpler testing, it's designed to be used with MCPClient directly
 * by providing a mock transport implementation.
 */
export interface MockToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

export class MockMCPServer {
    private tools: MCPToolDefinition[];
    private toolHandlers: Map<string, (args: Record<string, unknown>) => MockToolResult | Promise<MockToolResult>>;
    private callLog: Array<{ name: string; args: Record<string, unknown> }> = [];

    constructor(tools: MCPToolDefinition[] = []) {
        this.tools = tools;
        this.toolHandlers = new Map();
    }

    /** Register a handler for a specific tool */
    addToolHandler(
        toolName: string,
        handler: (args: Record<string, unknown>) => MockToolResult | Promise<MockToolResult>
    ): this {
        this.toolHandlers.set(toolName, handler);
        return this;
    }

    /** Set the tools list returned by tools/list */
    setTools(tools: MCPToolDefinition[]): this {
        this.tools = tools;
        return this;
    }

    /** Get the call log (for assertions) */
    getCallLog(): Array<{ name: string; args: Record<string, unknown> }> {
        return [...this.callLog];
    }

    /** Reset call log */
    reset(): this {
        this.callLog = [];
        return this;
    }

    /**
     * Handle a JSON-RPC request and return a response.
     * This is the core dispatch used by the mock transport.
     */
    async handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
        switch (request.method) {
            case "initialize":
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
                    },
                };

            case "tools/list":
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: { tools: this.tools },
                };

            case "tools/call": {
                const params = request.params as { name?: string; arguments?: Record<string, unknown> };
                const toolName = params.name ?? "";
                const toolArgs = params.arguments ?? {};

                this.callLog.push({ name: toolName, args: toolArgs });

                const handler = this.toolHandlers.get(toolName);
                if (!handler) {
                    return {
                        jsonrpc: "2.0",
                        id: request.id,
                        error: {
                            code: -32601,
                            message: `Tool "${toolName}" not found`,
                        },
                    };
                }

                try {
                    const result = await handler(toolArgs);
                    return { jsonrpc: "2.0", id: request.id, result };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return {
                        jsonrpc: "2.0",
                        id: request.id,
                        result: {
                            content: [{ type: "text", text: `Error: ${message}` }],
                            isError: true,
                        },
                    };
                }
            }

            default:
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: {
                        code: -32601,
                        message: `Method "${request.method}" not found`,
                    },
                };
        }
    }

    /**
     * Create a mock transport object that can be duck-typed as a real transport.
     * Used to bypass real stdio/SSE in tests.
     */
    createMockTransport() {
        const handleRequest = (req: JSONRPCRequest) => this.handleRequest(req);
        let connected = false;
        return {
            async connect() { connected = true; },
            async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
                return handleRequest(request);
            },
            sendNotification() { /* no-op */ },
            onNotification() { /* no-op */ },
            async close() { connected = false; },
            get isConnected() { return connected; },
        };
    }
}
