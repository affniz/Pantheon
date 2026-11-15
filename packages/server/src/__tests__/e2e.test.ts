/**
 * End-to-end: the real server, real Gateway (OpenAI SDK over HTTP), real tools,
 * real database — against a scripted stand-in for the LiteLLM endpoint.
 *
 * Unit tests replace the gateway with a mock, which is exactly where several
 * shipped features turned out never to have worked. Here nothing between the HTTP
 * request and the model's wire protocol is faked.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-e2e-"));
const ENV = ["HOME", "PANTHEON_DB_PATH", "DATABASE_URL", "NODE_ENV", "PANTHEON_AUTH", "LITELLM_BASE_URL", "PANTHEON_EMBEDDING_MODEL", "PANTHEON_EXEC"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
process.env["HOME"] = tmpHome;
process.env["PANTHEON_DB_PATH"] = path.join(tmpHome, "e2e.db");
process.env["NODE_ENV"] = "production";

// ── Scripted model server ────────────────────────────────────────────────────

interface LlmRequest {
    model: string;
    stream?: boolean;
    tools?: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
}
type Reply = { content?: string; toolCall?: { id: string; name: string; args: Record<string, unknown> }; status?: number };

const requests: LlmRequest[] = [];
let respond: (req: LlmRequest) => Reply = () => ({ content: "ok" });

const systemOf = (req: LlmRequest) => req.messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n");

const llm = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as LlmRequest;
    requests.push(body);
    const reply = respond(body);

    if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure", type: "invalid_request_error" } }));
        return;
    }

    const toolCalls = reply.toolCall
        ? [{ id: reply.toolCall.id, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } }]
        : undefined;
    const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id: "cmpl", object: "chat.completion", model: body.model,
            choices: [{ index: 0, finish_reason: toolCalls ? "tool_calls" : "stop", message: { role: "assistant", content: reply.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
            usage,
        }));
        return;
    }

    // Streamed the way providers do: text in pieces, a tool call as id+name first
    // and its JSON arguments split across chunks, usage in a final chunk.
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        res.write(`data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
    const text = reply.content ?? "";
    const mid = Math.ceil(text.length / 2);
    if (text) {
        send({ role: "assistant", content: text.slice(0, mid) });
        if (text.slice(mid)) send({ content: text.slice(mid) });
    }
    if (toolCalls) {
        const args = toolCalls[0]!.function.arguments;
        const cut = Math.ceil(args.length / 2);
        send({ tool_calls: [{ index: 0, id: toolCalls[0]!.id, type: "function", function: { name: toolCalls[0]!.function.name, arguments: "" } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, cut) } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] });
    }
    res.write(`data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", model: body.model, choices: [], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
});

await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", () => resolve()));
process.env["LITELLM_BASE_URL"] = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;

const core = await import("@pantheon/core");
const { app } = await import("../app.js");

// ── Client helpers ───────────────────────────────────────────────────────────

let n = 0;
const headers = (json = false) => ({ "x-forwarded-for": `10.3.0.${n++ % 250}`, ...(json ? { "content-type": "application/json" } : {}) });

interface Evt { event: string; data: Record<string, unknown> }

/**
 * Run a chat turn the way the CLI does: read the SSE stream as it arrives and
 * answer permission prompts while the turn is still running.
 */
async function chat(body: Record<string, unknown>, decide: (toolName: string) => "always_allow" | "allow_once" | "deny" = () => "always_allow"): Promise<Evt[]> {
    const res = await app.request("/api/chat", { method: "POST", headers: headers(true), body: JSON.stringify(body) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: Evt[] = [];
    let buffer = "";

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            const evt = { event, data: JSON.parse(data) as Record<string, unknown> };
            events.push(evt);
            if (event === "tool_permission_required") {
                const answer = await app.request("/api/chat/respond", {
                    method: "POST",
                    headers: headers(true),
                    body: JSON.stringify({ toolCallId: evt.data["toolCallId"], decision: decide(String(evt.data["toolName"])) }),
                });
                expect(answer.status).toBe(200);
            }
        }
    }
    return events;
}

const textOf = (events: Evt[]) => events.filter((e) => e.event === "text").map((e) => e.data["content"]).join("");
const sessionOf = (events: Evt[]) => String(events.find((e) => e.event === "done")?.data["sessionId"] ?? "");

/** Script for a single agent: classify, then answer each agent request from a queue. */
function script(tier: string, steps: Reply[]): void {
    const queue = [...steps];
    respond = (req) => {
        const system = systemOf(req);
        if (system.startsWith("You are a task complexity classifier")) return { content: tier };
        if (system.startsWith("Summarize this conversation")) return { content: "A summary." };
        if (system.startsWith("You are a quality judge") || /score/i.test(system) && req.messages.length <= 2 && !req.tools) return { content: "8" };
        return queue.shift() ?? { content: "(script exhausted)" };
    };
}

