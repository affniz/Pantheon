export interface ModelConfig {
    id: string;
    provider: string;
    displayName?: string;
}

export interface GatewayConfig {
    baseUrl: string;
    masterKey: string;
}

export interface PantheonConfig {
    models: ModelConfig[];
    gateway: GatewayConfig;
    defaultModel?: string;
}