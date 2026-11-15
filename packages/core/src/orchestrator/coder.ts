import { SpecialistAgent, type SpecialistCommon, type SpecialistResult } from "./specialist.js";

export interface CoderConfig extends SpecialistCommon {
    /** Model this agent runs on (normally the complex-tier model). */
    coderModelId: string;
}

export type CoderResult = SpecialistResult;

/**
 * CoderAgent — the "coder" specialist: code generation and implementation.
 * A role preset over SpecialistAgent; see specialist.ts for behaviour.
 */
export class CoderAgent extends SpecialistAgent {
    constructor(config: CoderConfig) {
        const { coderModelId, ...common } = config;
        super({ ...common, role: "coder", modelId: coderModelId });
    }
}
