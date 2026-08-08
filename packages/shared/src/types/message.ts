import type { ToolCall } from "./tool.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
    role: MessageRole;
    content: string;
    timestamp?: Date;
    /** Present when role === "assistant" and the LLM requests tool calls */
    toolCalls?: ToolCall[];
    /** Present when role === "tool" — the ID of the tool call this responds to */
    toolCallId?: string;
}