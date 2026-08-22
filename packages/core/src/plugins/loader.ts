import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LoadedPlugin, PluginManifest } from "./types.js";
import { parseManifest } from "./manifest.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { Sandbox } from "../sandbox/sandbox.js";

/** Default directory where plugins are installed */
export const DEFAULT_PLUGINS_DIR = path.join(os.homedir(), ".pantheon", "plugins");

const MANIFEST_FILENAME = "pantheon-plugin.json";

/**
 * Load a single plugin from a directory.
 * Reads and validates the manifest, then resolves inline tool handlers.
 */
export async function loadPlugin(pluginDir: string, sandbox: Sandbox): Promise<LoadedPlugin> {
    const manifestPath = path.join(pluginDir, MANIFEST_FILENAME);

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`No ${MANIFEST_FILENAME} found in ${pluginDir}`);
    }

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
    const manifest = parseManifest(raw);

    // Validate required env vars are present
    if (manifest.env) {
        const missingVars: string[] = [];
        for (const [key, spec] of Object.entries(manifest.env)) {
            if (spec.required && !process.env[key] && !spec.default) {
                missingVars.push(key);
            }
        }
        if (missingVars.length > 0) {
            process.stderr.write(
                `[plugins] Warning: Plugin "${manifest.name}" is missing required env vars: ${missingVars.join(", ")}\n`
            );
        }
    }

    // Resolve inline tool handlers
    const toolRegistry = new ToolRegistry();
    if (manifest.tools) {
        for (const toolConfig of manifest.tools) {
            try {
                const handlerPath = path.resolve(pluginDir, toolConfig.handler);
                // Dynamic import of the tool handler module
                const handlerModule = await import(handlerPath) as Record<string, unknown>;
                const exportName = toolConfig.exportName ?? "execute";
                const executeFn = handlerModule[exportName];

                if (typeof executeFn !== "function") {
                    throw new Error(`Handler module "${toolConfig.handler}" does not export a function named "${exportName}"`);
                }

                toolRegistry.register({
                    definition: {
                        name: `${namespacePrefix(manifest.name)}${toolConfig.name}`,
                        description: toolConfig.description,
                        parameters: toolConfig.parameters,
                        safety: toolConfig.safety,
                        pluginName: manifest.name,
                    },
                    execute: executeFn as (args: Record<string, unknown>, sandbox: Sandbox) => Promise<string>,
                });
            } catch (error) {
                throw new Error(
                    `Failed to load tool "${toolConfig.name}" from plugin "${manifest.name}": ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    { cause: error }
                );
            }
        }
    }

    return {
        manifest,
        directory: path.resolve(pluginDir),
        status: "active",
        tools: toolRegistry.list(),
    };
}

/**
 * Discover and load all plugins from the plugins directory.
 * Skips plugins that fail to load (logs error, continues).
 */
export async function discoverPlugins(pluginsDir: string, sandbox: Sandbox): Promise<LoadedPlugin[]> {
    if (!fs.existsSync(pluginsDir)) {
        return [];
    }

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    const plugins: LoadedPlugin[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(pluginsDir, entry.name);
        const manifestPath = path.join(pluginDir, MANIFEST_FILENAME);
        if (!fs.existsSync(manifestPath)) continue;

        try {
            const plugin = await loadPlugin(pluginDir, sandbox);
            plugins.push(plugin);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[plugins] Failed to load plugin from ${pluginDir}: ${message}\n`);
            // Add as errored plugin so it shows up in the list
            try {
                const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
                const manifest = raw as Partial<PluginManifest>;
                plugins.push({
                    manifest: { name: manifest.name ?? entry.name, version: manifest.version ?? "unknown", description: manifest.description ?? "" },
                    directory: pluginDir,
                    status: "error",
                    error: message,
                    tools: [],
                });
            } catch {
                // Can't even read manifest — skip entirely
            }
        }
    }

    return plugins;
}

/**
 * Install a plugin from an npm package name or local directory path.
 * - Local paths (starting with . or /) are copied/symlinked into the plugins dir
 * - npm package names are installed via `npm pack` then extracted
 */
