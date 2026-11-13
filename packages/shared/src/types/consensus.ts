/** Per-model response in a consensus fan-out */
export interface ConsensusResponse {
    modelId: string;
    content: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    /** Set when the model call failed */
    error?: string;
}

/** Result of a consensus run (fan-out + synthesis) */
export interface ConsensusResult {
    /** ID of the persisted record in consensus_runs */
    runId: string;
    responses: ConsensusResponse[];
    synthesizedContent: string;
    synthesisLatencyMs: number;
}
