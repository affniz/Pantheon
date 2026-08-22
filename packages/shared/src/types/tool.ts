/** A tool parameter described as a JSON Schema property */
export interface ToolParameter {
    type: "string" | "number" | "boolean" | "array" | "object";
    description: string;
    enum?: string[];
    items?: ToolParameter;
    required?: boolean;
}

/**
 * Full tool definition — registered with the agent runtime.
 * The `parameters` field follows JSON Schema format for OpenAI function calling.
 */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, ToolParameter>;
        required: string[];
    };
    /**
     * Safety classification — controls the permission flow:
     * - "safe": first-use prompt with allow-once / always-allow / deny
     * - "destructive": always prompts [y/n] before every execution
     */
    safety: "safe" | "destructive";
    pluginName?: string;
}

/** A tool call requested by the LLM */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/** Result of executing a tool */
export interface ToolResult {
    toolCallId: string;
    name: string;
    content: string;
    isError: boolean;
}