let project: string;

beforeAll(async () => {
    await core.initDb();
});
beforeEach(() => {
    requests.length = 0;
    project = fs.realpathSync(fs.mkdtempSync(path.join(tmpHome, "project-")));
});
afterAll(async () => {
    await new Promise((r) => setTimeout(r, 50)); // let background summarisation settle
    await core.TraceCollector.flush();
    await core.closeDb();
    await new Promise<void>((resolve) => llm.close(() => resolve()));
    fs.rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

// ─────────────────────────────────────────────────────────────────────────────

describe("end-to-end: single agent", () => {
    it("classifies, calls a tool with the user's approval, streams the answer and stores the whole turn", async () => {
        script("simple 0.9", [
            { content: "I'll create the file.", toolCall: { id: "call_1", name: "write_file", args: { path: "hello.txt", content: "hello from pantheon\n" } } },
            { content: "Created hello.txt with a greeting." },
        ]);
        const events = await chat({ prompt: "create hello.txt with a greeting", workingDir: project });
        const kinds = events.map((e) => e.event);

        // The file really exists — written by the real tool, inside the project
        expect(fs.readFileSync(path.join(project, "hello.txt"), "utf-8")).toBe("hello from pantheon\n");

        // Stream: routing, commentary, the tool call (with a permission prompt), its result, the answer
        expect(events[0]).toMatchObject({ event: "routing", data: { tier: "simple", confidence: 0.9 } });
        expect(kinds).toContain("tool_permission_required");
        expect(events.find((e) => e.event === "tool_call")!.data).toMatchObject({ name: "write_file", safety: "destructive", arguments: { path: "hello.txt" } });
        expect(events.find((e) => e.event === "tool_result")!.data).toMatchObject({ isError: false });
        expect(kinds.at(-1)).toBe("done");
        expect(kinds).not.toContain("error");

        // Text arrived incrementally (several deltas), and nothing was sent twice
        expect(events.filter((e) => e.event === "text").length).toBeGreaterThan(2);
        expect(textOf(events)).toBe("I'll create the file.\n\nCreated hello.txt with a greeting.");

        // The agent's requests were streamed, carried the tools, and the tool call
        // survived being reassembled from fragments
        const agentCalls = requests.filter((r) => r.tools && r.tools.length > 0);
        expect(agentCalls).toHaveLength(2);
        expect(agentCalls.every((r) => r.stream === true)).toBe(true);
        expect(agentCalls[0]!.tools!.map((t) => t.function.name)).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "shell", "grep"]));
        const second = agentCalls[1]!.messages;
        expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1", function: { name: "write_file" } }] });
        expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
        expect(String(second.at(-1)!.content)).toContain("Successfully wrote");

        // Stored: user prompt, assistant tool call, tool result, final answer
        const sessionId = sessionOf(events);
        const stored = await new core.SessionManager().getMessages(sessionId);
        expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(stored[1]!.toolCalls?.[0]).toMatchObject({ id: "call_1", name: "write_file" });
        expect(stored[2]!.toolCallId).toBe("call_1");
        expect(stored[3]!.content).toBe("Created hello.txt with a greeting.");

        // Usage is recorded against the session; the turn is traced
        const cost = await new core.CostTracker().getSummary(sessionId);
        expect(cost.totalCalls).toBeGreaterThanOrEqual(3); // classifier + 2 agent calls
        expect(cost.totalInputTokens).toBeGreaterThan(0);
        await core.TraceCollector.flush();
        const traces = await new core.TraceStore().listTraces(5);
        expect(traces.some((t) => t.sessionId === sessionId && t.spanCount >= 3)).toBe(true);
    });

    it("a follow-up turn replays the earlier tool call and result to the model", async () => {
        script("simple", [
            { toolCall: { id: "call_a", name: "write_file", args: { path: "notes.md", content: "# Notes\n" } } },
            { content: "Wrote notes.md." },
        ]);
        const sessionId = sessionOf(await chat({ prompt: "start a notes file", workingDir: project }));

        requests.length = 0;
        script("simple", [{ content: "It contains a single heading." }]);
        const events = await chat({ prompt: "what did you put in it?", workingDir: project, sessionId });
        expect(textOf(events)).toBe("It contains a single heading.");

        const followUp = requests.find((r) => r.tools && r.tools.length > 0)!.messages;
        const roles = followUp.map((m) => m.role);
        expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
        expect(followUp[2]!.tool_calls?.[0]).toMatchObject({ id: "call_a", function: { name: "write_file" } });
        expect(JSON.parse(followUp[2]!.tool_calls![0]!.function.arguments)).toEqual({ path: "notes.md", content: "# Notes\n" });
        expect(followUp[3]).toMatchObject({ role: "tool", tool_call_id: "call_a" });
        expect(followUp[5]!.content).toBe("what did you put in it?");
    });

    it("a denied tool call is reported to the model and nothing is written", async () => {
        script("simple", [
            { toolCall: { id: "call_x", name: "write_file", args: { path: "unwanted.txt", content: "x" } } },
            { content: "Understood — I did not create the file." },
        ]);
        const events = await chat({ prompt: "make a file", workingDir: project }, () => "deny");

        expect(fs.existsSync(path.join(project, "unwanted.txt"))).toBe(false);
        expect(events.find((e) => e.event === "tool_result")!.data["isError"]).toBe(true);
        expect(textOf(events)).toContain("did not create the file");
        const toldModel = requests.filter((r) => r.tools).at(-1)!.messages.at(-1)!;
        expect(toldModel.role).toBe("tool");
        expect(String(toldModel.content)).toMatch(/denied/i);
    });

    it("the sandbox holds end-to-end: escapes are refused and reported back to the model", async () => {
        script("simple", [
            { toolCall: { id: "c1", name: "read_file", args: { path: "/etc/passwd" } } },
            { toolCall: { id: "c2", name: "grep", args: { pattern: "root", path: "/etc" } } },
            { toolCall: { id: "c3", name: "shell", args: { command: "ls; cat /etc/passwd" } } },
            { content: "I cannot access files outside the project." },
        ]);
        const events = await chat({ prompt: "show me /etc/passwd", workingDir: project });

        const results = events.filter((e) => e.event === "tool_result").map((e) => e.data);
        expect(results).toHaveLength(3);
        expect(results.every((r) => r["isError"] === true)).toBe(true);
        expect(JSON.stringify(results)).not.toContain("root:x:");
        expect(String(results[2]!["content"])).toMatch(/outside the project root/);
    });

    it("pure small talk is answered without a classifier call", async () => {
        script("complex", [{ content: "Hello! How can I help?" }]);
        const events = await chat({ prompt: "hi!", workingDir: project });
        expect(events[0]).toMatchObject({ event: "routing", data: { tier: "general" } });
        expect(requests.some((r) => systemOf(r).startsWith("You are a task complexity classifier"))).toBe(false);
        expect(textOf(events)).toBe("Hello! How can I help?");
    });

    it("an unreachable classifier does not fail the request", async () => {
        const queue: Reply[] = [{ content: "Here is the refactor." }];
        respond = (req) => (systemOf(req).startsWith("You are a task complexity classifier") ? { status: 400 } : queue.shift() ?? { content: "?" });
        const events = await chat({ prompt: "refactor the config loader to be async", workingDir: project, orchestrate: false });
        expect(events[0]).toMatchObject({ event: "routing", data: { tier: "standard" } });
        expect(String(events[0]!.data["reason"])).toContain("classifier unavailable");
        expect(textOf(events)).toBe("Here is the refactor.");
    });

    it("a failing model produces an error event, not a hung or empty stream", async () => {
        respond = () => ({ status: 400 });
        const events = await chat({ prompt: "refactor the config loader", workingDir: project, model: "deepseek-v4-flash" });
        expect(events.at(-1)!.event).toBe("error");
        expect(String(events.at(-1)!.data["message"])).toMatch(/scripted failure|400/);
    }, 20_000);

    it("--no-tools streams a plain answer and skips tool messages from earlier turns", async () => {
        script("simple", [
            { toolCall: { id: "call_n", name: "write_file", args: { path: "n.txt", content: "n" } } },
            { content: "Done." },
        ]);
        const sessionId = sessionOf(await chat({ prompt: "write n.txt", workingDir: project }));

        requests.length = 0;
        script("general", [{ content: "Just chatting." }]);
        const events = await chat({ prompt: "and now just talk", noTools: true, sessionId, workingDir: project });
        expect(textOf(events)).toBe("Just chatting.");

        const plain = requests.at(-1)!;
        expect(plain.tools).toBeUndefined();
        // No tool-role or empty tool-call messages reach a request that has no tools
        // (a leading system message carries memory of earlier sessions)
        expect(plain.messages.filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        expect(plain.messages.every((m) => typeof m.content === "string" && m.content.trim() !== "")).toBe(true);
    });
});

