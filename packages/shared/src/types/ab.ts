/** A single A/B experiment arm record stored in the database */
export interface ABRunRecord {
    /** UUID */
    id: string;
    experimentId: string;
    sessionId: string;
    /** SHA-256 of the prompt (truncated to 16 hex chars) for grouping */
    promptHash: string;
    arm: "control" | "variant";
    modelId: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    /** 1-10 LLM-judge quality score, filled asynchronously after the response */
    qualityScore?: number;
    createdAt: string;
}

/** Configuration for a single A/B experiment */
export interface ABExperiment {
    id: string;
    name: string;
    /** Percentage of requests (0-100) routed to the variant arm */
    splitPercent: number;
    controlModelId: string;
    variantModelId: string;
    active: boolean;
}

/** Aggregate comparison metrics for an experiment */
export interface ABComparison {
    experimentId: string;
    runCount: number;
    controlRunCount: number;
    variantRunCount: number;
    controlAvgLatencyMs: number;
    variantAvgLatencyMs: number;
    controlAvgQualityScore: number | null;
    variantAvgQualityScore: number | null;
}
