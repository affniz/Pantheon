import { Hono } from "hono";
import { SessionManager } from "@pantheon/core";

export const sessionsRouter = new Hono();

const sm = new SessionManager();

/** GET /api/sessions — list sessions */
sessionsRouter.get("/", (c) => {
    const limit = Number(c.req.query("limit") ?? "10");
    const includeArchived = c.req.query("all") === "true";
    const sessions = sm.list({ limit, includeArchived });
    return c.json({ sessions });
});

/** GET /api/sessions/:id — get session details */
sessionsRouter.get("/:id", (c) => {
    const id = c.req.param("id");
    const session = sm.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ session });
});

/** GET /api/sessions/:id/messages — get messages for a session */
sessionsRouter.get("/:id/messages", (c) => {
    const id = c.req.param("id");
    const session = sm.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const messages = sm.getMessages(id);
    return c.json({ messages });
});

/** POST /api/sessions/:id/archive — archive a session */
sessionsRouter.post("/:id/archive", (c) => {
    const id = c.req.param("id");
    const session = sm.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sm.archive(id);
    return c.json({ ok: true });
});

/** DELETE /api/sessions/:id — delete a session */
sessionsRouter.delete("/:id", (c) => {
    const id = c.req.param("id");
    const session = sm.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sm.delete(id);
    return c.json({ ok: true });
});
