export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
    role: MessageRole;
    content: string;
    timestamp?: Date;
}