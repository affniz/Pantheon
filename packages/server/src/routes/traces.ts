import { Hono } from "hono";
import { TraceStore } from "@pantheon/core";
import { intParam } from "./params.js";

export const tracesRouter = new Hono();

const store = new TraceStore();

/** GET /api/traces — list recent traces */
tracesRouter.get("/", async (c) => {
    const traces = await store.listTraces(intParam(c.req.query("limit"), 20, 1, 500));
    return c.json({ traces });
});

/** GET /api/traces/:id — get all spans for a trace */
tracesRouter.get("/:id", async (c) => {
    const id = c.req.param("id");
    const spans = await store.getSpans(id);
    if (spans.length === 0) return c.json({ error: "Trace not found" }, 404);
    return c.json({ traceId: id, spans });
});

/** DELETE /api/traces — clear all trace data */
tracesRouter.delete("/", async (c) => {
    await store.clearAll();
    return c.json({ ok: true });
});
