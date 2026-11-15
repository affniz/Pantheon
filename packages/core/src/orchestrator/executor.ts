import { SpecialistAgent, type SpecialistCommon, type SpecialistResult } from "./specialist.js";

export interface ExecutorConfig extends SpecialistCommon {
    /** Model this agent runs on (normally the complex-tier model). */
    executorModelId: string;
}

export type ExecutorResult = SpecialistResult;

/**
 * ExecutorAgent — the "executor" specialist: general tasks (research, documentation, Q&A).
 * A role preset over SpecialistAgent; see specialist.ts for behaviour.
 */
export class ExecutorAgent extends SpecialistAgent {
    constructor(config: ExecutorConfig) {
        const { executorModelId, ...common } = config;
        super({ ...common, role: "executor", modelId: executorModelId });
    }
}
