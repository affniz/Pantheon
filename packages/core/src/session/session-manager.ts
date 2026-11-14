import crypto from "node:crypto";
import { eq, desc, count } from "drizzle-orm";
import type { ChatMessage, Session } from "@pantheon/shared";
import { DbStore } from "../db/store.js";

export class SessionManager extends DbStore {
    async create(title?: string): Promise<string> {
        const { sessions } = this.t;
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await this.db.insert(sessions).values({
            id,
            title: title ?? "New Session",
            createdAt: now,
            updatedAt: now,
            isArchived: false,
        });
        return id;
    }

    /** True when a session with this id exists (cheaper than `get`, no message count). */
    async exists(id: string): Promise<boolean> {
        const { sessions } = this.t;
        const rows = await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).limit(1);
        return rows.length > 0;
    }

    async get(id: string): Promise<Session | undefined> {
        const { sessions, messages } = this.t;
        const [session] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
        if (!session) return undefined;

        const [countResult] = await this.db
            .select({ count: count() })
            .from(messages)
            .where(eq(messages.sessionId, id));

        return {
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            modelId: session.modelId ?? undefined,
            isArchived: session.isArchived,
            messageCount: Number(countResult?.count ?? 0),
        };
    }

    async list(options?: { limit?: number; offset?: number; includeArchived?: boolean }): Promise<Session[]> {
        const { sessions, messages } = this.t;
        const limit = options?.limit ?? 50;
        const offset = options?.offset ?? 0;
        const includeArchived = options?.includeArchived ?? false;

        const rows = await this.db
            .select({
                id: sessions.id,
                title: sessions.title,
                createdAt: sessions.createdAt,
                updatedAt: sessions.updatedAt,
                modelId: sessions.modelId,
                isArchived: sessions.isArchived,
                messageCount: count(messages.id),
            })
            .from(sessions)
            .leftJoin(messages, eq(sessions.id, messages.sessionId))
            .where(includeArchived ? undefined : eq(sessions.isArchived, false))
            .groupBy(sessions.id)
            // id is a tiebreaker so paging is deterministic when timestamps collide
            .orderBy(desc(sessions.createdAt), desc(sessions.id))
            .limit(limit)
            .offset(offset);

        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            modelId: row.modelId ?? undefined,
            isArchived: row.isArchived,
            messageCount: Number(row.messageCount),
        }));
    }

    async addMessage(sessionId: string, message: ChatMessage): Promise<void> {
        const { sessions, messages } = this.t;

        // Auto-generate title if it's the first user message and session has default title
        if (message.role === "user") {
            const [session] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
            if (session && session.title === "New Session") {
                const newTitle = message.content.substring(0, 80).replace(/\n/g, " ") || "New Session";
                await this.updateTitle(sessionId, newTitle);
            }
        }

        await this.db.insert(messages).values({
            sessionId,
            role: message.role,
            content: message.content,
            toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
            toolCallId: message.toolCallId ?? null,
            createdAt: (message.timestamp || new Date()).toISOString(),
        });

        await this.touch(sessionId);
    }

    async getMessages(sessionId: string): Promise<ChatMessage[]> {
        const { messages } = this.t;
        const rows = await this.db
            .select()
            .from(messages)
            .where(eq(messages.sessionId, sessionId))
            .orderBy(messages.id);

        return rows.map((row) => {
            const msg: ChatMessage = {
                role: row.role as ChatMessage["role"],
                content: row.content,
                timestamp: new Date(row.createdAt),
            };
            if (row.toolCalls) {
                try {
                    msg.toolCalls = JSON.parse(row.toolCalls);
                } catch {
                    // A corrupt tool_calls blob must not make the whole session unreadable
                }
            }
            if (row.toolCallId) {
                msg.toolCallId = row.toolCallId;
            }
            return msg;
        });
    }

    async updateTitle(sessionId: string, title: string): Promise<void> {
        const { sessions } = this.t;
        await this.db
            .update(sessions)
            .set({ title, updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, sessionId));
    }

    async touch(sessionId: string): Promise<void> {
        const { sessions } = this.t;
        await this.db
            .update(sessions)
            .set({ updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, sessionId));
    }

    async archive(sessionId: string): Promise<void> {
        const { sessions } = this.t;
        await this.db
            .update(sessions)
            .set({ isArchived: true, updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, sessionId));
    }

    async delete(sessionId: string): Promise<void> {
        const { sessions } = this.t;
        await this.db.delete(sessions).where(eq(sessions.id, sessionId));
    }

    async getLatest(): Promise<Session | undefined> {
        const { sessions } = this.t;
        const [row] = await this.db
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.isArchived, false))
            .orderBy(desc(sessions.updatedAt))
            .limit(1);

        if (!row) return undefined;
        return this.get(row.id);
    }
}
