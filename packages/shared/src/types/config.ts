export interface ModelConfig {
    id: string;
    provider: string;
    displayName?: string;
    /** Real upstream model name, used when provider needs direct routing (e.g. google). Defaults to id. */
    modelName?: string;
}

export interface GatewayConfig {
    baseUrl: string;
    masterKey: string;
}

export interface RoutingConfig {
    enabled: boolean;
    tiers: {
        /** Greetings, small talk, general questions → llama-smart */
        general: string;
        /** Simple & moderate coding tasks → deepseek-v4-flash */
        simple: string;
        /** Moderate multi-step tasks → deepseek-v4-flash */
        standard: string;
        /** Complex coding, architecture, debugging → deepseek-v4-pro */
        complex: string;
    };
    classifierPrompt?: string;
    /**
     * Number of recent user messages to include as context when classifying a prompt.
     * Allows "debug this" to be routed correctly when prior messages describe a complex task.
     * Default: 5
     */
    routingContextDepth?: number;
}

export interface PantheonConfig {
    models: ModelConfig[];
    gateway: GatewayConfig;
    routing: RoutingConfig;
    defaultModel?: string;
}