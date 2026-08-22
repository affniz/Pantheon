import { eq, desc, ne } from "drizzle-orm";
import type { ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { getDb, type PantheonDatabase } from "../db/client.js";
import { sessionSummaries, sessions, messages } from "../db/schema.js";

const SUMMARY_PROMPT = `Summarize this conversation in 2-3 sentences. Focus on what was discussed and what was accomplished. Be concise and specific.`;

export class SessionSummarizer {
    private db: PantheonDatabase;
    private gateway: Gateway;
    private modelId: string;

    constructor(gateway: Gateway, modelId: string, db?: PantheonDatabase) {
        this.gateway = gateway;
        this.modelId = modelId;
        this.db = db ?? getDb();
    }

    async summarize(msgs: ChatMessage[]): Promise<string> {
        // Filter to only user + assistant messages for summarization
        const conversationText = msgs
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');

        const summaryMessages: ChatMessage[] = [
            { role: 'system', content: SUMMARY_PROMPT },
            { role: 'user', content: conversationText },
        ];

        const { message } = await this.gateway.complete(summaryMessages, this.modelId);
        return message.content;
    }

    async saveForSession(sessionId: string, msgs: ChatMessage[]): Promise<void> {
        // Check if summary already exists
        const existing = this.db
            .select()
            .from(sessionSummaries)
            .where(eq(sessionSummaries.sessionId, sessionId))
            .get();
        if (existing) return; // Don't regenerate

        const summary = await this.summarize(msgs);
        this.db
            .insert(sessionSummaries)
            .values({
                sessionId,
                summary,
                createdAt: new Date().toISOString(),
            })
            .run();
    }

    getSummary(sessionId: string): string | undefined {
        const row = this.db
            .select()
            .from(sessionSummaries)
            .where(eq(sessionSummaries.sessionId, sessionId))
            .get();
        return row?.summary;
    }

    getRecentSummaries(limit = 5): Array<{ sessionId: string; title: string; summary: string; createdAt: string }> {
        // Join session_summaries with sessions to get title
        const rows = this.db
            .select({
                sessionId: sessionSummaries.sessionId,
                title: sessions.title,
                summary: sessionSummaries.summary,
                createdAt: sessionSummaries.createdAt,
            })
            .from(sessionSummaries)
            .innerJoin(sessions, eq(sessionSummaries.sessionId, sessions.id))
            .orderBy(desc(sessionSummaries.createdAt))
            .limit(limit)
            .all();

        return rows.map(r => ({
            sessionId: r.sessionId,
            title: r.title ?? "Untitled",
            summary: r.summary,
            createdAt: r.createdAt,
        }));
    }

    /**
     * Builds the episodic memory context string for injection into the current session's system prompt.
     *
     * Strategy:
     * - Most recent past session → inject its last N raw user+assistant messages (precise context)
     * - Older sessions → inject their LLM-generated summaries (compact history)
     *
     * @param currentSessionId - The current active session (excluded from results)
     * @param options.recentMessageCount - Number of raw messages from the most recent session. Default: 10.
     * @param options.summaryLimit - Max older sessions to summarize. Default: 4.
     */
    getEpisodicMemoryContext(
        currentSessionId: string,
        options?: { recentMessageCount?: number; summaryLimit?: number }
    ): string {
        const recentMessageCount = options?.recentMessageCount ?? 10;
        const summaryLimit = options?.summaryLimit ?? 4;

        const parts: string[] = [];

        // ── 1. Find most recent past session ──────────────────────────────────
        const lastSession = this.db
            .select()
            .from(sessions)
            .where(eq(sessions.isArchived, false))
            .orderBy(desc(sessions.updatedAt))
            .limit(10)
            .all()
            .find(s => s.id !== currentSessionId);

        if (lastSession) {
            const rawMsgs = this.db
                .select()
                .from(messages)
                .where(eq(messages.sessionId, lastSession.id))
                .orderBy(messages.id)
                .all()
                .filter(m => m.role === "user" || m.role === "assistant")
                .slice(-recentMessageCount);

            if (rawMsgs.length > 0) {
                const lines = rawMsgs.map(m => `${m.role}: ${m.content.slice(0, 500)}`);
                parts.push(
                    `## Recent context (last session — "${lastSession.title}")\n${lines.join("\n")}`
                );
            }
        }

        // ── 2. Older session summaries ─────────────────────────────────────────
        const allSummaries = this.getRecentSummaries(summaryLimit + 1);
        const olderSummaries = lastSession
            ? allSummaries.filter(s => s.sessionId !== lastSession.id)
            : allSummaries;

        const cappedOlder = olderSummaries.slice(0, summaryLimit);

        if (cappedOlder.length > 0) {
            const lines = cappedOlder.map(s => `- [${s.createdAt.slice(0, 10)}] "${s.title}" — ${s.summary}`);
            parts.push(`## Past sessions (summaries)\n${lines.join("\n")}`);
        }

        return parts.join("\n\n");
    }
}
