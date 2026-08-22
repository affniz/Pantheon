import { Hono } from "hono";
import {
    loadConfig,
    PluginRegistry,
    installPlugin,
    uninstallPlugin,
    DEFAULT_PLUGINS_DIR,
    Sandbox,
    ToolRegistry,
} from "@pantheon/core";
import type { PluginInfo } from "@pantheon/core";

export const pluginsRouter = new Hono();

function getPluginsDir(): string {
    const config = loadConfig();
    return config.plugins?.directory ?? DEFAULT_PLUGINS_DIR;
}

/**
 * GET /api/plugins
 * List all installed plugins with their status and tool counts.
 */
pluginsRouter.get("/", async (c) => {
    const pluginsDir = getPluginsDir();
    const workingDir = process.env["PANTHEON_WORKSPACE"] ?? process.cwd();
    const sandbox = Sandbox.create(workingDir);
    const toolRegistry = new ToolRegistry();
    const registry = new PluginRegistry(toolRegistry, pluginsDir);

    try {
        await registry.loadFromDirectory(sandbox);
        return c.json({ plugins: registry.list(), directory: pluginsDir });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 500);
    }
});

/**
 * GET /api/plugins/:name
 * Get details for a specific plugin.
 */
pluginsRouter.get("/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const pluginsDir = getPluginsDir();
    const workingDir = process.env["PANTHEON_WORKSPACE"] ?? process.cwd();
    const sandbox = Sandbox.create(workingDir);
    const toolRegistry = new ToolRegistry();
    const registry = new PluginRegistry(toolRegistry, pluginsDir);

    try {
        await registry.loadFromDirectory(sandbox);
        const plugin = registry.get(name);
        if (!plugin) {
            return c.json({ error: `Plugin "${name}" not found` }, 404);
        }
        return c.json({
            info: registry.list().find((p) => p.name === name),
            tools: plugin.tools.map((t) => t.definition),
            directory: plugin.directory,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 500);
    }
});

/**
 * POST /api/plugins/install
 * Install a plugin from a local path or npm package.
 * Body: { source: string }
 */
pluginsRouter.post("/install", async (c) => {
    const body = await c.req.json<{ source: string }>();
    const { source } = body;

    if (!source?.trim()) {
        return c.json({ error: "source is required" }, 400);
    }

    const pluginsDir = getPluginsDir();

    try {
        const pluginDir = await installPlugin(source, pluginsDir);
        return c.json({ ok: true, directory: pluginDir });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 500);
    }
});

/**
 * POST /api/plugins/:name/remove
 * Uninstall a plugin by name.
 */
pluginsRouter.post("/:name/remove", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const pluginsDir = getPluginsDir();

    try {
        uninstallPlugin(name, pluginsDir);
        return c.json({ ok: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 500);
    }
});
