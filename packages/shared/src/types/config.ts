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
    /**
     * Extra request parameters sent with every completion for this model — e.g.
     * `{ thinking: { type: "enabled" }, reasoning_effort: "high" }` for a reasoning
     * model. Provider-specific knobs belong here, not in code.
     */
    extraParams?: Record<string, unknown>;
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
    /**
     * Restrict the experiment to prompts routed to these complexity tiers, e.g.
     * `["simple", "standard"]` to compare two coding models without touching
     * greetings or orchestrated tasks. Omit (or leave empty) to apply to every request.
     */
    tiers?: Array<"general" | "simple" | "standard" | "complex">;
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
    /** Storage backend (v0.9). Omit to use SQLite at ~/.pantheon/pantheon.db. */
    database?: DatabaseConfig;
    /** API authentication (v0.9). Omit for the local single-user default (no auth). */
    auth?: AuthConfig;
    /** Long-term memory settings (v0.9). */
    memory?: MemoryConfig;
}

export interface MemoryConfig {
    /** Retrieval-augmented memory over past conversations. Off unless enabled. */
    semantic?: SemanticMemoryConfig;
}

/**
 * Semantic memory embeds past messages and retrieves the ones most similar to the
 * current prompt. It needs an embedding model in litellm-config.yaml — Groq and
 * DeepSeek do not offer one, so this is opt-in.
 */
export interface SemanticMemoryConfig {
    enabled: boolean;
    /** LiteLLM model name of the embedding model, e.g. "pantheon-embed". */
    embeddingModel: string;
    /** Memories injected per turn. Default 5. */
    topK?: number;
    /** Minimum cosine similarity (0–1) for a memory to be used. Default 0.35. */
    minScore?: number;
}

/** OAuth application credentials for one sign-in provider. */
export interface OAuthProviderConfig {
    clientId: string;
    /** Prefer the PANTHEON_<PROVIDER>_CLIENT_SECRET environment variable over this field. */
    clientSecret?: string;
}

/**
 * Who may call the API.
 *
 * `off` (default) suits the local single-user setup, where the server only listens
 * on localhost. Set `required` before exposing the server on a network: every
 * request must then carry an API token or a signed-in session.
 * Environment variables override this block (see README → Authentication).
 */
export interface AuthConfig {
    mode?: "off" | "required";
    /**
     * E-mail addresses allowed to sign in, besides the owner and existing users.
     * Empty (default): only the first person to sign in — who becomes the owner — gets in.
     * `["*"]` lets anyone with an account at a configured provider in.
     */
    allowedEmails?: string[];
    /** Public base URL of the server, used to build OAuth redirect URIs. */
    publicUrl?: string;
    providers?: {
        github?: OAuthProviderConfig;
        google?: OAuthProviderConfig;
    };
}

/**
 * Where Pantheon stores sessions, traces, usage and orchestration state.
 *
 * Environment variables take precedence over this block: `DATABASE_URL` overrides
 * `url`, and `PANTHEON_DB_PATH` overrides `sqlitePath`.
 */
export interface DatabaseConfig {
    /**
     * Connection URL. `postgres://user:pass@host:5432/db` selects PostgreSQL.
     * Prefer the `DATABASE_URL` environment variable so credentials stay out of config files.
     */
    url?: string;
    /** SQLite file location, used when no PostgreSQL URL is configured. */
    sqlitePath?: string;
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
    /** Where shell commands issued by agents run (v0.9). Default: on the host. */
    execution?: ExecutionConfig;
}

/**
 * Execution backend for the `shell` tool and the reviewer's verification commands.
 *
 * `host` runs them as ordinary processes of the Pantheon server — fine for a
 * single user on their own machine. `docker` runs each command in a throw-away
 * container that can see only the project directory: use it whenever the server
 * is reachable by other people.
 */
export interface ExecutionConfig {
    mode: "host" | "docker";
    /** Container image with the project's toolchain. Default: node:22-slim */
    image?: string;
    /** "none" (default) blocks all network access; "bridge" allows outbound connections. */
    network?: "none" | "bridge";
    /** Memory limit in docker syntax, e.g. "2g". Default: 2g */
    memory?: string;
    /** CPU limit. Default: 2 */
    cpus?: number;
    /** Process limit inside the container. Default: 512 */
    pidsLimit?: number;
    /** Mount the project read-only for shell commands. Default: false */
    readOnlyProject?: boolean;
    /** Path of the docker (or podman) binary. Default: "docker" */
    dockerPath?: string;
}

export interface PluginsConfig {
    /** Directory where plugins are installed. Default: ~/.pantheon/plugins */
    directory: string;
    /** Whether to auto-start MCP servers on boot. Default: false */
    autoStart: boolean;
    /** Keepalive timeout for MCP servers in ms. Default: 300000 (5 min) */
    keepaliveTimeout: number;
}