describe("end-to-end: orchestration", () => {
    function orchestrationScript(opts: { plan: Array<Record<string, unknown>>; specialist: Reply[]; review: string }) {
        const queue = [...opts.specialist];
        respond = (req) => {
            const system = systemOf(req);
            if (system.startsWith("You are a task complexity classifier")) return { content: "complex 0.9" };
            if (system.startsWith("You are a Planner agent")) return { content: JSON.stringify(opts.plan) };
            if (system.startsWith("You are a reviewer agent")) return { content: opts.review };
            if (system.startsWith("Summarize this conversation")) return { content: "A summary." };
            return queue.shift() ?? { content: "sub-task done" };
        };
    }

    it("plans, runs a specialist that edits the project, verifies, and streams the review", async () => {
        orchestrationScript({
            plan: [{ id: "task-1", title: "Add the module", description: "Create src/math.ts", dependencies: [], taskRole: "code" }],
            specialist: [
                { toolCall: { id: "w1", name: "write_file", args: { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b;\n" } } },
                { content: "Added src/math.ts with an add function." },
            ],
            review: "The math module is in place with an add function.",
        });
        const events = await chat({ prompt: "add a math module", workingDir: project, orchestrate: true });
        const kinds = events.map((e) => e.event);

        expect(fs.readFileSync(path.join(project, "src/math.ts"), "utf-8")).toContain("export const add");
        for (const expected of ["plan_created", "orchestration_start", "agent_spawned", "agent_completed", "verification", "review_result", "orchestration_done", "done"]) {
            expect(kinds, expected).toContain(expected);
        }
        expect(kinds).not.toContain("error");
        expect(kinds.indexOf("plan_created")).toBeLessThan(kinds.indexOf("agent_spawned"));
        expect(kinds.indexOf("verification")).toBeLessThan(kinds.indexOf("review_result"));

        // The review is streamed once, not streamed and then repeated
        expect(textOf(events)).toBe("The math module is in place with an add function.");
        expect(events.find((e) => e.event === "done")!.data).toMatchObject({ orchestrated: true, verified: true, fixRounds: 0 });

        // The specialist was a coder, told about its task, with the real tool set
        const specialist = requests.find((r) => systemOf(r).includes("You are a Coder agent"))!;
        expect(systemOf(specialist)).toContain("Title: Add the module");
        expect(specialist.tools!.map((t) => t.function.name)).toContain("write_file");

        // Persisted: the plan with its completed sub-task, and the agent tree
        const sessionId = sessionOf(events);
        const agents = await new core.OrchestrationStore().listAgents({ sessionId });
        expect(agents.map((a) => a.role).sort()).toEqual(["coder", "orchestrator", "planner", "reviewer"]);
        expect(agents.every((a) => a.status === "completed")).toBe(true);
        const root = agents.find((a) => a.role === "orchestrator")!;
        const plan = await new core.OrchestrationStore().getPlanForAgent(root);
        expect((await new core.OrchestrationStore().getSubTasks(plan!.planId)).map((t) => [t.title, t.status])).toEqual([["Add the module", "completed"]]);
        expect((await new core.SessionManager().getMessages(sessionId)).at(-1)!.content).toBe("The math module is in place with an add function.");
    });

    it("repairs a change that breaks the project's own checks", async () => {
        // A real project with a real check: `pnpm test` runs a node script
        fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node check.js" } }));
        fs.writeFileSync(path.join(project, "value.txt"), "42");
        fs.writeFileSync(path.join(project, "check.js"), "process.exit(require('fs').readFileSync('value.txt','utf8').trim()==='42'?0:1)\n");

        orchestrationScript({
            plan: [{ id: "task-1", title: "Change the value", description: "Rewrite value.txt", dependencies: [], taskRole: "code" }],
            specialist: [
                { toolCall: { id: "w1", name: "write_file", args: { path: "value.txt", content: "41" } } },   // breaks the check
                { content: "Changed the value." },
                { toolCall: { id: "w2", name: "write_file", args: { path: "value.txt", content: "42" } } },   // the fix agent repairs it
                { content: "Restored the value the check expects." },
            ],
            review: "Done; a regression was caught and fixed.",
        });
        const events = await chat({ prompt: "change the value", workingDir: project, orchestrate: true });

        const verifications = events.filter((e) => e.event === "verification").map((e) => [e.data["round"], e.data["passed"]]);
        expect(verifications).toEqual([[0, false], [1, true]]);
        expect(fs.readFileSync(path.join(project, "value.txt"), "utf-8")).toBe("42");
        expect(events.find((e) => e.event === "done")!.data).toMatchObject({ verified: true, fixRounds: 1 });

        const fixer = requests.find((r) => systemOf(r).includes("Fix verification failures (round 1)"))!;
        expect(systemOf(fixer)).toContain("You are a Debugger agent");
        expect(systemOf(fixer)).toContain("Test suite FAILED");
    }, 60_000);
});
