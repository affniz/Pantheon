import { createHash } from "node:crypto";
import type { ABConfig, ABExperimentConfig, RoutingDecision } from "@pantheon/shared";

export interface ABResolution {
    experimentId: string;
    arm: "control" | "variant";
    modelId: string;
}

/**
 * ABRouter applies A/B traffic splitting to routing decisions.
 *
 * When an active experiment matches the current routing tier, it probabilistically
 * routes requests to the control or variant model based on splitPercent.
 *
 * Decision is stateless per-call (no sticky sessions in v0.8).
 */
export class ABRouter {
    private config: ABConfig;

    constructor(config: ABConfig) {
        this.config = config;
    }

    /**
     * Given a routing decision, check if an active experiment applies.
     * Returns the arm and model to use, or null if no experiment is active.
     *
     * @param decision - The routing decision from the classifier.
     * @param sessionId - Used to seed deterministic assignment per session.
     */
    resolveArm(decision: RoutingDecision, sessionId: string): ABResolution | null {
        const activeExperiments = this.config.experiments.filter((e) => e.active);
        if (activeExperiments.length === 0) return null;

        // Use the first active experiment (v0.8 supports one active experiment at a time)
        const experiment = activeExperiments[0]!;

        // Deterministic hash: same session always gets the same arm
        const hash = createHash("sha256")
            .update(`${experiment.id}:${sessionId}`)
            .digest("hex");
        // Take the first 8 hex chars as a uint32 and normalize to [0, 100)
        const hashNum = parseInt(hash.slice(0, 8), 16);
        const bucket = hashNum % 100;

        const arm: "control" | "variant" = bucket < experiment.splitPercent ? "variant" : "control";
        const modelId = arm === "variant" ? experiment.variantModelId : experiment.controlModelId;

        return { experimentId: experiment.id, arm, modelId };
    }

    /** Returns all active experiments. */
    getActiveExperiments(): ABExperimentConfig[] {
        return this.config.experiments.filter((e) => e.active);
    }
}
