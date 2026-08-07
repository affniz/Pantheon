export interface ModelProfile {
    id: string;
    provider: "groq" | "openai" | "anthropic" | "google" | "mistral";
    displayName: string;
    contextWindow: number;
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
    strengths: string[];
}
export type ComplexityTier = "simple" | "standard" | "complex";

export interface RoutingDecision {
    tier: ComplexityTier;
    selectedModelId: string;
    reason: string;
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