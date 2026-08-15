import chalk from "chalk";
import { PantheonApiClient } from "../api-client.js";
import { ensureServerRunning } from "../server-manager.js";

const dim = chalk.hex("#6B7280");
const accent = chalk.hex("#56B6C2");
const brand = chalk.hex("#F5A623");
const muted = chalk.hex("#4B5563");

function timeAgo(isoString: string): string {
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString();
}

function formatDuration(start: string, end?: string): string {
    if (!end) return "-";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatStatus(status: string): string {
    switch (status.toLowerCase()) {
        case "running": return chalk.blue(status);
        case "completed": return chalk.green(status);
        case "failed": return chalk.red(status);
        case "paused": return chalk.yellow(status);
        default: return dim(status);
    }
}

export async function agentsList(opts: { limit?: number }) {
    await ensureServerRunning();
    const client = new PantheonApiClient();
    const limit = opts.limit ?? 20;

    let agents;
    try {
        agents = await client.listAgents({ limit });
    } catch (err) {
        console.error(chalk.red(`  Failed to fetch agents: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }

    if (agents.length === 0) {
        console.log(dim("\n  No agents found.\n"));
        return;
    }

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Recent Agents")}`);
    console.log(`  ${dim("─".repeat(85))}`);
    console.log(
        `  ${dim("ID".padEnd(10))} ${"ROLE".padEnd(15)} ${"STATUS".padEnd(12)} ${"MODEL".padEnd(20)} ${"STARTED".padEnd(12)} DURATION`
    );
    console.log(`  ${dim("─".repeat(85))}`);

    for (const a of agents) {
        const id = accent(a.id.slice(0, 8));
        const role = (a.role || "agent").slice(0, 14).padEnd(15);
        const status = formatStatus(a.status || "unknown").padEnd(12 + (formatStatus(a.status || "unknown").length - (a.status || "unknown").length));
        const model = (a.modelId || "-").slice(0, 19).padEnd(20);
        const started = (a.createdAt ? timeAgo(a.createdAt) : "-").padEnd(12);
        const duration = formatDuration(a.createdAt, a.completedAt || a.updatedAt);
        
        console.log(`  ${id}  ${role} ${status} ${model} ${dim(started)} ${duration}`);
    }

    console.log(`  ${dim("─".repeat(85))}`);
    console.log("");
}

export async function agentsShow(id: string) {
    await ensureServerRunning();
    const client = new PantheonApiClient();

    let agent;
    try {
        agent = await client.getAgent(id);
    } catch (err) {
        console.error(chalk.red(`  Agent "${id}" not found or error fetching details.`));
        process.exit(1);
    }

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Agent Details")}`);
    console.log(`  ${dim("─".repeat(60))}`);
    console.log(`  ${dim("ID:")}        ${accent(agent.id)}`);
    console.log(`  ${dim("Role:")}      ${agent.role || "agent"}`);
    console.log(`  ${dim("Status:")}    ${formatStatus(agent.status || "unknown")}`);
    console.log(`  ${dim("Session:")}   ${agent.sessionId || "-"}`);
    console.log(`  ${dim("Model:")}     ${agent.modelId || "-"}`);
    console.log(`  ${dim("Created:")}   ${agent.createdAt ? new Date(agent.createdAt).toLocaleString() : "-"}`);
    console.log(`  ${dim("Updated:")}   ${agent.updatedAt ? new Date(agent.updatedAt).toLocaleString() : "-"}`);
    console.log(`  ${dim("Duration:")}  ${formatDuration(agent.createdAt, agent.completedAt || agent.updatedAt)}`);

    if (agent.error) {
        console.log(`\n  ${chalk.red.bold("Error:")}`);
        console.log(`  ${chalk.red(agent.error)}`);
    }

    if (agent.result) {
        console.log(`\n  ${dim("Result:")}`);
        const resultPreview = typeof agent.result === "string" 
            ? agent.result 
            : JSON.stringify(agent.result, null, 2);
        
        // Print with indentation
        const lines = resultPreview.split('\n');
        for (const line of lines) {
            console.log(`  ${line}`);
        }
    }

    console.log("");
}

export async function agentsPlan(sessionId: string) {
    await ensureServerRunning();
    const client = new PantheonApiClient();

    let agents;
    try {
        agents = await client.listAgents({ sessionId });
    } catch (err) {
        console.error(chalk.red(`  Failed to fetch agents for session "${sessionId}".`));
        process.exit(1);
    }

    const orchestrators = agents.filter(a => a.role === "orchestrator" || a.role === "planner");
    
    if (orchestrators.length === 0) {
        console.error(chalk.red(`  No orchestrator agent found for session "${sessionId}".`));
        process.exit(1);
    }

    // Default to the most recent orchestrator
    const orchestrator = orchestrators.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    let plan;
    try {
        plan = await client.getAgentPlan(orchestrator.id);
    } catch (err) {
        console.error(chalk.red(`  Failed to fetch plan for agent "${orchestrator.id}".`));
        process.exit(1);
    }

    console.log("");
    console.log(`  ${brand.bold("◆")} ${chalk.white.bold(`Task Plan for Session ${accent(sessionId.slice(0, 8))}`)}`);
    console.log(`  ${dim(`Orchestrator Agent: ${orchestrator.id}`)}`);
    console.log(`  ${dim("─".repeat(80))}`);

    if (!plan || !plan.tasks || plan.tasks.length === 0) {
        console.log(dim("  No tasks found in plan."));
    } else {
        for (const task of plan.tasks) {
            const status = formatStatus(task.status || "pending");
            const taskId = accent(task.id);
            const desc = task.description || "Unknown task";
            
            console.log(`  [${status}] ${taskId}: ${desc}`);
            
            if (task.dependencies && task.dependencies.length > 0) {
                console.log(`    ${dim("Depends on:")} ${task.dependencies.join(", ")}`);
            }
            if (task.result) {
                const resPreview = typeof task.result === "string" 
                    ? task.result.replace(/\n/g, " ").slice(0, 60) + (task.result.length > 60 ? "…" : "")
                    : JSON.stringify(task.result).slice(0, 60) + "...";
                console.log(`    ${dim("Result:")} ${resPreview}`);
            }
        }
    }

    console.log(`  ${dim("─".repeat(80))}`);
    console.log("");
}
