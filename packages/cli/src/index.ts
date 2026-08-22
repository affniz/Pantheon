#!/usr/bin/env node

// Load .env from the project root (or wherever the CLI is invoked from) before
// anything else so API keys like GROQ_API_KEY are in process.env.
try { (process as any).loadEnvFile(); } catch { /* no .env file — that's fine */ }

import { Command } from "commander";
import chalk from "chalk";
import { chatCommand } from "./commands/chat.js";
import { listModels, addModel, removeModel, setDefaultModel } from "./commands/models.js";
import { costSummary, costRecent, costReset } from "./commands/cost.js";
import { sessionsList, sessionsShow, sessionsDelete, sessionsArchive } from "./commands/sessions.js";
import { traceList, traceShow, traceClear } from "./commands/trace.js";
import { agentsList, agentsShow, agentsPlan } from "./commands/agents.js";
import { pluginsList, pluginsInstall, pluginsRemove, pluginsInfo } from "./commands/plugins.js";
import { ensureServerRunning, stopServer, isServerRunning, getServerPid, getServerUrl } from "./server-manager.js";
import { doctorCommand } from "./commands/doctor.js";

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
    console.log(chalk.hex("#6B7280")("                              v0.7.0"));
    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Multi-model AI agent orchestration system")}`);
    console.log(`  ${border("─".repeat(50))}`);
    console.log("");
    console.log(`  ${accent("chat")}                ${dim("Start an agentic chat session (with tools)")}`);
    console.log(`  ${accent("chat --resume")}       ${dim("Resume the last session")}`);
    console.log(`  ${accent("chat --no-tools")}     ${dim("Chat without tool access")}`);
    console.log("");
    console.log(`  ${accent("sessions list")}       ${dim("List recent chat sessions")}`);
    console.log(`  ${accent("sessions show")} ${muted("<id>")}   ${dim("Show session details")}`);
    console.log(`  ${accent("sessions delete")} ${muted("<id>")} ${dim("Delete a session permanently")}`);
    console.log(`  ${accent("sessions archive")} ${muted("<id>")} ${dim("Archive a session")}`);
    console.log("");
    console.log(`  ${accent("agents list")}           ${dim("List recent orchestration runs")}`);
    console.log(`  ${accent("agents show")} ${muted("<id>")}    ${dim("Show agent details")}`);
    console.log(`  ${accent("agents plan")} ${muted("<id>")}    ${dim("Show task plan for a session")}`);
    console.log("");
    console.log(`  ${accent("plugins list")}       ${dim("List installed plugins")}`);
    console.log(`  ${accent("plugins install")} ${muted("<src>")} ${dim("Install a plugin")}`);
    console.log(`  ${accent("plugins remove")} ${muted("<name>")} ${dim("Remove a plugin")}`);
    console.log("");
    console.log(`  ${accent("models list")}         ${dim("List configured models")}`);
    console.log(`  ${accent("models default")} ${muted("<id>")} ${dim("Set the default model")}`);
    console.log("");
    console.log(`  ${accent("cost")}                ${dim("Show usage summary")}`);
    console.log(`  ${accent("cost recent")}         ${dim("Show recent calls")}`);
    console.log(`  ${accent("cost reset")}          ${dim("Clear all usage data")}`);
    console.log("");
    console.log(`  ${accent("trace list")}          ${dim("List recent execution traces")}`);
    console.log(`  ${accent("trace show")} ${muted("<id>")}      ${dim("Show trace waterfall")}`);
    console.log(`  ${accent("trace clear")}         ${dim("Clear all trace data")}`);
    console.log("");
    console.log(`  ${accent("server status")}       ${dim("Check if the API server is running")}`);
    console.log(`  ${accent("server stop")}         ${dim("Stop the background API server")}`);
    console.log("");
    console.log(`  ${accent("doctor")}              ${dim("Check prerequisites and API key health")}`);
    console.log("");
    console.log(`  ${dim("Run")} ${accent("pantheon <command> --help")} ${dim("for more info")}`);
    console.log("");
}

const program = new Command();

program
    .name("pantheon")
    .description("Multi-model AI agent pantheon")
    .version("0.7.0")
    .action(() => {
        showWelcome();
    });

program
    .command("chat")
    .description("Start an interactive chat session")
    .option("-m, --model <id>", "Model ID to use (bypasses auto-routing)")
    .option("--no-tools", "Disable tool use (pure chat mode)")
    .option("-r, --resume [sessionId]", "Resume a previous session")
    .option("--no-save", "Do not save this session")
    .option(
        "--budget <level>",
        "Cost/latency budget: low (no orchestration), medium (default, up to 3 sub-tasks), high (up to 6 sub-tasks)",
        "medium"
    )
    .action((opts) => chatCommand(
        opts.model,
        opts.tools === false ? true : undefined,
        opts.resume,
        opts.save === false ? true : undefined,
        opts.budget as "low" | "medium" | "high",
    ));

// ── Models ────────────────────────────────────────────────────────────────────

