import { Hono } from "hono";
import { getDb } from "@pantheon/core";
import { schema } from "@pantheon/core";

export const agentsRouter = new Hono();

const { agentNodes, taskPlans, subTasks } = schema;

/** GET /api/agents — List agent nodes, optionally filtered by sessionId */
agentsRouter.get("/", (c) => {
    const sessionId = c.req.query("sessionId");
    const limit = Number(c.req.query("limit") ?? "20");
    const db = getDb();

    const all = db.select().from(agentNodes).all();
    const filtered = sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
    const sorted = filtered
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);

    return c.json({ agents: sorted });
});

/** GET /api/agents/:agentId — Get a single agent node by ID */
agentsRouter.get("/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const db = getDb();

    const all = db.select().from(agentNodes).all();
    const agent = all.find((a) => a.agentId === agentId);

    if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
    }

    return c.json({ agent });
});

/** GET /api/agents/:agentId/plan — Get the task plan associated with an agent's session */
agentsRouter.get("/:agentId/plan", (c) => {
    const agentId = c.req.param("agentId");
    const db = getDb();

    const allAgents = db.select().from(agentNodes).all();
    const agent = allAgents.find((a) => a.agentId === agentId);

    if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
    }

    const allPlans = db.select().from(taskPlans).all();
    const plan = allPlans.find((p) => p.sessionId === agent.sessionId);
    if (!plan) {
        return c.json({ error: "No task plan found for this agent's session" }, 404);
    }

    const allTasks = db.select().from(subTasks).all();
    const tasks = allTasks
        .filter((t) => t.planId === plan.planId)
        .map((t) => ({
            ...t,
            dependencies: t.dependencies ? JSON.parse(t.dependencies) as string[] : [],
        }));

    return c.json({ plan: { ...plan, tasks } });
});
