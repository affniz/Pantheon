import { Hono } from "hono";
import { ModelRegistry, loadConfig, saveConfig } from "@pantheon/core";

export const modelsRouter = new Hono();

/** GET /api/models — list all configured models */
modelsRouter.get("/", (c) => {
    const registry = new ModelRegistry();
    const models = registry.list();
    const defaultModel = registry.getDefault();
    return c.json({ models, defaultModel: defaultModel?.id ?? null });
});

/** PUT /api/models/default — set the default model */
modelsRouter.put("/default", async (c) => {
    const body = await c.req.json<{ id: string }>();
    const { id } = body;
    if (!id) return c.json({ error: "Model ID is required" }, 400);

    const registry = new ModelRegistry();
    const model = registry.get(id);
    if (!model) return c.json({ error: `Model "${id}" not found` }, 404);

    const config = loadConfig();
    config.defaultModel = id;
    saveConfig(config, true); // save to global config

    return c.json({ ok: true, defaultModel: id });
});
