export interface ModelConfig {
    id: string;
    provider: string;
    displayName?: string;
    /** Real upstream model name, used when provider needs direct routing (e.g. google). Defaults to id. */
    modelName?: string;
    /**
     * Optional pricing used to compute `costUsd` on usage records.
     * When omitted, cost is recorded as 0 (tokens are still tracked).
     */
    pricing?: ModelPricing;
}

/** Per-token pricing in USD per 1M tokens. */
export interface ModelPricing {
    inputPer1M: number;
    outputPer1M: number;
}

export interface GatewayConfig {
    baseUrl: string;
    masterKey: string;
    /**
     * Application-level failover chain for the complex tier.
     * Models are tried in order on transient errors (4xx/5xx / network failure).
     * Default: ["deepseek-v4-pro", "claude-fallback", "gpt-fallback"]
     */
    failoverChain?: string[];
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
    /**
     * Minimum confidence score (0–1) required for a routing tier decision.
     * When the classifier confidence falls below this threshold, the tier is escalated
     * to `complex` (safe escalation — never downgraded from complex).
     * Default: 0.6
     */
    confidenceThreshold?: number;
}

/** Configuration for multi-model consensus (fan-out + synthesis) */
export interface ConsensusConfig {
    /**
     * Model IDs to fan-out to. All are queried in parallel.
     * Default: ["deepseek-v4-flash", "deepseek-v4-pro", "llama-smart"]
     */
    models: string[];
    /** Model used to synthesize the final answer from all responses. Default: "deepseek-v4-pro" */
    synthesisModelId: string;
    /** Optional custom synthesis prompt override */
    synthesisPrompt?: string;
}

/** Configuration for a single A/B traffic-splitting experiment */
export interface ABExperimentConfig {
    id: string;
    name: string;
    /** Percentage of requests (0–100) routed to the variant arm */
    splitPercent: number;
    controlModelId: string;
    variantModelId: string;
    active: boolean;
}

/** Global A/B testing configuration */
export interface ABConfig {
    experiments: ABExperimentConfig[];
}

export interface PantheonConfig {
    models: ModelConfig[];
    gateway: GatewayConfig;
    routing: RoutingConfig;
    defaultModel?: string;
    sandbox?: SandboxConfig;
    plugins?: PluginsConfig;
    /** Multi-model consensus configuration (v0.8) */
    consensus?: ConsensusConfig;
    /** A/B traffic-splitting configuration (v0.8) */
    ab?: ABConfig;
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