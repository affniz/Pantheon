import { Hono } from "hono";
import { getDb, schema, desc, eq } from "@pantheon/core";

export const agentsRouter = new Hono();

const { agentNodes, taskPlans, subTasks } = schema;

/** GET /api/agents — List agent nodes, optionally filtered by sessionId */
agentsRouter.get("/", (c) => {
    const sessionId = c.req.query("sessionId");
    const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? "20") || 20), 500);
    const db = getDb();

    const agents = db
        .select()
        .from(agentNodes)
        .where(sessionId ? eq(agentNodes.sessionId, sessionId) : undefined)
        .orderBy(desc(agentNodes.startTime))
        .limit(limit)
        .all();

    return c.json({ agents });
});

/** GET /api/agents/:agentId — Get a single agent node by ID */
agentsRouter.get("/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const db = getDb();

    const agent = db.select().from(agentNodes).where(eq(agentNodes.agentId, agentId)).get();

    if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
    }

    return c.json({ agent });
});

/** GET /api/agents/:agentId/plan — Get the task plan associated with an agent's session */
agentsRouter.get("/:agentId/plan", (c) => {
    const agentId = c.req.param("agentId");
    const db = getDb();

    const agent = db.select().from(agentNodes).where(eq(agentNodes.agentId, agentId)).get();

    if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
    }

    // A session may have been orchestrated more than once — return the plan created
    // most recently before (or at) the time this agent started.
    const plan = db
        .select()
        .from(taskPlans)
        .where(eq(taskPlans.sessionId, agent.sessionId))
        .orderBy(desc(taskPlans.createdAt))
        .all()
        .find((p) => new Date(p.createdAt).getTime() <= agent.startTime + 1000)
        ?? db
            .select()
            .from(taskPlans)
            .where(eq(taskPlans.sessionId, agent.sessionId))
            .orderBy(desc(taskPlans.createdAt))
            .get();

    if (!plan) {
        return c.json({ error: "No task plan found for this agent's session" }, 404);
    }

    const tasks = db
        .select()
        .from(subTasks)
        .where(eq(subTasks.planId, plan.planId))
        .all()
        .map((t) => ({
            ...t,
            dependencies: t.dependencies ? (JSON.parse(t.dependencies) as string[]) : [],
        }));

    return c.json({ plan: { ...plan, tasks } });
});
