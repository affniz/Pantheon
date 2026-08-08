#!/usr/bin/env node

// Load .env from the project root (or wherever the CLI is invoked from) before
// anything else so API keys like GROQ_API_KEY are in process.env.
try { (process as any).loadEnvFile(); } catch { /* no .env file — that's fine */ }

import { Command } from "commander";
import chalk from "chalk";
import { chatCommand } from "./commands/chat.js";
import { listModels, addModel, removeModel, setDefaultModel } from "./commands/models.js";
import { costSummary, costRecent, costReset } from "./commands/cost.js";

// Brand colors matching theme.ts
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");
const dim = chalk.hex("#6B7280");
const muted = chalk.hex("#4B5563");
const border = chalk.hex("#3A3A3A");

const LOGO = [
    ["  ██████╗  █████╗ ███╗   ██╗████████╗██╗  ██╗███████╗ ██████╗ ███╗   ██╗", "#FFD700"],
    ["  ██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║  ██║██╔════╝██╔═══██╗████╗  ██║", "#F9BD18"],
    ["  ██████╔╝███████║██╔██╗ ██║   ██║   ███████║█████╗  ██║   ██║██╔██╗ ██║", "#F5A623"],
    ["  ██╔═══╝ ██╔══██║██║╚██╗██║   ██║   ██╔══██║██╔══╝  ██║   ██║██║╚██╗██║", "#E49B20"],
    ["  ██║     ██║  ██║██║ ╚████║   ██║   ██║  ██║███████╗╚██████╔╝██║ ╚████║", "#D5911D"],
    ["  ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝", "#C68A1A"],
] as const;

function showWelcome() {
    console.log("");
    for (const [line, color] of LOGO) {
        console.log(chalk.hex(color)(line));
    }
    console.log(`${dim("                              v0.3.0")}`);
    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Multi-model AI agent orchestration system")}`);
    console.log(`  ${border("─".repeat(50))}`);
    console.log("");
    console.log(`  ${accent("chat")}              ${dim("Start an agentic chat session (with tools)")}`);
    console.log(`  ${accent("chat --no-tools")}   ${dim("Chat without tool access")}`);
    console.log(`  ${accent("models list")}       ${dim("List configured models")}`);
    console.log(`  ${accent("models default")} ${muted("<id>")} ${dim("Set the default model")}`);
    console.log(`  ${accent("cost")}              ${dim("Show usage summary")}`);
    console.log(`  ${accent("cost recent")}       ${dim("Show recent calls")}`);
    console.log("");
    console.log(`  ${dim("Run")} ${accent("pantheon <command> --help")} ${dim("for more info")}`);
    console.log("");
}

const program = new Command();

program
    .name("pantheon")
    .description("Multi-model AI agent pantheon")
    .version("0.3.0")
    .action(() => {
        showWelcome();
    });

program
    .command("chat")
    .description("Start an interactive chat session")
    .option("-m, --model <id>", "Model ID to use (bypasses auto-routing)")
    .option("--no-tools", "Disable tool use (pure chat mode)")
    .action((opts) => chatCommand(opts.model, opts.tools === false ? true : undefined));

const modelsCmd = program.command("models").description("Manage models");

modelsCmd
    .command("list")
    .description("List configured models")
    .action(listModels);

modelsCmd
    .command("add")
    .description("Add a model")
    .requiredOption("--id <id>", "Model ID (must match LiteLLM config)")
    .requiredOption("--provider <provider>", "Provider name")
    .option("--name <name>", "Display name")
    .action((opts) => addModel(opts.id, opts.provider, opts.name));

modelsCmd
    .command("remove")
    .description("Remove a model")
    .argument("<id>", "Model ID to remove")
    .action(removeModel);

modelsCmd
    .command("default")
    .description("Set the default model")
    .argument("<id>", "Model ID to set as default")
    .action(setDefaultModel);

const costCmd = program.command("cost").description("View usage and cost stats");

costCmd
    .command("summary", { isDefault: true })
    .description("Show total usage summary (default)")
    .action(costSummary);

costCmd
    .command("recent")
    .description("Show last 10 calls")
    .option("-n, --num <n>", "Number of calls to show", "10")
    .action((opts) => costRecent(Number(opts.num)));

costCmd
    .command("reset")
    .description("Clear all usage data")
    .action(costReset);

program.parse();