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
    sandbox?: SandboxConfig;
    plugins?: PluginsConfig;
}

export interface ShellAllowlistEntry {
    /** Command binary name (e.g. "git", "ls", "npm") */
    command: string;
    /** Allowed subcommands. Empty array = all subcommands allowed. */
    subcommands?: string[];
    /** Additional argument patterns to block even when command is allowed */
    blockedArgs?: string[]; // stored as string patterns, compiled to RegExp at runtime
    /** Human-readable description for audit logging */
    description: string;
}

export interface SandboxConfig {
    /** Whether to use allowlist mode (true) or bypass all checks (false). Default: true */
    allowlistEnabled: boolean;
    /** Additional entries to add to the default allowlist */
    additionalAllowlist: ShellAllowlistEntry[];
    /** Command binary names to remove from the default allowlist */
    denyFromDefault: string[];
}

export interface PluginsConfig {
    /** Directory where plugins are installed. Default: ~/.pantheon/plugins */
    directory: string;
    /** Whether to auto-start MCP servers on boot. Default: false */
    autoStart: boolean;
    /** Keepalive timeout for MCP servers in ms. Default: 300000 (5 min) */
    keepaliveTimeout: number;
}