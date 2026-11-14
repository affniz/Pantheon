import { Hono } from "hono";
import { SessionManager } from "@pantheon/core";
import { intParam } from "./params.js";

export const sessionsRouter = new Hono();

const sm = new SessionManager();

/** GET /api/sessions — list sessions */
sessionsRouter.get("/", async (c) => {
    const limit = intParam(c.req.query("limit"), 10, 1, 500);
    const offset = intParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const includeArchived = c.req.query("all") === "true";
    const sessions = await sm.list({ limit, offset, includeArchived });
    return c.json({ sessions });
});

/** GET /api/sessions/:id — get session details */
sessionsRouter.get("/:id", async (c) => {
    const session = await sm.get(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ session });
});

/** GET /api/sessions/:id/messages — get messages for a session */
sessionsRouter.get("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!(await sm.exists(id))) return c.json({ error: "Session not found" }, 404);
    const messages = await sm.getMessages(id);
    return c.json({ messages });
});

/** POST /api/sessions/:id/archive — archive a session */
sessionsRouter.post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    if (!(await sm.exists(id))) return c.json({ error: "Session not found" }, 404);
    await sm.archive(id);
    return c.json({ ok: true });
});

/** DELETE /api/sessions/:id — delete a session */
sessionsRouter.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await sm.exists(id))) return c.json({ error: "Session not found" }, 404);
    await sm.delete(id);
    return c.json({ ok: true });
});
