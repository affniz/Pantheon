import { Hono } from "hono";
import { OrchestrationStore } from "@pantheon/core";

export const agentsRouter = new Hono();

const store = new OrchestrationStore();

/** GET /api/agents — List agent nodes, optionally filtered by sessionId */
agentsRouter.get("/", async (c) => {
    const sessionId = c.req.query("sessionId");
    const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? "20") || 20), 500);
    const agents = await store.listAgents({ sessionId, limit });
    return c.json({ agents });
});

/** GET /api/agents/:agentId — Get a single agent node by ID */
agentsRouter.get("/:agentId", async (c) => {
    const agent = await store.getAgent(c.req.param("agentId"));
    if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
    }
    return c.json({ agent });
});

/** GET /api/agents/:agentId/plan — Get the task plan associated with an agent's session */
agentsRouter.get("/:agentId/plan", async (c) => {
    const agent = await store.getAgent(c.req.param("agentId"));
    if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
    }

    const plan = await store.getPlanForAgent(agent);
    if (!plan) {
        return c.json({ error: "No task plan found for this agent's session" }, 404);
    }

    const tasks = await store.getSubTasks(plan.planId);
    return c.json({ plan: { ...plan, tasks } });
});
