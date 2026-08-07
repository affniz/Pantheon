import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { PantheonConfig } from "@pantheon/shared";

const DEFAULTS: PantheonConfig = {
    models: [
        { id: "llama-fast", provider: "groq", displayName: "Llama 3.1 8B (Fast)" },
        { id: "llama-smart", provider: "groq", displayName: "Llama 3.3 70B (Smart)" },
    ],
    gateway: {
        baseUrl: "http://localhost:4000",
        masterKey: "sk-pantheon-local",
    },
    routing: {
        enabled: true,
        tiers: {
            simple: "llama-fast",
            standard: "llama-fast",
            complex: "llama-smart",
        },
    },
    defaultModel: "llama-smart",
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