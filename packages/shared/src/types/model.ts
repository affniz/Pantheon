export interface ModelProfile {
    id: string;
    provider: "groq" | "openai" | "anthropic" | "google" | "mistral";
    displayName: string;
    contextWindow: number;
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
    strengths: string[];
}