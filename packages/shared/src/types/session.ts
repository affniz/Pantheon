/** A chat session — a single conversation with the agent */
export interface Session {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    modelId?: string | undefined;
    isArchived: boolean;
    /** Message count — populated by queries, not stored directly */
    messageCount?: number | undefined;
}

/** An LLM-generated summary of a completed session (episodic memory) */
export interface SessionSummary {
    id?: number | undefined;
    sessionId: string;
    summary: string;
    createdAt: string;
}
