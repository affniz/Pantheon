import { and, asc, count, desc, eq, gt, inArray, isNull, lt, max, ne, or, sql } from "drizzle-orm";
import { DbStore } from "../db/store.js";
import { dialectOf, rawExecutor, type PantheonDatabase } from "../db/client.js";
import { cosineSimilarity } from "./embedder.js";

export interface MemoryChunkInput {
    sessionId: string;
    messageId: number;
    chunkIndex: number;
    role: string;
    content: string;
    embedding: number[];
    embeddingModel: string;
}

export interface MemoryHit {
    id: string;
    sessionId: string;
    sessionTitle: string;
    messageId: number;
    role: string;
    content: string;
    /** Cosine similarity to the query, 0–1 for typical embedding models. */
    score: number;
    createdAt: number;
}

export interface MemorySearchOptions {
    /** Embedding model the query vector came from; only chunks from the same model are searched. */
    embeddingModel: string;
    /** Number of results. Default 5. */
    topK?: number;
    /** Drop results scoring below this. Default 0 (no threshold). */
    minScore?: number;
    /** Never return chunks of this session (the conversation in progress). */
    excludeSessionId?: string | undefined;
    /** Only chunks of sessions this user owns, or that have no owner. */
    userId?: string | undefined;
    /**
     * Most-recent chunks considered when searching without pgvector, where the
     * similarity is computed in this process. Default 5,000.
     */
    maxCandidates?: number;
}

export interface MemoryStatus {
    /** `pgvector` when similarity search runs inside PostgreSQL, `in-process` otherwise. */
    search: "pgvector" | "in-process";
    chunks: number;
    sessions: number;
    models: Array<{ embeddingModel: string; dimensions: number; chunks: number }>;
}

/** Per database handle: is the native vector column available? (Checked once.) */
const VECTOR_SUPPORT = new WeakMap<object, Promise<boolean>>();

const PAGE = 500;

/**
 * Storage and similarity search for semantic memory.
 *
 * Embeddings are stored as JSON text so the table is the same on SQLite and
 * PostgreSQL. Search then takes one of two paths:
 *
 *  • PostgreSQL with pgvector — a native `embedding_vec vector` column is added
 *    next to the JSON one and the nearest neighbours are found in the database
 *    (`ORDER BY embedding_vec <=> query`).
 *  • Everything else (SQLite, or PostgreSQL without the extension) — the most
 *    recent chunks are streamed in pages and scored in this process. Exact, and
 *    fine for a personal history; bounded by `maxCandidates`.
 */
export class MemoryStore extends DbStore {
    /**
     * Try to enable pgvector for this database: create the extension, add the
     * native column, and backfill it from the JSON column (rows copied by
     * `pantheon db migrate`, or indexed before the extension was installed).
     */
    private vectorEnabled(): Promise<boolean> {
        const db = this.db;
        let known = VECTOR_SUPPORT.get(db);
        if (!known) {
            known = this.enableVector(db);
            VECTOR_SUPPORT.set(db, known);
        }
        return known;
    }

    private async enableVector(db: PantheonDatabase): Promise<boolean> {
        if (dialectOf(db) !== "postgres") return false;
        if (process.env["PANTHEON_DISABLE_PGVECTOR"] === "1") return false;
        const raw = rawExecutor(db);
        try {
            // Fails when the extension is not installed on the server, or the role may
            // not create extensions — both simply mean "use the in-process path".
            await raw.exec("CREATE EXTENSION IF NOT EXISTS vector");
            await raw.exec("ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector");
            // The JSON text of a float array ("[0.1,0.2]") is also a valid vector literal
            await raw.exec("UPDATE memory_chunks SET embedding_vec = embedding::vector WHERE embedding_vec IS NULL");
            return true;
        } catch {
            return false;
        }
    }

