import type {
    ServerCapabilities,
    MCPToolDefinition,
    MCPToolCallResult,
    InitializeResult,
    JSONRPCRequest,
    JSONRPCResponse,
} from "./protocol.js";
import { MCP_PROTOCOL_VERSION } from "./protocol.js";
import type { StdioTransportConfig } from "./transport-stdio.js";
import type { SSETransportConfig } from "./transport-sse.js";
import { StdioTransport } from "./transport-stdio.js";
import { SSETransport } from "./transport-sse.js";

export type MCPTransportConfig =
    | ({ transport: "stdio" } & StdioTransportConfig)
    | ({ transport: "sse" } & SSETransportConfig);

interface Transport {
    connect(): Promise<void>;
    send(request: JSONRPCRequest): Promise<JSONRPCResponse>;
    close(): Promise<void>;
    isConnected: boolean;
}

let _nextId = 1;
function nextId(): number {
    return _nextId++;
}

/**
 * MCPClient connects to an MCP server and provides a typed API for:
 * - Discovering available tools
 * - Invoking tools and getting results
 */
export class MCPClient {
    private transport: Transport;
    private capabilities: ServerCapabilities = {};
    private serverInfo: { name: string; version: string } = { name: "unknown", version: "unknown" };
    private _connected = false;

    private constructor(transport: Transport) {
        this.transport = transport;
    }

    /**
     * Create and connect an MCPClient using the provided transport configuration.
     * Performs the MCP initialize handshake.
     */
    static async connect(config: MCPTransportConfig): Promise<MCPClient> {
        let transport: Transport;

        if (config.transport === "stdio") {
            const { transport: _, ...rest } = config;
            transport = new StdioTransport(rest);
        } else {
            const { transport: _, ...rest } = config;
            transport = new SSETransport(rest);
        }

        await transport.connect();

        const client = new MCPClient(transport);
        await client.initialize();
        return client;
    }

    private async initialize(): Promise<void> {
        const response = await this.transport.send({
            jsonrpc: "2.0",
            id: nextId(),
            method: "initialize",
            params: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {
                    roots: { listChanged: false },
                },
                clientInfo: {
                    name: "pantheon",
                    version: "0.7.0",
                },
            },
        });

        if (response.error) {
            throw new Error(`MCP initialize failed: ${response.error.message}`);
        }

        const result = response.result as InitializeResult;
        this.capabilities = result.capabilities ?? {};
        this.serverInfo = result.serverInfo ?? { name: "unknown", version: "unknown" };
        this._connected = true;

        // Send initialized notification (required by MCP spec)
        (this.transport as StdioTransport | SSETransport).sendNotification?.({
            jsonrpc: "2.0",
            method: "notifications/initialized",
        });

        process.stderr.write(
            `[mcp] Connected to "${this.serverInfo.name}" v${this.serverInfo.version} ` +
            `(tools: ${this.capabilities.tools ? "yes" : "no"})\n`
        );
    }

    /** Discover all tools offered by this MCP server */
    async listTools(): Promise<MCPToolDefinition[]> {
        if (!this._connected) {
            throw new Error("MCPClient is not connected");
        }

        const response = await this.transport.send({
            jsonrpc: "2.0",
            id: nextId(),
            method: "tools/list",
            params: {},
        });

        if (response.error) {
            throw new Error(`tools/list failed: ${response.error.message}`);
        }

        const result = response.result as { tools: MCPToolDefinition[] };
        return result.tools ?? [];
    }

    /** Invoke a tool on the MCP server */
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<MCPToolCallResult> {
        if (!this._connected) {
            throw new Error("MCPClient is not connected");
        }

        const response = await this.transport.send({
            jsonrpc: "2.0",
            id: nextId(),
            method: "tools/call",
            params: { name, arguments: args },
        });

        if (response.error) {
            return {
                content: [{ type: "text", text: `Error: ${response.error.message}` }],
                isError: true,
            };
        }

        return response.result as MCPToolCallResult;
    }

    /** Close the connection gracefully */
    async close(): Promise<void> {
        this._connected = false;
        await this.transport.close();
    }

    get isConnected(): boolean {
        return this._connected && this.transport.isConnected;
    }

    get serverName(): string {
        return this.serverInfo.name;
    }

    get serverCapabilities(): ServerCapabilities {
        return this.capabilities;
    }
}
