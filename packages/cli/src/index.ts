#!/usr/bin/env node
import { Command } from "commander";
import { chatCommand } from "./commands/chat.js";
import { listModels, addModel, removeModel, setDefaultModel } from "./commands/models.js";

const program = new Command();

program
    .name("pantheon")
    .description("Multi-model AI agent pantheon")
    .version("0.1.0");

program
    .command("chat")
    .description("Start an interactive chat session")
    .option("-m, --model <id>", "Model ID to use")
    .action((opts) => chatCommand(opts.model));

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

program.parse();