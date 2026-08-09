import crypto from "node:crypto";
import { eq, desc, and, ne, sql } from "drizzle-orm";
import type { ChatMessage, Session } from "@pantheon/shared";
import { getDb, type PantheonDatabase } from "../db/client.js";
import { sessions, messages } from "../db/schema.js";

export class SessionManager {
    private db: PantheonDatabase;

    constructor(db?: PantheonDatabase) {
        this.db = db ?? getDb();
    }

    create(title?: string): string {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        this.db
            .insert(sessions)
            .values({
                id,
                title: title ?? "New Session",
                createdAt: now,
                updatedAt: now,
                isArchived: false,
            })
            .run();
        return id;
    }

    get(id: string): Session | undefined {
        const session = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
        if (!session) return undefined;

        const countResult = this.db
            .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
            .from(messages)
            .where(eq(messages.sessionId, id))
            .get();

        return {
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            modelId: session.modelId ?? undefined,
            isArchived: session.isArchived,
            messageCount: countResult?.count ?? 0,
        };
    }

    list(options?: { limit?: number; offset?: number; includeArchived?: boolean }): Session[] {
        const limit = options?.limit ?? 50;
        const offset = options?.offset ?? 0;
        const includeArchived = options?.includeArchived ?? false;

        let query = this.db
            .select({
                id: sessions.id,
                title: sessions.title,
                createdAt: sessions.createdAt,
                updatedAt: sessions.updatedAt,
                modelId: sessions.modelId,
                isArchived: sessions.isArchived,
                messageCount: sql<number>`CAST(COUNT(${messages.id}) AS INTEGER)`,
            })
            .from(sessions)
            .leftJoin(messages, eq(sessions.id, messages.sessionId))
            .groupBy(sessions.id)
            .orderBy(desc(sessions.createdAt))
            .limit(limit)
            .offset(offset);

        if (!includeArchived) {
            query = query.where(eq(sessions.isArchived, false)) as any;
        }

        const rows = query.all();
        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            modelId: row.modelId ?? undefined,
            isArchived: row.isArchived,
            messageCount: row.messageCount,
        }));
    }

    addMessage(sessionId: string, message: ChatMessage): void {
        // Auto-generate title if it's the first user message and session has default title
        if (message.role === "user") {
            const session = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
            if (session && session.title === "New Session") {
                const newTitle = message.content.substring(0, 80).replace(/\n/g, " ") || "New Session";
                this.updateTitle(sessionId, newTitle);
            }
        }

        this.db
            .insert(messages)
            .values({
                sessionId,
                role: message.role,
                content: message.content,
                toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
                toolCallId: message.toolCallId ?? null,
                createdAt: (message.timestamp || new Date()).toISOString(),
            })
            .run();

        this.touch(sessionId);
    }

    getMessages(sessionId: string): ChatMessage[] {
        const rows = this.db
            .select()
            .from(messages)
            .where(eq(messages.sessionId, sessionId))
            .orderBy(messages.id)
            .all();

        return rows.map((row) => {
            const msg: ChatMessage = {
                role: row.role as ChatMessage["role"],
                content: row.content,
                timestamp: new Date(row.createdAt),
            };
            if (row.toolCalls) {
                msg.toolCalls = JSON.parse(row.toolCalls);
            }
            if (row.toolCallId) {
                msg.toolCallId = row.toolCallId;
            }
            return msg;
        });
    }

    updateTitle(sessionId: string, title: string): void {
        this.db
            .update(sessions)
            .set({ title, updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, sessionId))
            .run();
    }

    touch(sessionId: string): void {
        this.db
            .update(sessions)
            .set({ updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, sessionId))
            .run();
    }

    archive(sessionId: string): void {
        this.db
            .update(sessions)
            .set({ isArchived: true, updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, sessionId))
            .run();
    }

    delete(sessionId: string): void {
        this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    }

    getLatest(): Session | undefined {
        const row = this.db
            .select()
            .from(sessions)
            .where(eq(sessions.isArchived, false))
            .orderBy(desc(sessions.updatedAt))
            .limit(1)
            .get();

        if (!row) return undefined;
        return this.get(row.id);
    }
}
