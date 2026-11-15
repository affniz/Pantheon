/**
 * PostgreSQL schema — mirrors schema.sqlite.ts column-for-column.
 *
 * Differences are purely physical: SERIAL instead of AUTOINCREMENT, BOOLEAN instead of
 * 0/1 integers, BIGINT for epoch-millisecond columns (they overflow int4) and
 * DOUBLE PRECISION instead of REAL. The TypeScript row types are identical, which is
 * what lets every store run unchanged on either backend (see client.ts `tablesFor`).
 * `schema-parity.test.ts` fails if the two files drift apart.
 */
import { pgTable, text, integer, serial, bigint, boolean, doublePrecision } from "drizzle-orm/pg-core";

// ─── Users & API tokens (v0.9 auth) ──────────────────────────────────────────

export const users = pgTable("users", {
    id: text("id").primaryKey(),                             // UUID
    email: text("email").notNull().unique(),                 // lower-cased
    name: text("name"),
    provider: text("provider").notNull(),                    // "github" | "google" | "local"
    providerUserId: text("provider_user_id").notNull(),      // stable id at the provider
    role: text("role").notNull(),                            // "owner" | "member"
    createdAt: text("created_at").notNull(),
    lastLoginAt: text("last_login_at"),
});

export const apiTokens = pgTable("api_tokens", {
    id: text("id").primaryKey(),                             // UUID (public, used to revoke)
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),        // SHA-256 of the token; the token itself is never stored
    tokenPrefix: text("token_prefix").notNull(),             // first characters, to recognise a token in listings
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
});

// ─── Sessions ────────────────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    modelId: text("model_id"),
    /** Owner, when the session was created by an authenticated user. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    isArchived: boolean("is_archived").notNull().default(false),
});

// ─── Messages ────────────────────────────────────────────────────────────────

export const messages = pgTable("messages", {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'system' | 'user' | 'assistant' | 'tool'
    content: text("content").notNull(),
    toolCalls: text("tool_calls"), // JSON stringified ToolCall[] | null
    toolCallId: text("tool_call_id"), // for role='tool' messages
    createdAt: text("created_at").notNull(),
    tokenCount: integer("token_count"),
});

// ─── Usage Records ───────────────────────────────────────────────────────────

export const usageRecords = pgTable("usage_records", {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    timestamp: text("timestamp").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: doublePrecision("cost_usd").notNull(),
    promptPreview: text("prompt_preview").notNull(),
});

// ─── Session Summaries (Episodic Memory) ─────────────────────────────────────

export const sessionSummaries = pgTable("session_summaries", {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull().unique().references(() => sessions.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    createdAt: text("created_at").notNull(),
});

// ─── Trace Spans ─────────────────────────────────────────────────────────────

export const spans = pgTable("spans", {
    id: text("id").primaryKey(),                          // spanId (UUID)
    traceId: text("trace_id").notNull(),
    parentSpanId: text("parent_span_id"),                 // null on root span
    sessionId: text("session_id"),
    name: text("name").notNull(),                         // e.g. "llm.completion"
    kind: text("kind").notNull(),                         // routing | llm | tool | agent | orchestrator | ...
    startTime: bigint("start_time", { mode: "number" }).notNull(),           // epoch ms
    endTime: bigint("end_time", { mode: "number" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    status: text("status").notNull(),                     // ok | error
    errorMessage: text("error_message"),
    attributes: text("attributes"),                       // JSON stringified
    createdAt: bigint("created_at", { mode: "number" }).notNull(),           // epoch ms
});

// ─── Agent Nodes (Multi-Agent Orchestration) ─────────────────────────────────

export const agentNodes = pgTable("agent_nodes", {
    agentId: text("agent_id").primaryKey(),
    role: text("role").notNull(),                         // planner | executor | reviewer | orchestrator
    modelId: text("model_id").notNull(),
    parentAgentId: text("parent_agent_id"),               // null for root orchestrator
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    taskId: text("task_id"),                              // links to sub_tasks.id (executors only)
    status: text("status").notNull(),                     // pending | running | completed | failed | cancelled
    result: text("result"),
    error: text("error"),
    startTime: bigint("start_time", { mode: "number" }).notNull(),           // epoch ms
    endTime: bigint("end_time", { mode: "number" }),
    createdAt: text("created_at").notNull(),
});

// ─── Task Plans (Planner output) ─────────────────────────────────────────────

export const taskPlans = pgTable("task_plans", {
    planId: text("plan_id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    originalPrompt: text("original_prompt").notNull(),
    createdAt: text("created_at").notNull(),
});

// ─── Sub-Tasks (individual decomposed tasks) ─────────────────────────────────

export const subTasks = pgTable("sub_tasks", {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => taskPlans.planId, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    dependencies: text("dependencies"),                   // JSON array of task IDs
    taskRole: text("task_role"),                          // "code" | "debug" | "general"
    status: text("status").notNull(),                     // pending | running | completed | failed | cancelled
    result: text("result"),
    error: text("error"),
    agentId: text("agent_id"),                            // references agent_nodes.agentId
    createdAt: text("created_at").notNull(),
});

export const installedPlugins = pgTable("installed_plugins", {
    name: text("name").primaryKey(),                         // Plugin package name (primary key)
    version: text("version").notNull(),
    source: text("source").notNull(),                        // npm package or local path
    installedAt: bigint("installed_at", { mode: "number" }).notNull(),          // epoch ms
    enabled: boolean("enabled").notNull().default(true),
    config: text("config"),                                  // JSON plugin settings
    directory: text("directory").notNull(),                  // absolute path to plugin dir
});

// ─── Consensus Runs (v0.8) ────────────────────────────────────────────────────

export const consensusRuns = pgTable("consensus_runs", {
    id: text("id").primaryKey(),                             // UUID
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    promptHash: text("prompt_hash").notNull(),               // first 16 hex chars of SHA-256
    synthesizedContent: text("synthesized_content").notNull(),
    /** JSON array of ConsensusResponse objects */
    modelResponses: text("model_responses").notNull(),
    synthesisLatencyMs: integer("synthesis_latency_ms").notNull(),
    qualityScore: doublePrecision("quality_score"),                      // 1–10, nullable until judged async
    createdAt: text("created_at").notNull(),
});

// ─── A/B Run Records (v0.8) ──────────────────────────────────────────────────

export const abRuns = pgTable("ab_runs", {
    id: text("id").primaryKey(),                             // UUID
    experimentId: text("experiment_id").notNull(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    promptHash: text("prompt_hash").notNull(),
    arm: text("arm").notNull(),                              // "control" | "variant"
    modelId: text("model_id").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    qualityScore: doublePrecision("quality_score"),                     // 1–10, nullable until judged
    createdAt: text("created_at").notNull(),
});


// ─── Semantic memory (v0.9) ───────────────────────────────────────────────────

export const memoryChunks = pgTable("memory_chunks", {
    id: text("id").primaryKey(),                             // `${messageId}:${chunkIndex}`
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    messageId: integer("message_id").notNull(),              // messages.id the chunk was cut from
    chunkIndex: integer("chunk_index").notNull(),
    role: text("role").notNull(),                            // "user" | "assistant"
    content: text("content").notNull(),
    embedding: text("embedding").notNull(),                  // JSON array of floats (portable across backends)
    embeddingModel: text("embedding_model").notNull(),
    dimensions: integer("dimensions").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),   // epoch ms
});
