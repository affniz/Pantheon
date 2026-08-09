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
