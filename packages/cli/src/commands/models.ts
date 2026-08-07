import chalk from "chalk";
import { ModelRegistry } from "@pantheon/core";

// Brand colors matching theme.ts
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");
const dim = chalk.hex("#6B7280");
const muted = chalk.hex("#4B5563");
const success = chalk.hex("#4ADE80");
const border = chalk.hex("#3A3A3A");

const BRAND_MARK = `${brand.bold("◆")} ${brand("Pantheon")}`;
const HR = border("─".repeat(50));

export function listModels() {
    const registry = new ModelRegistry();
    const models = registry.list();
    const defaultModel = registry.getDefault();

    console.log(`\n  ${BRAND_MARK} ${dim("— Models")}\n`);
    console.log(`  ${HR}\n`);

    if (models.length === 0) {
        console.log(`  ${dim("No models configured.")}\n`);
        return;
    }

    for (const model of models) {
        const isDefault = defaultModel?.id === model.id;
        const marker = isDefault ? success("  ✓ default") : "";
        const name = model.displayName
            ? dim(` — ${model.displayName}`)
            : "";

        console.log(`  ${accent("•")} ${chalk.white.bold(model.id)} ${muted(`(${model.provider})`)}${name}${marker}`);
    }

    console.log(`\n  ${HR}\n`);
}

export function addModel(id: string, provider: string, displayName?: string) {
    const registry = new ModelRegistry();
    registry.add({ id, provider, ...(displayName ? { displayName } : {}) });
    console.log(`\n  ${success("✓")} Added model ${accent.bold(id)}\n`);
}

export function removeModel(id: string) {
    const registry = new ModelRegistry();
    registry.remove(id);
    console.log(`\n  ${success("✓")} Removed model ${accent.bold(id)}\n`);
}

export function setDefaultModel(id: string) {
    const registry = new ModelRegistry();
    registry.setDefault(id);
    console.log(`\n  ${success("✓")} Default model set to ${accent.bold(id)}\n`);
}