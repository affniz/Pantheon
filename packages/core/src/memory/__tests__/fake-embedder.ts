import type { Embedder } from "../embedder.js";

/**
 * Deterministic stand-in for an embedding model: a bag-of-words vector where each
 * word hashes to one of `dims` buckets. Texts sharing words get similar vectors,
 * which is all these tests need — no network, no model.
 */
export class FakeEmbedder implements Embedder {
    readonly modelId: string;
    readonly calls: string[][] = [];
    private dims: number;

    constructor(modelId = "fake-embed", dims = 512) {
        this.modelId = modelId;
        this.dims = dims;
    }

    vector(text: string): number[] {
        const v = new Array<number>(this.dims).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
            let h = 2166136261;
            for (let i = 0; i < word.length; i++) {
                h = Math.imul(h ^ word.charCodeAt(i), 16777619);
            }
            v[(h >>> 0) % this.dims]! += 1;
        }
        return v;
    }

    async embed(texts: string[]): Promise<number[][]> {
        this.calls.push(texts);
        return texts.map((t) => this.vector(t));
    }
}
