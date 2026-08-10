import { Hono } from "hono";
import { TraceStore } from "@pantheon/core";

export const tracesRouter = new Hono();

const store = new TraceStore();

/** GET /api/traces — list recent traces */
tracesRouter.get("/", (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    const traces = store.listTraces(limit);
    return c.json({ traces });
});

/** GET /api/traces/:id — get all spans for a trace */
tracesRouter.get("/:id", (c) => {
    const id = c.req.param("id");
    const spans = store.getSpans(id);
    if (spans.length === 0) return c.json({ error: "Trace not found" }, 404);
    return c.json({ traceId: id, spans });
});

/** DELETE /api/traces — clear all trace data */
tracesRouter.delete("/", (c) => {
    store.clearAll();
    return c.json({ ok: true });
});
