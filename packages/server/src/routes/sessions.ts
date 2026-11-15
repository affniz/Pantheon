import { Hono } from "hono";
import { SessionManager } from "@pantheon/core";
import { intParam } from "./params.js";
import { scopeUserId } from "../middleware/auth.js";
import type { Context } from "hono";

export const sessionsRouter = new Hono();

const sm = new SessionManager();

/**
 * True when the session exists and the caller may use it. With auth required, a
 * session owned by someone else is reported as "not found" rather than
 * "forbidden", so ids cannot be probed.
 */
async function canAccess(c: Context, id: string): Promise<boolean> {
    const userId = scopeUserId(c);
    return userId ? sm.isAccessibleBy(id, userId) : sm.exists(id);
}

/** GET /api/sessions — list sessions */
sessionsRouter.get("/", async (c) => {
    const limit = intParam(c.req.query("limit"), 10, 1, 500);
    const offset = intParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const includeArchived = c.req.query("all") === "true";
    const sessions = await sm.list({ limit, offset, includeArchived, userId: scopeUserId(c) });
    return c.json({ sessions });
});

/** GET /api/sessions/:id — get session details */
sessionsRouter.get("/:id", async (c) => {
    const id = c.req.param("id");
    const session = (await canAccess(c, id)) ? await sm.get(id) : undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ session });
});

/** GET /api/sessions/:id/messages — get messages for a session */
sessionsRouter.get("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!(await canAccess(c, id))) return c.json({ error: "Session not found" }, 404);
    const messages = await sm.getMessages(id);
    return c.json({ messages });
});

/** POST /api/sessions/:id/archive — archive a session */
sessionsRouter.post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    if (!(await canAccess(c, id))) return c.json({ error: "Session not found" }, 404);
    await sm.archive(id);
    return c.json({ ok: true });
});

/** DELETE /api/sessions/:id — delete a session */
sessionsRouter.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await canAccess(c, id))) return c.json({ error: "Session not found" }, 404);
    await sm.delete(id);
    return c.json({ ok: true });
});