    /** Store chunks; chunks that already exist (same message and index) are left untouched. */
    async insert(chunks: MemoryChunkInput[]): Promise<number> {
        if (chunks.length === 0) return 0;
        const { memoryChunks } = this.t;
        const now = Date.now();
        const rows = chunks.map((c) => ({
            id: `${c.messageId}:${c.chunkIndex}`,
            sessionId: c.sessionId,
            messageId: c.messageId,
            chunkIndex: c.chunkIndex,
            role: c.role,
            content: c.content,
            embedding: JSON.stringify(c.embedding),
            embeddingModel: c.embeddingModel,
            dimensions: c.embedding.length,
            createdAt: now,
        }));

        let inserted = 0;
        for (let i = 0; i < rows.length; i += PAGE) {
            const written = await this.db
                .insert(memoryChunks)
                .values(rows.slice(i, i + PAGE))
                .onConflictDoNothing()
                .returning({ id: memoryChunks.id });
            inserted += written.length;
        }

        if (inserted > 0 && (await this.vectorEnabled())) {
            await rawExecutor(this.db).exec(
                "UPDATE memory_chunks SET embedding_vec = embedding::vector WHERE embedding_vec IS NULL",
            );
        }
        return inserted;
    }

    /** Highest message id of `sessionId` that has been indexed with `embeddingModel` (0 = none). */
    async lastIndexedMessageId(sessionId: string, embeddingModel: string): Promise<number> {
        const { memoryChunks } = this.t;
        const [row] = await this.db
            .select({ last: max(memoryChunks.messageId) })
            .from(memoryChunks)
            .where(and(eq(memoryChunks.sessionId, sessionId), eq(memoryChunks.embeddingModel, embeddingModel)));
        return Number(row?.last ?? 0);
    }

    /** User and assistant messages of a session that come after `afterMessageId`. */
    async messagesToIndex(sessionId: string, afterMessageId: number): Promise<Array<{ id: number; role: string; content: string }>> {
        const { messages } = this.t;
        return this.db
            .select({ id: messages.id, role: messages.role, content: messages.content })
            .from(messages)
            .where(and(
                eq(messages.sessionId, sessionId),
                gt(messages.id, afterMessageId),
                inArray(messages.role, ["user", "assistant"]),
            ))
            .orderBy(asc(messages.id));
    }

    /** Ids of every session, oldest first (for a full re-index). */
    async allSessionIds(): Promise<string[]> {
        const { sessions } = this.t;
        return (await this.db.select({ id: sessions.id }).from(sessions).orderBy(asc(sessions.createdAt))).map((r) => r.id);
    }

    /** Nearest chunks to `queryEmbedding`, best first. */
    async search(queryEmbedding: number[], options: MemorySearchOptions): Promise<MemoryHit[]> {
        const topK = Math.max(1, options.topK ?? 5);
        const minScore = options.minScore ?? 0;
        if (queryEmbedding.length === 0) return [];

        const hits = (await this.vectorEnabled())
            ? await this.searchPgvector(queryEmbedding, options, topK)
            : await this.searchInProcess(queryEmbedding, options, topK);
        return hits.filter((h) => h.score >= minScore);
    }

    private async searchPgvector(query: number[], options: MemorySearchOptions, topK: number): Promise<MemoryHit[]> {
        const literal = JSON.stringify(query);
        const exclude = options.excludeSessionId ? sql`AND c.session_id <> ${options.excludeSessionId}` : sql``;
        const owner = options.userId ? sql`AND (s.user_id = ${options.userId} OR s.user_id IS NULL)` : sql``;

        const statement = sql`
            SELECT c.id, c.session_id, s.title AS session_title, c.message_id, c.role, c.content, c.created_at,
                   1 - (c.embedding_vec <=> ${literal}::vector) AS score
            FROM memory_chunks c
            JOIN sessions s ON s.id = c.session_id
            WHERE c.embedding_model = ${options.embeddingModel}
              AND c.dimensions = ${query.length}
              AND c.embedding_vec IS NOT NULL
              ${exclude}
              ${owner}
            ORDER BY c.embedding_vec <=> ${literal}::vector
            LIMIT ${topK}`;

        // `execute` exists on the PostgreSQL Drizzle handles (node-postgres and PGlite);
        // the shared handle type is the SQLite one, hence the cast.
        const result = await (this.db as unknown as {
            execute(q: unknown): Promise<{ rows: Array<Record<string, unknown>> }>;
        }).execute(statement);

        return result.rows.map((r) => ({
            id: String(r["id"]),
            sessionId: String(r["session_id"]),
            sessionTitle: String(r["session_title"] ?? ""),
            messageId: Number(r["message_id"]),
            role: String(r["role"]),
            content: String(r["content"]),
            score: Number(r["score"]),
            createdAt: Number(r["created_at"]),
        }));
    }

