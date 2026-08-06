import type { ModelConfig, PantheonConfig } from "@pantheon/shared";
import { loadConfig, saveConfig } from "../config/loader.js";

export class ModelRegistry {
    private config: PantheonConfig;

    constructor() {
        this.config = loadConfig();
    }

    list(): ModelConfig[] {
        return this.config.models;
    }

    get(id: string): ModelConfig | undefined {
        return this.config.models.find((m) => m.id === id);
    }

    getDefault(): ModelConfig | undefined {
        const defaultId = this.config.defaultModel;
        return defaultId ? this.get(defaultId) : this.config.models[0];
    }

    add(model: ModelConfig): void {
        if (this.get(model.id)) {
            throw new Error(`Model "${model.id}" already exists.`);
        }
        this.config.models.push(model);
        saveConfig(this.config);
    }

    remove(id: string): void {
        const exists = this.get(id);
        if (!exists) throw new Error(`Model "${id}" not found.`);
        this.config.models = this.config.models.filter((m) => m.id !== id);
        saveConfig(this.config);
    }

    setDefault(id: string): void {
        if (!this.get(id)) throw new Error(`Model "${id}" not found.`);
        this.config.defaultModel = id;
        saveConfig(this.config);
    }

    getGatewayConfig() {
        return this.config.gateway;
    }
}