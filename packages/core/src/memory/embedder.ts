/** Turns text into vectors. Implemented by the LiteLLM gateway; faked in tests. */
export interface Embedder {
    /** Identifies the vector space — vectors from different models are never compared. */
    readonly modelId: string;
    /** One vector per input text, in order. */
    embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity in [-1, 1]; 0 when either vector is empty, zero, or of another length. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        dot += x * y;
        normA += x * x;
        normB += y * y;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / Math.sqrt(normA * normB);
}

/**
 * Cut text into chunks of at most `maxChars`, preferring paragraph, then line,
 * then sentence boundaries, so a retrieved chunk reads as a coherent passage
 * rather than starting mid-word. At most `maxChunks` are returned.
 */
export function chunkText(text: string, maxChars = 1200, maxChunks = 8): string[] {
    const clean = text.replace(/\r\n/g, "\n").trim();
    if (!clean) return [];
    if (clean.length <= maxChars) return [clean];

    const chunks: string[] = [];
    let rest = clean;
    while (rest.length > 0 && chunks.length < maxChunks) {
        if (rest.length <= maxChars) {
            chunks.push(rest);
            break;
        }
        const window = rest.slice(0, maxChars);
        // Latest boundary in the second half of the window; otherwise a hard cut
        let cut = -1;
        for (const boundary of ["\n\n", "\n", ". ", " "]) {
            const at = window.lastIndexOf(boundary);
            if (at >= maxChars / 2) {
                cut = at + boundary.length;
                break;
            }
        }
        if (cut === -1) cut = maxChars;
        const piece = rest.slice(0, cut).trim();
        if (piece) chunks.push(piece);
        rest = rest.slice(cut).trim();
    }
    return chunks;
}
