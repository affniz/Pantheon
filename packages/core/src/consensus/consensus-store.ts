import { eq, desc } from "drizzle-orm";
import type { ConsensusResponse } from "@pantheon/shared";
import { DbStore } from "../db/store.js";

/** Summary row for `GET /api/consensus` (everything except the bulky response bodies). */
export interface ConsensusRunSummary {
    id: string;
    sessionId: string | null;
    promptHash: string;
    synthesisLatencyMs: number;
    qualityScore: number | null;
    createdAt: string;
}

export interface ConsensusRunDetail extends ConsensusRunSummary {
    synthesizedContent: string;
    modelResponses: ConsensusResponse[];
}

/** Persistence for consensus fan-out runs (`consensus_runs`). */
export class ConsensusStore extends DbStore {
    async save(run: {
        id: string;
        sessionId?: string;
        promptHash: string;
        synthesizedContent: string;
        responses: ConsensusResponse[];
        synthesisLatencyMs: number;
    }): Promise<void> {
        const { consensusRuns } = this.t;
        await this.db.insert(consensusRuns).values({
            id: run.id,
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
            promptHash: run.promptHash,
            synthesizedContent: run.synthesizedContent,
            modelResponses: JSON.stringify(run.responses),
            synthesisLatencyMs: run.synthesisLatencyMs,
            createdAt: new Date().toISOString(),
        });
    }

    async updateQualityScore(runId: string, qualityScore: number): Promise<void> {
        const { consensusRuns } = this.t;
        await this.db.update(consensusRuns).set({ qualityScore }).where(eq(consensusRuns.id, runId));
    }

    /** Most recent runs first. */
    async list(limit = 20): Promise<ConsensusRunSummary[]> {
        const { consensusRuns } = this.t;
        return this.db
            .select({
                id: consensusRuns.id,
                sessionId: consensusRuns.sessionId,
                promptHash: consensusRuns.promptHash,
                synthesisLatencyMs: consensusRuns.synthesisLatencyMs,
                qualityScore: consensusRuns.qualityScore,
                createdAt: consensusRuns.createdAt,
            })
            .from(consensusRuns)
            .orderBy(desc(consensusRuns.createdAt))
            .limit(limit);
    }

    async get(id: string): Promise<ConsensusRunDetail | undefined> {
        const { consensusRuns } = this.t;
        const [run] = await this.db.select().from(consensusRuns).where(eq(consensusRuns.id, id)).limit(1);
        if (!run) return undefined;

        let modelResponses: ConsensusResponse[] = [];
        try {
            modelResponses = JSON.parse(run.modelResponses) as ConsensusResponse[];
        } catch {
            // A corrupt blob should not make the run unreadable
        }
        return { ...run, modelResponses };
    }
}
