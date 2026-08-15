import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ─── Sessions ────────────────────────────────────────────────────────────────

export const sessions = sqliteTable("sessions", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    modelId: text("model_id"),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
});

// ─── Messages ────────────────────────────────────────────────────────────────

export const messages = sqliteTable("messages", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'system' | 'user' | 'assistant' | 'tool'
    content: text("content").notNull(),
    toolCalls: text("tool_calls"), // JSON stringified ToolCall[] | null
    toolCallId: text("tool_call_id"), // for role='tool' messages
    createdAt: text("created_at").notNull(),
    tokenCount: integer("token_count"),
});

// ─── Usage Records ───────────────────────────────────────────────────────────

export const usageRecords = sqliteTable("usage_records", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    timestamp: text("timestamp").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: real("cost_usd").notNull(),
    promptPreview: text("prompt_preview").notNull(),
});

// ─── Session Summaries (Episodic Memory) ─────────────────────────────────────

export const sessionSummaries = sqliteTable("session_summaries", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull().unique().references(() => sessions.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    createdAt: text("created_at").notNull(),
});

// ─── Trace Spans ─────────────────────────────────────────────────────────────

export const spans = sqliteTable("spans", {
    id: text("id").primaryKey(),                          // spanId (UUID)
    traceId: text("trace_id").notNull(),
    parentSpanId: text("parent_span_id"),                 // null on root span
    sessionId: text("session_id"),
    name: text("name").notNull(),                         // e.g. "llm.completion"
    kind: text("kind").notNull(),                         // routing | llm | tool | agent | orchestrator | ...
    startTime: integer("start_time").notNull(),           // epoch ms
    endTime: integer("end_time").notNull(),
    durationMs: integer("duration_ms").notNull(),
    status: text("status").notNull(),                     // ok | error
    errorMessage: text("error_message"),
    attributes: text("attributes"),                       // JSON stringified
    createdAt: integer("created_at").notNull(),           // epoch ms
});

// ─── Agent Nodes (Multi-Agent Orchestration) ─────────────────────────────────

export const agentNodes = sqliteTable("agent_nodes", {
    agentId: text("agent_id").primaryKey(),
    role: text("role").notNull(),                         // planner | executor | reviewer | orchestrator
    modelId: text("model_id").notNull(),
    parentAgentId: text("parent_agent_id"),               // null for root orchestrator
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    taskId: text("task_id"),                              // links to sub_tasks.id (executors only)
    status: text("status").notNull(),                     // pending | running | completed | failed | cancelled
    result: text("result"),
    error: text("error"),
    startTime: integer("start_time").notNull(),           // epoch ms
    endTime: integer("end_time"),
    createdAt: text("created_at").notNull(),
});

// ─── Task Plans (Planner output) ─────────────────────────────────────────────

export const taskPlans = sqliteTable("task_plans", {
    planId: text("plan_id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    originalPrompt: text("original_prompt").notNull(),
    createdAt: text("created_at").notNull(),
});

// ─── Sub-Tasks (individual decomposed tasks) ─────────────────────────────────

export const subTasks = sqliteTable("sub_tasks", {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => taskPlans.planId, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    dependencies: text("dependencies"),                   // JSON array of task IDs
    status: text("status").notNull(),                     // pending | running | completed | failed | cancelled
    result: text("result"),
    error: text("error"),
    agentId: text("agent_id"),                            // references agent_nodes.agentId
    createdAt: text("created_at").notNull(),
});

