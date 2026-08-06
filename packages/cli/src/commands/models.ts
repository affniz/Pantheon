import { ModelRegistry } from "@pantheon/core";

export function listModels() {
    const registry = new ModelRegistry();
    const models = registry.list();

    if (models.length === 0) {
        console.log("No models configured.");
        return;
    }

    console.log("\nConfigured models:\n");
    for (const model of models) {
        console.log(`  • ${model.id} (${model.provider})${model.displayName ? " — " + model.displayName : ""}`);
    }
    console.log("");
}

export function addModel(id: string, provider: string, displayName?: string) {
    const registry = new ModelRegistry();
    registry.add({ id, provider, ...(displayName ? { displayName } : {}) });
    console.log(`✓ Added model "${id}"`);
}

export function removeModel(id: string) {
    const registry = new ModelRegistry();
    registry.remove(id);
    console.log(`✓ Removed model "${id}"`);
}

export function setDefaultModel(id: string) {
    const registry = new ModelRegistry();
    registry.setDefault(id);
    console.log(`✓ Default model set to "${id}"`);
}