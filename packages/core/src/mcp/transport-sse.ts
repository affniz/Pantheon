import type { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification } from "./protocol.js";

export interface SSETransportConfig {
    /** URL of the MCP server SSE endpoint */
    url: string;
    /** Additional headers (e.g. Authorization) */
    headers?: Record<string, string>;
    /** Request timeout in ms. Default: 30000 */
    requestTimeout?: number;
    /** Reconnect delay in ms. Default: 2000 */
    reconnectDelay?: number;
}

/**
 * MCP transport over Server-Sent Events (SSE).
 * Sends JSON-RPC requests as HTTP POST and receives responses/notifications via SSE.
 */
export class SSETransport {
    private config: SSETransportConfig;
    private connected = false;
    private notificationHandler: ((notification: JSONRPCNotification) => void) | null = null;
    private abortController: AbortController | null = null;

    constructor(config: SSETransportConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        if (this.connected) return;
        // For SSE transport, connection is established on first request.
        // We verify connectivity by doing a HEAD request to the URL.
        const timeout = this.config.requestTimeout ?? 30_000;
        this.abortController = new AbortController();
        const signal = AbortSignal.any([
            this.abortController.signal,
            AbortSignal.timeout(timeout),
        ]);

        try {
            const response = await fetch(this.config.url, {
                method: "HEAD",
                ...(this.config.headers ? { headers: this.config.headers } : {}),
                signal,
            });

            if (!response.ok && response.status !== 405) {
                // 405 Method Not Allowed is fine — means HEAD isn't supported but URL is reachable
                throw new Error(`MCP server at ${this.config.url} returned HTTP ${response.status}`);
            }

            this.connected = true;
        } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError") {
                throw new Error(`Connection to MCP server at ${this.config.url} timed out after ${timeout}ms`, { cause: error });
            }
            throw error;
        }
    }

    async send(request: JSONRPCRequest): Promise<JSONRPCResponse> {
        if (!this.connected) {
            throw new Error("SSETransport is not connected. Call connect() first.");
        }

        const timeout = this.config.requestTimeout ?? 30_000;

        const response = await fetch(this.config.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...this.config.headers,
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`MCP server returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        }

        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("text/event-stream")) {
            // SSE response — parse the first data event
            return this.parseSSEResponse(response);
        }

        // Plain JSON response
        const json = await response.json() as JSONRPCResponse;
        return json;
    }

    private async parseSSEResponse(response: Response): Promise<JSONRPCResponse> {
        const text = await response.text();
        const lines = text.split("\n");

        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data === "[DONE]") continue;
                try {
                    return JSON.parse(data) as JSONRPCResponse;
                } catch {
                    // continue to next line
                }
            }
        }

        throw new Error("No valid JSON-RPC response found in SSE stream");
    }

    sendNotification(_notification: JSONRPCNotification): void {
        // SSE transport notifications are fire-and-forget POSTs
        fetch(this.config.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...this.config.headers,
            },
            body: JSON.stringify(_notification),
        }).catch(() => {
            // Notifications are best-effort
        });
    }

    onNotification(handler: (notification: JSONRPCNotification) => void): void {
        this.notificationHandler = handler;
    }

    async close(): Promise<void> {
        this.connected = false;
        this.abortController?.abort();
        this.abortController = null;
    }

    get isConnected(): boolean {
        return this.connected;
    }
}