    private async searchInProcess(query: number[], options: MemorySearchOptions, topK: number): Promise<MemoryHit[]> {
        const { memoryChunks, sessions } = this.t;
        const maxCandidates = Math.max(1, options.maxCandidates ?? 5000);
        const queryVec = Float32Array.from(query);

        const where = and(
            eq(memoryChunks.embeddingModel, options.embeddingModel),
            eq(memoryChunks.dimensions, query.length),
            options.excludeSessionId ? ne(memoryChunks.sessionId, options.excludeSessionId) : undefined,
            options.userId ? or(eq(sessions.userId, options.userId), isNull(sessions.userId)) : undefined,
        );

        // Stream newest-first in pages (keyset on created_at, id) and keep only the
        // current best `topK` — memory stays flat however large the history is.
        const best: Array<{ id: string; score: number }> = [];
        let scanned = 0;
        let cursor: { createdAt: number; id: string } | undefined;

        while (scanned < maxCandidates) {
            const page = await this.db
                .select({ id: memoryChunks.id, embedding: memoryChunks.embedding, createdAt: memoryChunks.createdAt })
                .from(memoryChunks)
                .innerJoin(sessions, eq(sessions.id, memoryChunks.sessionId))
                .where(and(
                    where,
                    cursor
                        ? or(
                            lt(memoryChunks.createdAt, cursor.createdAt),
                            and(eq(memoryChunks.createdAt, cursor.createdAt), lt(memoryChunks.id, cursor.id)),
                        )
                        : undefined,
                ))
                .orderBy(desc(memoryChunks.createdAt), desc(memoryChunks.id))
                .limit(Math.min(PAGE, maxCandidates - scanned));
            if (page.length === 0) break;

            for (const row of page) {
                let vector: number[];
                try {
                    vector = JSON.parse(row.embedding) as number[];
                } catch {
                    continue; // a corrupt embedding is skipped, not fatal
                }
                const score = cosineSimilarity(queryVec, vector);
                if (best.length < topK) {
                    best.push({ id: row.id, score });
                    best.sort((a, b) => b.score - a.score);
                } else if (score > best[best.length - 1]!.score) {
                    best[best.length - 1] = { id: row.id, score };
                    best.sort((a, b) => b.score - a.score);
                }
            }

            scanned += page.length;
            const last = page[page.length - 1]!;
            cursor = { createdAt: last.createdAt, id: last.id };
            if (page.length < PAGE) break;
        }
        if (best.length === 0) return [];

        const rows = await this.db
            .select({
                id: memoryChunks.id,
                sessionId: memoryChunks.sessionId,
                sessionTitle: sessions.title,
                messageId: memoryChunks.messageId,
                role: memoryChunks.role,
                content: memoryChunks.content,
                createdAt: memoryChunks.createdAt,
            })
            .from(memoryChunks)
            .innerJoin(sessions, eq(sessions.id, memoryChunks.sessionId))
            .where(inArray(memoryChunks.id, best.map((b) => b.id)));
        const byId = new Map(rows.map((r) => [r.id, r]));

        return best.flatMap(({ id, score }) => {
            const row = byId.get(id);
            return row ? [{ ...row, score }] : [];
        });
    }

    async status(): Promise<MemoryStatus> {
        const { memoryChunks } = this.t;
        const models = await this.db
            .select({ embeddingModel: memoryChunks.embeddingModel, dimensions: memoryChunks.dimensions, chunks: count() })
            .from(memoryChunks)
            .groupBy(memoryChunks.embeddingModel, memoryChunks.dimensions);
        const [sessionCount] = await this.db
            .select({ n: sql<number>`COUNT(DISTINCT ${memoryChunks.sessionId})` })
            .from(memoryChunks);

        return {
            search: (await this.vectorEnabled()) ? "pgvector" : "in-process",
            chunks: models.reduce((total, m) => total + Number(m.chunks), 0),
            sessions: Number(sessionCount?.n ?? 0),
            models: models.map((m) => ({ embeddingModel: m.embeddingModel, dimensions: m.dimensions, chunks: Number(m.chunks) })),
        };
    }

    /** Delete indexed chunks — all of them, or only those of one embedding model. Returns how many. */
    async clear(embeddingModel?: string): Promise<number> {
        const { memoryChunks } = this.t;
        const removed = await this.db
            .delete(memoryChunks)
            .where(embeddingModel ? eq(memoryChunks.embeddingModel, embeddingModel) : undefined)
            .returning({ id: memoryChunks.id });
        return removed.length;
    }
}
