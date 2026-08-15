/** Role an agent plays in the orchestration graph */
export type AgentRole = "planner" | "coder" | "debugger" | "executor" | "reviewer" | "orchestrator";

/** Current lifecycle state of an agent */
export type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** A sub-task decomposed by the planner */
export interface SubTask {
    id: string;
    title: string;
    description: string;
    /** IDs of tasks that must complete before this one can start */
    dependencies: string[];
    status: AgentStatus;
    result?: string;
    error?: string;
    /** ID of the agent assigned to execute this task */
    agentId?: string;
    /**
     * The type of agent to use for this task, assigned by the planner.
     * "code" → CoderAgent, "debug" → DebuggerAgent, "general" → ExecutorAgent
     */
    taskRole?: "code" | "debug" | "general";
}

/** A task plan produced by the planner agent */
export interface TaskPlan {
    planId: string;
    sessionId: string;
    originalPrompt: string;
    tasks: SubTask[];
    createdAt: string;
}

/** Agent node identity in the orchestration tree */
export interface AgentNode {
    agentId: string;
    role: AgentRole;
    modelId: string;
    /** Root agents have no parent */
    parentAgentId?: string;
    sessionId: string;
    /** Which SubTask this agent is working on (executors only) */
    taskId?: string;
    status: AgentStatus;
    result?: string;
    error?: string;
    startTime: number;
    endTime?: number;
}

/** Events emitted during orchestration (streamed as SSE to the CLI) */
export type OrchestrationEvent =
    | { type: "orchestration_start"; planId: string; taskCount: number }
    | { type: "agent_spawned"; agent: AgentNode }
    | { type: "agent_progress"; agentId: string; message: string }
    | { type: "agent_completed"; agentId: string; result: string }
    | { type: "agent_failed"; agentId: string; error: string }
    | { type: "plan_created"; plan: TaskPlan }
    | { type: "review_result"; approved: boolean; feedback: string; finalResponse: string }
    | { type: "orchestration_done"; planId: string; finalResponse: string };
