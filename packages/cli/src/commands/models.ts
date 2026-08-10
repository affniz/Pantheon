import chalk from "chalk";
import { PantheonApiClient } from "../api-client.js";
import { ensureServerRunning } from "../server-manager.js";

const dim = chalk.hex("#6B7280");
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");

export async function listModels() {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    const { models, defaultModel } = await client.listModels();

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Configured Models")}`);
    console.log(`  ${dim("─".repeat(55))}`);

    for (const m of models) {
        const isDefault = m.id === defaultModel;
        const marker = isDefault ? chalk.green(" ✓ default") : "";
        console.log(`  ${accent(m.id)}${marker}`);
        if (m.displayName) console.log(`    ${dim("Name:")} ${m.displayName}`);
        console.log(`    ${dim("Provider:")} ${m.provider}`);
    }

    console.log(`  ${dim("─".repeat(55))}`);
    console.log("");
}

export async function setDefaultModel(id: string) {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    try {
        await client.setDefaultModel(id);
        console.log(chalk.green(`  ✓ Default model set to "${id}".`));
    } catch (err) {
        console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}

// Stubs for add/remove — not yet backed by API (v0.5 defers model management to config file)
export function addModel(id: string, provider: string, name?: string) {
    console.log(dim(`\n  Model management via CLI is deferred to v0.6.`));
    console.log(dim(`  To add a model, edit ~/.pantheon/config.yml and restart the server.\n`));
}

export function removeModel(id: string) {
    console.log(dim(`\n  Model management via CLI is deferred to v0.6.`));
    console.log(dim(`  To remove a model, edit ~/.pantheon/config.yml and restart the server.\n`));
}