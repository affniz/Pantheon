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
    };
}

export function saveConfig(config: PantheonConfig, global = false): void {
    const dir = global
        ? path.join(os.homedir(), ".pantheon")
        : path.join(process.cwd(), ".pantheon");

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), yaml.dump(config), "utf-8");
}