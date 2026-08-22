import chalk from "chalk";
import { ensureServerRunning, getServerUrl } from "../server-manager.js";

const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");
const dim = chalk.hex("#6B7280");
const success = chalk.hex("#98C379");
const error = chalk.hex("#E06C75");
const warning = chalk.hex("#E5C07B");

async function pluginsFetch(path: string, options?: RequestInit): Promise<unknown> {
    await ensureServerRunning();
    const url = `${getServerUrl()}/api/plugins${path}`;
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options,
    });
    if (!response.ok && response.status !== 404) {
        const body = await response.text().catch(() => "");
        throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
    }
    return response.json();
}

/**
 * pantheon plugins list
 * Lists all installed plugins with their status and tool counts.
 */
export async function pluginsList(): Promise<void> {
    try {
        const data = await pluginsFetch("/") as { plugins: PluginInfo[]; directory: string };
        const { plugins, directory } = data;

        console.log("");
        console.log(`  ${brand.bold("Installed Plugins")} ${dim(`(${directory})`)}`);
        console.log(`  ${dim("─".repeat(60))}`);
        console.log("");

        if (plugins.length === 0) {
            console.log(`  ${dim("No plugins installed.")}`);
            console.log("");
            console.log(`  ${dim("Install a plugin with:")} ${accent("pantheon plugins install <source>")}`);
        } else {
            for (const plugin of plugins) {
                const statusIcon = plugin.status === "active" ? success("●") : plugin.status === "error" ? error("●") : dim("○");
                const toolStr = plugin.toolCount === 1 ? "1 tool" : `${plugin.toolCount} tools`;
                const transportStr = plugin.transport ? dim(` [${plugin.transport}]`) : "";
                console.log(`  ${statusIcon} ${chalk.white.bold(plugin.name)} ${dim("v" + plugin.version)}${transportStr}`);
                console.log(`     ${dim(plugin.description)}`);
                console.log(`     ${accent(toolStr)}`);
                if (plugin.error) {
                    console.log(`     ${error("Error: " + plugin.error)}`);
                }
                console.log("");
            }
        }
    } catch (err) {
        console.error(error(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
    }
}

interface PluginInfo {
    name: string;
    version: string;
    description: string;
    status: string;
    toolCount: number;
    transport?: string;
    directory: string;
    error?: string;
}

interface PluginDetail {
    info?: PluginInfo;
    tools?: Array<{ name: string; description: string; safety: string; pluginName?: string }>;
    directory?: string;
    error?: string;
}

/**
 * pantheon plugins install <source>
 * Installs a plugin from a local path or npm package.
 */
export async function pluginsInstall(source: string): Promise<void> {
    console.log("");
    console.log(`  ${dim("Installing plugin from:")} ${accent(source)}`);
    console.log("");

    try {
        const data = await pluginsFetch("/install", {
            method: "POST",
            body: JSON.stringify({ source }),
        }) as { ok: boolean; directory: string; error?: string };

        if (data.error) {
            throw new Error(data.error);
        }

        console.log(`  ${success("✓")} Plugin installed successfully`);
        console.log(`  ${dim("Directory:")} ${data.directory}`);
        console.log("");
        console.log(`  Run ${accent("pantheon plugins list")} to see installed plugins.`);
        console.log("");
    } catch (err) {
        console.error(`  ${error("✗")} Installation failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}

/**
 * pantheon plugins remove <name>
 * Uninstalls a plugin by name.
 */
export async function pluginsRemove(name: string): Promise<void> {
    console.log("");
    console.log(`  ${dim("Removing plugin:")} ${chalk.white(name)}`);
    console.log("");

    try {
        const data = await pluginsFetch(`/${encodeURIComponent(name)}/remove`, {
            method: "POST",
        }) as { ok: boolean; error?: string };

        if (data.error) {
            throw new Error(data.error);
        }

        console.log(`  ${success("✓")} Plugin "${name}" removed.`);
        console.log("");
    } catch (err) {
        console.error(`  ${error("✗")} Failed to remove plugin: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}

/**
 * pantheon plugins info <name>
 * Shows detailed info about a specific plugin.
 */
export async function pluginsInfo(name: string): Promise<void> {
    try {
        const data = await pluginsFetch(`/${encodeURIComponent(name)}`) as PluginDetail;

        if (data.error) {
            console.error(`  ${error("✗")} ${data.error}`);
            process.exit(1);
        }

        const { info, tools, directory } = data;
        if (!info) {
            console.error(`  ${error("✗")} Plugin not found`);
            process.exit(1);
        }

        console.log("");
        console.log(`  ${brand.bold(info.name)} ${dim("v" + info.version)}`);
        console.log(`  ${dim(info.description)}`);
        console.log(`  ${dim("Status:")} ${info.status === "active" ? success("active") : error(info.status)}`);
        console.log(`  ${dim("Directory:")} ${directory}`);
        console.log("");

        if (tools && tools.length > 0) {
            console.log(`  ${accent("Available Tools")} ${dim(`(${tools.length})`)}`);
            console.log(`  ${dim("─".repeat(40))}`);
            for (const tool of tools) {
                const safetyLabel = tool.safety === "destructive" ? warning("⚠ destructive") : success("safe");
                console.log(`  ${dim("•")} ${chalk.white(tool.name)} ${safetyLabel}`);
                console.log(`    ${dim(tool.description)}`);
            }
            console.log("");
        } else {
            console.log(`  ${dim("No tools available (MCP tools are discovered at runtime)")}`);
            console.log("");
        }
    } catch (err) {
        console.error(`  ${error("✗")} ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
