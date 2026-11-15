import { Gateway, ModelRegistry, SemanticMemory, loadConfig } from "@pantheon/core";

/**
 * Semantic memory as configured in config.yml (`memory.semantic`), or undefined
 * when it is switched off. `PANTHEON_EMBEDDING_MODEL` enables it from the
 * environment (handy in Docker) and overrides the configured model.
 */
export function semanticMemory(gateway?: Gateway): SemanticMemory | undefined {
    const settings = loadConfig().memory?.semantic;
    const envModel = process.env["PANTHEON_EMBEDDING_MODEL"]?.trim();
    const model = envModel || (settings?.enabled ? settings.embeddingModel : undefined);
    if (!model) return undefined;

    return new SemanticMemory((gateway ?? new Gateway(new ModelRegistry())).embedder(model), {
        ...(settings?.topK !== undefined ? { topK: settings.topK } : {}),
        ...(settings?.minScore !== undefined ? { minScore: settings.minScore } : {}),
    });
}

export function logMemoryError(what: string, err: unknown): void {
    process.stderr.write(`[memory] ${what} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
}
