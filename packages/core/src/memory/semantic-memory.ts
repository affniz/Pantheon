import type { PantheonDatabase } from "../db/client.js";
import { chunkText, type Embedder } from "./embedder.js";
import { MemoryStore, type MemoryHit, type MemoryStatus } from "./memory-store.js";

export interface SemanticMemoryOptions {
    /** Results injected into the prompt. Default 5. */
    topK?: number;
    /** Minimum cosine similarity for a memory to be considered relevant. Default 0.35. */
    minScore?: number;
    /** Characters of each memory shown to the model. Default 600. */
    snippetChars?: number;
    /** Messages shorter than this are not worth remembering ("ok", "thanks"). Default 16. */
    minMessageChars?: number;
}

/** Embedding requests are batched to this many texts. */
const EMBED_BATCH = 32;

/**
 * Semantic (retrieval-augmented) memory.
 *
 * Episodic memory — LLM-written summaries of past sessions — loses detail the
 * longer a project runs, because summaries get summarised. Semantic memory keeps
 * the original messages, embeds them, and at the start of each turn retrieves the
 * few passages most similar to what the user is asking now, however old they are.
 */
export class SemanticMemory {
    private embedder: Embedder;
    private store: MemoryStore;
    private options: Required<SemanticMemoryOptions>;

    constructor(embedder: Embedder, options: SemanticMemoryOptions = {}, db?: PantheonDatabase) {
        this.embedder = embedder;
        this.store = new MemoryStore(db);
        this.options = {
            topK: options.topK ?? 5,
            minScore: options.minScore ?? 0.35,
            snippetChars: options.snippetChars ?? 600,
            minMessageChars: options.minMessageChars ?? 16,
        };
    }

    /**
     * Embed and store the messages of a session that are not indexed yet.
     * Incremental and idempotent — safe to call after every turn.
     * Returns the number of chunks added.
     */
    async indexSession(sessionId: string): Promise<number> {
        const model = this.embedder.modelId;
        const after = await this.store.lastIndexedMessageId(sessionId, model);
        const messages = await this.store.messagesToIndex(sessionId, after);

        const pending: Array<{ messageId: number; chunkIndex: number; role: string; content: string }> = [];
        for (const message of messages) {
            if (message.content.trim().length < this.options.minMessageChars) continue;
            chunkText(message.content).forEach((content, chunkIndex) => {
                pending.push({ messageId: message.id, chunkIndex, role: message.role, content });
            });
        }
        if (pending.length === 0) return 0;

        let added = 0;
        for (let i = 0; i < pending.length; i += EMBED_BATCH) {
            const batch = pending.slice(i, i + EMBED_BATCH);
            const vectors = await this.embedder.embed(batch.map((c) => c.content));
            if (vectors.length !== batch.length) {
                throw new Error(`Embedding model returned ${vectors.length} vectors for ${batch.length} texts.`);
            }
            added += await this.store.insert(
                batch.map((chunk, j) => ({ ...chunk, sessionId, embedding: vectors[j]!, embeddingModel: model })),
            );
        }
        return added;
    }

    /** Index every session (first-time setup, or after changing the embedding model). */
    async indexAll(onProgress?: (done: number, total: number) => void): Promise<{ sessions: number; chunks: number }> {
        const ids = await this.store.allSessionIds();
        let chunks = 0;
        for (let i = 0; i < ids.length; i++) {
            chunks += await this.indexSession(ids[i]!);
            onProgress?.(i + 1, ids.length);
        }
        return { sessions: ids.length, chunks };
    }

    /** Passages from past conversations most similar to `query`, best first. */
    async search(
        query: string,
        scope: { excludeSessionId?: string | undefined; userId?: string | undefined; topK?: number; minScore?: number } = {},
    ): Promise<MemoryHit[]> {
        const text = query.trim();
        if (!text) return [];
        const [vector] = await this.embedder.embed([text.slice(0, 4000)]);
        if (!vector) return [];
        return this.store.search(vector, {
            embeddingModel: this.embedder.modelId,
            topK: scope.topK ?? this.options.topK,
            minScore: scope.minScore ?? this.options.minScore,
            excludeSessionId: scope.excludeSessionId,
            userId: scope.userId,
        });
    }

    /**
     * A system-prompt block with the memories relevant to `query`, or "" when
     * nothing clears the relevance threshold.
     */
    async buildContext(
        query: string,
        scope: { excludeSessionId?: string | undefined; userId?: string | undefined } = {},
    ): Promise<string> {
        const hits = await this.search(query, scope);
        if (hits.length === 0) return "";

        const lines = hits.map((hit) => {
            const date = new Date(hit.createdAt).toISOString().slice(0, 10);
            const snippet = hit.content.length > this.options.snippetChars
                ? hit.content.slice(0, this.options.snippetChars) + "…"
                : hit.content;
            return `- [${date}] "${hit.sessionTitle}" — ${hit.role}: ${snippet.replace(/\s+/g, " ")}`;
        });
        return (
            "## Relevant memory (retrieved from past conversations)\n" +
            "These excerpts were selected because they resemble the current request. " +
            "Use them if they help; they may be outdated.\n" +
            lines.join("\n")
        );
    }

    status(): Promise<MemoryStatus> {
        return this.store.status();
    }

    /** Forget everything indexed with the current embedding model (or all models). */
    clear(allModels = false): Promise<number> {
        return this.store.clear(allModels ? undefined : this.embedder.modelId);
    }
}
