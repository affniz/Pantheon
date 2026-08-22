import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification } from "./protocol.js";

export interface StdioTransportConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** Startup timeout in ms. Default: 10000 */
    startupTimeout?: number;
}

export type MessageHandler = (message: JSONRPCResponse | JSONRPCNotification) => void;

/**
 * MCP transport over stdio — spawns an MCP server as a child process
 * and communicates via JSON-RPC 2.0 over stdin/stdout.
 * Each line of stdout is expected to be a complete JSON-RPC message.
 */
export class StdioTransport {
    private process: ChildProcess | null = null;
    private messageHandlers = new Map<number | string, (response: JSONRPCResponse) => void>();
    private notificationHandler: ((notification: JSONRPCNotification) => void) | null = null;
    private config: StdioTransportConfig;
    private connected = false;
    private pendingMessageBuffer = "";

    constructor(config: StdioTransportConfig) {
        this.config = config;
    }

    /** Start the MCP server subprocess and establish communication */
    async connect(): Promise<void> {
        if (this.connected) return;

        const { command, args = [], env = {} } = this.config;
        const startupTimeout = this.config.startupTimeout ?? 10_000;

        this.process = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...env },
        });

        if (!this.process.stdout || !this.process.stdin) {
            throw new Error("Failed to open stdio pipes for MCP server");
        }

        // Pipe stderr to our stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
            process.stderr.write(`[mcp:${command}] ${chunk.toString()}`);
        });

        // Handle unexpected process exit
        this.process.on("exit", (code, signal) => {
            if (this.connected) {
                process.stderr.write(
                    `[mcp:${command}] Process exited unexpectedly (code=${code}, signal=${signal})\n`
                );
                this.connected = false;
                // Reject all pending message handlers
                for (const [id, handler] of this.messageHandlers) {
                    handler({
                        jsonrpc: "2.0",
                        id,
                        error: { code: -32000, message: "MCP server process exited unexpectedly" },
                    });
                }
                this.messageHandlers.clear();
            }
        });

        // Read JSON-RPC messages from stdout line by line
        const rl = createInterface({ input: this.process.stdout });
        rl.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            try {
                const message = JSON.parse(trimmed) as JSONRPCResponse | JSONRPCNotification;

                if ("id" in message && message.id !== undefined) {
                    // This is a response to a request
                    const handler = this.messageHandlers.get((message as JSONRPCResponse).id);
                    if (handler) {
                        this.messageHandlers.delete((message as JSONRPCResponse).id);
                        handler(message as JSONRPCResponse);
                    }
                } else {
                    // This is a server notification
                    this.notificationHandler?.(message as JSONRPCNotification);
                }
            } catch (error) {
                process.stderr.write(
                    `[mcp:${command}] Failed to parse message: ${line.slice(0, 200)}\n`
                );
            }
        });

        // Wait for the process to be ready (startup timeout)
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`MCP server "${command}" did not start within ${startupTimeout}ms`));
            }, startupTimeout);

            // We consider the process "ready" once it has started without crashing
            this.process!.once("error", (err) => {
                clearTimeout(timer);
                reject(new Error(`Failed to start MCP server "${command}": ${err.message}`));
            });

            // Give the process a short time to start up, then assume it's ready
            setTimeout(() => {
                clearTimeout(timer);
                if (this.process?.pid) {
                    resolve();
                } else {
                    reject(new Error(`MCP server "${command}" failed to start (no PID)`));
                }
            }, 500);
        });

        this.connected = true;
    }

    /** Send a JSON-RPC request and wait for the response */
    async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
        if (!this.connected || !this.process?.stdin) {
            throw new Error("StdioTransport is not connected. Call connect() first.");
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.messageHandlers.delete(request.id);
                reject(new Error(`MCP request "${request.method}" timed out after 30s`));
            }, 30_000);

            this.messageHandlers.set(request.id, (response) => {
                clearTimeout(timeout);
                resolve(response);
            });

            const line = JSON.stringify(request) + "\n";
            this.process!.stdin!.write(line);
        });
    }

    /** Send a JSON-RPC notification (no response expected) */
    sendNotification(notification: JSONRPCNotification): void {
        if (!this.connected || !this.process?.stdin) return;
        const line = JSON.stringify(notification) + "\n";
        this.process.stdin.write(line);
    }

    /** Register a handler for server-sent notifications */
    onNotification(handler: (notification: JSONRPCNotification) => void): void {
        this.notificationHandler = handler;
    }

    /** Disconnect and kill the subprocess */
    async close(): Promise<void> {
        this.connected = false;
        if (this.process) {
            this.process.stdin?.end();
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    this.process?.kill("SIGKILL");
                    resolve();
                }, 3000);
                this.process!.once("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            this.process = null;
        }
    }

    get isConnected(): boolean {
        return this.connected;
    }
}
