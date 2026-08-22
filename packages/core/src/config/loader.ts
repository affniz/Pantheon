import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { PantheonConfig } from "@pantheon/shared";

const DEFAULTS: PantheonConfig = {
    models: [
        { id: "llama-smart", provider: "groq", displayName: "Llama 3.3 70B (Smart)" },
        { id: "deepseek-v4-flash", provider: "deepseek", displayName: "DeepSeek V4 Flash" },
        { id: "deepseek-v4-pro", provider: "deepseek", displayName: "DeepSeek V4 Pro" },
    ],
    gateway: {
        baseUrl: process.env["LITELLM_BASE_URL"] ?? "http://localhost:4000",
        masterKey: process.env["LITELLM_MASTER_KEY"] ?? "sk-pantheon-local",
    },
    routing: {
        enabled: true,
        tiers: {
            general:  "llama-smart",       // greetings, general Q&A
            simple:   "deepseek-v4-flash", // simple & moderate coding
            standard: "deepseek-v4-flash", // multi-step moderate tasks
            complex:  "deepseek-v4-pro",   // complex coding, debugging, architecture
        },
        routingContextDepth: 5,
    },
    defaultModel: "deepseek-v4-flash",
    sandbox: {
        allowlistEnabled: true,
        additionalAllowlist: [],
        denyFromDefault: [],
    } satisfies import("@pantheon/shared").SandboxConfig,
    plugins: {
        directory: path.join(os.homedir(), ".pantheon", "plugins"),
        autoStart: false,
        keepaliveTimeout: 300_000,
    } satisfies import("@pantheon/shared").PluginsConfig,
};

function findConfigPath(): string | null {
    // Check project-local first, then global
    const local = path.join(process.cwd(), ".pantheon", "config.yml");
    const global_ = path.join(os.homedir(), ".pantheon", "config.yml");

    if (fs.existsSync(local)) return local;
    if (fs.existsSync(global_)) return global_;
    return null;
}

export function loadConfig(): PantheonConfig {
    const configPath = findConfigPath();

    if (!configPath) {
        return DEFAULTS;
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.load(raw) as Partial<PantheonConfig>;

    return {
        ...DEFAULTS,
        ...parsed,
        gateway: { ...DEFAULTS.gateway, ...parsed.gateway },
        routing: {
            ...DEFAULTS.routing,
            ...parsed.routing,
            tiers: { ...DEFAULTS.routing.tiers, ...parsed.routing?.tiers },
        },
        sandbox: {
            allowlistEnabled: parsed.sandbox?.allowlistEnabled ?? true,
            additionalAllowlist: parsed.sandbox?.additionalAllowlist ?? [],
            denyFromDefault: parsed.sandbox?.denyFromDefault ?? [],
        },
        plugins: {
            directory: parsed.plugins?.directory ?? path.join(os.homedir(), ".pantheon", "plugins"),
            autoStart: parsed.plugins?.autoStart ?? false,
            keepaliveTimeout: parsed.plugins?.keepaliveTimeout ?? 300_000,
        },
    };
}

export function saveConfig(config: PantheonConfig, global = false): void {
    const dir = global
        ? path.join(os.homedir(), ".pantheon")
        : path.join(process.cwd(), ".pantheon");

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), yaml.dump(config), "utf-8");
}

// ─── Capabilities ─────────────────────────────────────────────────────────────

export interface PantheonCapabilities {
    /** GROQ_API_KEY is set — routing classifier and general Q&A available */
    routingEnabled: boolean;
    /** DEEPSEEK_API_KEY is set — coding agents and orchestration available */
    orchestrationEnabled: boolean;
    /** ANTHROPIC_API_KEY is set — Claude fallback available */
    anthropicFallbackEnabled: boolean;
    /** OPENAI_API_KEY is set — GPT-4o fallback available */
    openaiFallbackEnabled: boolean;
    /** Keys that are missing and affect functionality */
    missingKeys: string[];
    /** Keys that are set */
    presentKeys: string[];
}

/**
 * Inspect environment variables and return what Pantheon features are available.
 * Does NOT make any network calls — purely env-based.
 */
export function getCapabilities(): PantheonCapabilities {
    const groqKey = process.env["GROQ_API_KEY"];
    const deepseekKey = process.env["DEEPSEEK_API_KEY"];
    const anthropicKey = process.env["ANTHROPIC_API_KEY"];
    const openaiKey = process.env["OPENAI_API_KEY"];

    const missingKeys: string[] = [];
    const presentKeys: string[] = [];

    if (groqKey) presentKeys.push("GROQ_API_KEY");
    else missingKeys.push("GROQ_API_KEY");

    if (deepseekKey) presentKeys.push("DEEPSEEK_API_KEY");
    else missingKeys.push("DEEPSEEK_API_KEY");

    if (anthropicKey) presentKeys.push("ANTHROPIC_API_KEY");
    if (openaiKey) presentKeys.push("OPENAI_API_KEY");

    return {
        routingEnabled: Boolean(groqKey),
        orchestrationEnabled: Boolean(deepseekKey),
        anthropicFallbackEnabled: Boolean(anthropicKey),
        openaiFallbackEnabled: Boolean(openaiKey),
        missingKeys,
        presentKeys,
    };
}