export interface ModelConfig {
    id: string;
    provider: string;
    displayName?: string;
}

export interface GatewayConfig {
    baseUrl: string;
    masterKey: string;
}

export interface RoutingConfig {
    enabled: boolean;
    tiers: {
        simple: string;
        standard: string;
        complex: string;
    };
    classifierPrompt?: string;
}

export interface PantheonConfig {
    models: ModelConfig[];
    gateway: GatewayConfig;
    routing: RoutingConfig;
    defaultModel?: string;
}