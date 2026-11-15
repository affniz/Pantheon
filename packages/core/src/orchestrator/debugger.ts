import { SpecialistAgent, type SpecialistCommon, type SpecialistResult } from "./specialist.js";

export interface DebuggerConfig extends SpecialistCommon {
    /** Model this agent runs on (normally the complex-tier model). */
    debuggerModelId: string;
}

export type DebuggerResult = SpecialistResult;

/**
 * DebuggerAgent — the "debugger" specialist: root-cause analysis and fixes.
 * A role preset over SpecialistAgent; see specialist.ts for behaviour.
 */
export class DebuggerAgent extends SpecialistAgent {
    constructor(config: DebuggerConfig) {
        const { debuggerModelId, ...common } = config;
        super({ ...common, role: "debugger", modelId: debuggerModelId });
    }
}
