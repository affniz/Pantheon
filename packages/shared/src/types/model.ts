export interface ModelProfile {
    id: string;
    provider: "groq" | "openai" | "anthropic" | "mistral";
    displayName: string;
    contextWindow: number;
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
    strengths: string[];
}

export type ComplexityTier = "general" | "simple" | "standard" | "complex";

export interface RoutingDecision {
    tier: ComplexityTier;
    selectedModelId: string;
    reason: string;
    /**
     * Classifier confidence score (0–1). Present when the classifier emits it.
     * When below `RoutingConfig.confidenceThreshold`, the tier is escalated to `complex`.
     */
    confidence?: number;
}

export interface UsageRecord {
    id?: number;
    timestamp: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    promptPreview: string;
}