export async function installPlugin(source: string, pluginsDir: string): Promise<string> {
    fs.mkdirSync(pluginsDir, { recursive: true });

    const isLocalPath = source.startsWith(".") || source.startsWith("/") || source.startsWith("~");

    if (isLocalPath) {
        return installLocalPlugin(source, pluginsDir);
    }
    return installNpmPlugin(source, pluginsDir);
}

async function installLocalPlugin(sourcePath: string, pluginsDir: string): Promise<string> {
    const resolvedSource = path.resolve(sourcePath.replace(/^~/, os.homedir()));

    if (!fs.existsSync(resolvedSource)) {
        throw new Error(`Plugin directory not found: ${resolvedSource}`);
    }

    const manifestPath = path.join(resolvedSource, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`No ${MANIFEST_FILENAME} found in ${resolvedSource}`);
    }

    // Read the manifest to get the plugin name
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
    const manifest = parseManifest(raw);

    // Create a directory name from the plugin name (sanitize)
    const dirName = manifest.name.replace(/[@/]/g, "").replace(/[^a-z0-9-_.]/gi, "-");
    const targetDir = path.join(pluginsDir, dirName);

    if (fs.existsSync(targetDir)) {
        // Remove existing install
        fs.rmSync(targetDir, { recursive: true, force: true });
    }

    // Copy plugin directory to plugins dir
    fs.cpSync(resolvedSource, targetDir, { recursive: true });
    process.stderr.write(`[plugins] Installed "${manifest.name}" from local path ${resolvedSource}\n`);
    return targetDir;
}

async function installNpmPlugin(packageName: string, pluginsDir: string): Promise<string> {
    // Use child_process to run npm pack
    const { execFileSync } = await import("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-plugin-"));

    try {
        // Pack the npm package into a tarball
        execFileSync("npm", ["pack", packageName, "--pack-destination", tmpDir], {
            stdio: ["ignore", "pipe", "pipe"],
        });

        // Find the tarball
        const tarballs = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length === 0) {
            throw new Error(`npm pack produced no tarball for ${packageName}`);
        }
        const tarball = path.join(tmpDir, tarballs[0]!);

        // Extract to a temp directory, then move to plugins dir
        const extractDir = path.join(tmpDir, "extracted");
        fs.mkdirSync(extractDir);
        execFileSync("tar", ["-xzf", tarball, "-C", extractDir]);

        // npm pack creates a "package" subdirectory
        const packageDir = path.join(extractDir, "package");
        const sourceDir = fs.existsSync(packageDir) ? packageDir : extractDir;

        const manifestPath = path.join(sourceDir, MANIFEST_FILENAME);
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`No ${MANIFEST_FILENAME} found in npm package ${packageName}`);
        }

        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
        const manifest = parseManifest(raw);

        const dirName = manifest.name.replace(/[@/]/g, "").replace(/[^a-z0-9-_.]/gi, "-");
        const targetDir = path.join(pluginsDir, dirName);

        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }

        fs.cpSync(sourceDir, targetDir, { recursive: true });
        process.stderr.write(`[plugins] Installed "${manifest.name}" from npm\n`);
        return targetDir;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/** Uninstall a plugin by name, removing its directory from pluginsDir. */
export function uninstallPlugin(pluginName: string, pluginsDir: string): void {
    if (!fs.existsSync(pluginsDir)) {
        throw new Error(`Plugins directory does not exist: ${pluginsDir}`);
    }

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(pluginsDir, entry.name, MANIFEST_FILENAME);
        if (!fs.existsSync(manifestPath)) continue;

        try {
            const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
            const manifest = raw as Partial<PluginManifest>;
            if (manifest.name === pluginName) {
                fs.rmSync(path.join(pluginsDir, entry.name), { recursive: true, force: true });
                process.stderr.write(`[plugins] Uninstalled "${pluginName}"\n`);
                return;
            }
        } catch {
            // skip unreadable manifests
        }
    }

    throw new Error(`Plugin "${pluginName}" not found in ${pluginsDir}`);
}

/**
 * Convert a plugin name to a tool namespace prefix.
 * e.g. "@pantheon-plugins/github" → "github."
 *      "my-plugin" → "my-plugin."
 */
function namespacePrefix(pluginName: string): string {
    // Strip scope prefix: @scope/name → name
    const basename = pluginName.includes("/") ? pluginName.split("/").pop()! : pluginName;
    return `${basename}.`;
}
