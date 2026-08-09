import { eq, desc } from "drizzle-orm";
import type { ChatMessage } from "@pantheon/shared";
import type { Gateway } from "../gateway/gateway.js";
import { getDb, type PantheonDatabase } from "../db/client.js";
import { sessionSummaries, sessions } from "../db/schema.js";

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

    async summarize(messages: ChatMessage[]): Promise<string> {
        // Filter to only user + assistant messages for summarization
        const conversationText = messages
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

    async saveForSession(sessionId: string, messages: ChatMessage[]): Promise<void> {
        // Check if summary already exists
        const existing = this.db
            .select()
            .from(sessionSummaries)
            .where(eq(sessionSummaries.sessionId, sessionId))
            .get();
        if (existing) return; // Don't regenerate

        const summary = await this.summarize(messages);
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
}