const modelsCmd = program.command("models").description("Manage models");

modelsCmd
    .command("list", { isDefault: true })
    .description("List configured models")
    .action(listModels);

modelsCmd
    .command("add")
    .description("Add a model (edit ~/.pantheon/config.yml directly in v0.5)")
    .requiredOption("--id <id>", "Model ID")
    .requiredOption("--provider <provider>", "Provider name")
    .option("--name <name>", "Display name")
    .action((opts) => addModel(opts.id, opts.provider, opts.name));

modelsCmd
    .command("remove")
    .description("Remove a model (edit ~/.pantheon/config.yml directly in v0.5)")
    .argument("<id>", "Model ID to remove")
    .action(removeModel);

modelsCmd
    .command("default")
    .description("Set the default model")
    .argument("<id>", "Model ID to set as default")
    .action(setDefaultModel);

// ── Cost ──────────────────────────────────────────────────────────────────────

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

// ── Sessions ──────────────────────────────────────────────────────────────────

const sessionsCmd = program.command("sessions").description("Manage chat sessions");

sessionsCmd
    .command("list", { isDefault: true })
    .description("List recent sessions")
    .option("-n, --num <n>", "Number of sessions to show", "10")
    .option("-a, --all", "Include archived sessions")
    .action((opts) => sessionsList(opts));

sessionsCmd
    .command("show")
    .description("Show session details")
    .argument("<id>", "Session ID")
    .action(sessionsShow);

sessionsCmd
    .command("delete")
    .description("Delete a session permanently")
    .argument("<id>", "Session ID")
    .action(sessionsDelete);

sessionsCmd
    .command("archive")
    .description("Archive a session")
    .argument("<id>", "Session ID")
    .action(sessionsArchive);

// ── Agents ────────────────────────────────────────────────────────────────────

const agentsCmd = program.command("agents").description("Manage orchestration agents");

agentsCmd
    .command("list", { isDefault: true })
    .description("List recent orchestration runs")
    .option("-n, --limit <n>", "Number of agents to show", "20")
    .action((opts) => agentsList({ limit: Number(opts.limit) }));

agentsCmd
    .command("show")
    .description("Show agent details")
    .argument("<id>", "Agent ID")
    .action(agentsShow);

agentsCmd
    .command("plan")
    .description("Show task plan for a session")
    .argument("<sessionId>", "Session ID")
    .action(agentsPlan);

// ── Plugins ───────────────────────────────────────────────────────────────────

const pluginsCmd = program.command("plugins").description("Manage Pantheon plugins");

pluginsCmd
    .command("list", { isDefault: true })
    .description("List installed plugins")
    .action(pluginsList);

pluginsCmd
    .command("install")
    .description("Install a plugin from a local path or npm package")
    .argument("<source>", "Local directory path or npm package name")
    .action(pluginsInstall);

pluginsCmd
    .command("remove")
    .description("Uninstall a plugin by name")
    .argument("<name>", "Plugin name (e.g. @pantheon-plugins/github)")
    .action(pluginsRemove);

pluginsCmd
    .command("info")
    .description("Show detailed info about a plugin")
    .argument("<name>", "Plugin name")
    .action(pluginsInfo);

// ── Trace ─────────────────────────────────────────────────────────────────────

const traceCmd = program.command("trace").description("View execution traces");

traceCmd
    .command("list", { isDefault: true })
    .description("List recent traces")
    .option("-n, --limit <n>", "Number of traces to show", "20")
    .action((opts) => traceList({ limit: Number(opts.limit) }));

traceCmd
    .command("show")
    .description("Show trace waterfall for a trace ID")
    .argument("<id>", "Trace ID")
    .action(traceShow);

traceCmd
    .command("clear")
    .description("Clear all trace data")
    .action(traceClear);

// ── Server ────────────────────────────────────────────────────────────────────

const serverCmd = program.command("server").description("Manage the Pantheon API server");

serverCmd
    .command("start")
    .description("Start the Pantheon API server in the background")
    .action(async () => {
        try {
            await ensureServerRunning();
            console.log(chalk.green(`  ✓ Pantheon server is running on ${getServerUrl()}`));
        } catch (err) {
            console.error(chalk.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
            process.exit(1);
        }
    });

serverCmd
    .command("stop")
    .description("Stop the background Pantheon API server")
    .action(() => stopServer());

serverCmd
    .command("status")
    .description("Check if the Pantheon API server is running")
    .action(async () => {
        const running = await isServerRunning();
        const pid = getServerPid();
        if (running) {
            console.log(chalk.green(`  ✓ Pantheon server is running on ${getServerUrl()}${pid ? ` (PID ${pid})` : ""}`));
        } else {
            console.log(dim("  Pantheon server is not running. Use `pantheon server start` or `pantheon chat`."));
        }
    });

// ── Doctor ────────────────────────────────────────────────────────────────────

program
    .command("doctor")
    .description("Check prerequisites, API key health, and gateway reachability")
    .action(doctorCommand);

program.parse();