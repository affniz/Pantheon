import { eq, ne, and, desc, inArray } from "drizzle-orm";
import type { ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import type { PantheonDatabase } from "../db/client.js";
import { DbStore } from "../db/store.js";

const SUMMARY_PROMPT = `Summarize this conversation in 2-3 sentences. Focus on what was discussed and what was accomplished. Be concise and specific.`;

export class SessionSummarizer extends DbStore {
    private gateway: Gateway;
    private modelId: string;

    constructor(gateway: Gateway, modelId: string, db?: PantheonDatabase) {
        super(db);
        this.gateway = gateway;
        this.modelId = modelId;
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
        const { sessionSummaries } = this.t;
        // Don't regenerate an existing summary
        if ((await this.getSummary(sessionId)) !== undefined) return;

        const summary = await this.summarize(msgs);
        // Two background summarisations for the same session can overlap (one per
        // turn); session_id is UNIQUE, so the loser is simply dropped.
        await this.db
            .insert(sessionSummaries)
            .values({
                sessionId,
                summary,
                createdAt: new Date().toISOString(),
            })
            .onConflictDoNothing();
    }

    async getSummary(sessionId: string): Promise<string | undefined> {
        const { sessionSummaries } = this.t;
        const [row] = await this.db
            .select()
            .from(sessionSummaries)
            .where(eq(sessionSummaries.sessionId, sessionId))
            .limit(1);
        return row?.summary;
    }

    async getRecentSummaries(limit = 5): Promise<Array<{ sessionId: string; title: string; summary: string; createdAt: string }>> {
        const { sessionSummaries, sessions } = this.t;
        // Join session_summaries with sessions to get title
        const rows = await this.db
            .select({
                sessionId: sessionSummaries.sessionId,
                title: sessions.title,
                summary: sessionSummaries.summary,
                createdAt: sessionSummaries.createdAt,
            })
            .from(sessionSummaries)
            .innerJoin(sessions, eq(sessionSummaries.sessionId, sessions.id))
            .orderBy(desc(sessionSummaries.createdAt))
            .limit(limit);

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
    async getEpisodicMemoryContext(
        currentSessionId: string,
        options?: { recentMessageCount?: number; summaryLimit?: number }
    ): Promise<string> {
        const { sessions, messages } = this.t;
        const recentMessageCount = options?.recentMessageCount ?? 10;
        const summaryLimit = options?.summaryLimit ?? 4;

        const parts: string[] = [];

        // ── 1. Find most recent past session ──────────────────────────────────
        const [lastSession] = await this.db
            .select()
            .from(sessions)
            .where(and(eq(sessions.isArchived, false), ne(sessions.id, currentSessionId)))
            .orderBy(desc(sessions.updatedAt))
            .limit(1);

        if (lastSession) {
            // Newest-first with a LIMIT, then reversed — avoids loading a long
            // session's entire history just to keep its last few messages.
            const rawMsgs = (await this.db
                .select()
                .from(messages)
                .where(and(eq(messages.sessionId, lastSession.id), inArray(messages.role, ["user", "assistant"])))
                .orderBy(desc(messages.id))
                .limit(recentMessageCount))
                .reverse();

            if (rawMsgs.length > 0) {
                const lines = rawMsgs.map(m => `${m.role}: ${m.content.slice(0, 500)}`);
                parts.push(
                    `## Recent context (last session — "${lastSession.title}")\n${lines.join("\n")}`
                );
            }
        }

        // ── 2. Older session summaries ─────────────────────────────────────────
        // +2: the current session and the "last session" above may both have summaries.
        const allSummaries = await this.getRecentSummaries(summaryLimit + 2);
        const olderSummaries = allSummaries.filter(
            s => s.sessionId !== currentSessionId && s.sessionId !== lastSession?.id,
        );

        const cappedOlder = olderSummaries.slice(0, summaryLimit);

        if (cappedOlder.length > 0) {
            const lines = cappedOlder.map(s => `- [${s.createdAt.slice(0, 10)}] "${s.title}" — ${s.summary}`);
            parts.push(`## Past sessions (summaries)\n${lines.join("\n")}`);
        }

        return parts.join("\n\n");
    }
}
