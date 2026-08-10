import type { ChatMessage, ModelConfig, Session, UsageRecord, Span, Trace } from "@pantheon/shared";
import type { PermissionDecision } from "@pantheon/core";

export interface CostSummary {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
}

export interface ChatRequestOptions {
    sessionId?: string;
    prompt: string;
    model?: string;
    noTools?: boolean;
    workingDir?: string;
}

/** Union of all SSE event payloads the chat endpoint can emit */
export type ChatSSEEvent =
    | { event: "routing"; data: { tier: string; selectedModelId: string; reason: string } }
    | { event: "text"; data: { content: string } }
    | { event: "tool_call"; data: { id: string; name: string; arguments: Record<string, unknown>; safety: "safe" | "destructive" } }
    | { event: "tool_permission_required"; data: { toolCallId: string; toolName: string; args: Record<string, unknown>; safety: "safe" | "destructive" } }
    | { event: "tool_result"; data: { toolCallId: string; content: string; isError: boolean } }
    | { event: "done"; data: { sessionId: string; iterations: number } }
    | { event: "error"; data: { message: string } };

/**
 * Typed HTTP client for the Pantheon API server.
 * All CLI commands use this instead of importing @pantheon/core directly.
 */
export class PantheonApiClient {
    private baseUrl: string;

    constructor(baseUrl = "http://localhost:3000") {
        this.baseUrl = baseUrl;
    }

    private url(path: string): string {
        return `${this.baseUrl}${path}`;
    }

    private async get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
        const url = new URL(this.url(path));
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                url.searchParams.set(k, String(v));
            }
        }
        const res = await fetch(url.toString());
        if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<T>;
    }

    private async post<T>(path: string, body?: unknown): Promise<T> {
        const init: RequestInit = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        };
        if (body !== undefined) {
            (init as any).body = JSON.stringify(body);
        }
        const res = await fetch(this.url(path), init);
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<T>;
    }

    private async del<T>(path: string): Promise<T> {
        const res = await fetch(this.url(path), { method: "DELETE" });
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<T>;
    }

    // ── Health ───────────────────────────────────────────────────────────────

    async health(): Promise<{ status: string; version: string }> {
        return this.get("/api/health");
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    async listSessions(opts?: { limit?: number; all?: boolean }): Promise<Session[]> {
        const result = await this.get<{ sessions: Session[] }>("/api/sessions", {
            ...(opts?.limit ? { limit: opts.limit } : {}),
            ...(opts?.all ? { all: true } : {}),
        });
        return result.sessions;
    }

    async getSession(id: string): Promise<Session> {
        const result = await this.get<{ session: Session }>(`/api/sessions/${id}`);
        return result.session;
    }

    async getSessionMessages(id: string): Promise<ChatMessage[]> {
        const result = await this.get<{ messages: ChatMessage[] }>(`/api/sessions/${id}/messages`);
        return result.messages;
    }

    async archiveSession(id: string): Promise<void> {
        await this.post(`/api/sessions/${id}/archive`);
    }

    async deleteSession(id: string): Promise<void> {
        await this.del(`/api/sessions/${id}`);
    }

    // ── Models ───────────────────────────────────────────────────────────────

    async listModels(): Promise<{ models: ModelConfig[]; defaultModel: string | null }> {
        return this.get("/api/models");
    }

    async setDefaultModel(id: string): Promise<void> {
        await this.post("/api/models/default", { id });
    }

    // ── Cost ─────────────────────────────────────────────────────────────────

    async getCostSummary(): Promise<{ summary: CostSummary; byModel: Record<string, unknown> }> {
        return this.get("/api/cost");
    }

    async getCostRecent(n = 10): Promise<UsageRecord[]> {
        const result = await this.get<{ records: UsageRecord[] }>("/api/cost/recent", { n });
        return result.records;
    }

    async resetCost(): Promise<void> {
        await this.del("/api/cost");
    }

    // ── Traces ───────────────────────────────────────────────────────────────

    async listTraces(limit = 20): Promise<Trace[]> {
        const result = await this.get<{ traces: Trace[] }>("/api/traces", { limit });
        return result.traces;
    }

    async getTrace(traceId: string): Promise<Span[]> {
        const result = await this.get<{ spans: Span[] }>(`/api/traces/${traceId}`);
        return result.spans;
    }

    async clearTraces(): Promise<void> {
        await this.del("/api/traces");
    }

    // ── Chat (SSE) ───────────────────────────────────────────────────────────

    /**
     * Opens a chat SSE stream and yields typed events.
     * The caller is responsible for handling tool_permission_required events
     * by calling respondToToolPermission() and then resuming iteration.
     */
    async *chat(opts: ChatRequestOptions): AsyncGenerator<ChatSSEEvent> {
        const res = await fetch(this.url("/api/chat"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts),
        });

        if (!res.ok || !res.body) {
            const errBody = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? ""; // Keep the incomplete last line

            let currentEvent = "";
            for (const line of lines) {
                if (line.startsWith("event: ")) {
                    currentEvent = line.slice(7).trim();
                } else if (line.startsWith("data: ") && currentEvent) {
                    const data = JSON.parse(line.slice(6));
                    yield { event: currentEvent, data } as ChatSSEEvent;
                    currentEvent = "";
                }
            }
        }
    }

    /** Send a tool permission decision mid-turn. */
    async respondToToolPermission(toolCallId: string, decision: PermissionDecision): Promise<void> {
        await this.post("/api/chat/respond", { toolCallId, decision });
    }
}
