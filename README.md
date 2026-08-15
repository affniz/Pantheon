# ◆ Pantheon

> A self-hosted, multi-model AI orchestration system with intelligent routing, persistent memory, and multi-agent task decomposition.

---

## What is Pantheon?

Pantheon is an orchestration layer for AI models. Rather than locking you into a single model or provider, Pantheon routes your conversations through a unified gateway — letting you switch models with a flag, build towards smarter agent-driven workflows, and remember past conversations across sessions.

---

## v0.6 — Multi-Agent Orchestration + DeepSeek V4 + Context-Aware Routing

Complex tasks are now automatically **decomposed into parallel sub-tasks** executed by a pool of specialized agents. A Planner breaks the work down, specialist Coder/Debugger agents run tasks concurrently (with full tool access), and a Reviewer synthesizes everything into a final response — all streamed live to the CLI.

This version also introduces **DeepSeek V4** as the primary coding model and upgrades routing to be **context-aware** — using the last 5 turns of conversation history when deciding how to classify a request.

### What's new in v0.6

- **Auto-orchestration** — the chat route classifies each prompt. `complex` tasks spin up the full Planner → Agent pool → Reviewer pipeline automatically. Simple and standard prompts use the existing single-agent path unchanged.
- **Context-aware routing** — the classifier now receives the last N user messages (default: 5) alongside the current prompt. `"debug this"` alone may classify as `simple`, but with prior conversation about a complex system it correctly routes as `complex`.
- **New `general` tier** — greetings, small talk, factual Q&A route to `llama-smart` instead of burning DeepSeek quota.
- **DeepSeek V4 Flash** — handles simple and moderate coding tasks (`simple`/`standard` tiers).
- **DeepSeek V4 Pro** — handles complex coding and powers all orchestration agents (Planner, Coder, Debugger, Reviewer).
- **`llama-smart`** — retained for routing classification and general Q&A; `llama-fast` removed entirely.
- **PlannerAgent** — calls `deepseek-v4-pro` to decompose the prompt into 2–6 JSON sub-tasks, each annotated with a `taskRole` (`"code"` / `"debug"` / `"general"`) for specialist dispatch.
- **CoderAgent** — new specialist for code generation, implementation, and modification. Coding-optimised system prompt, 15-iteration budget.
- **DebuggerAgent** — new specialist for root-cause analysis, error diagnosis, and fix generation. Runs tests to verify fixes before returning.
- **ExecutorAgent** — retained as the generic fallback for `"general"` tasks.
- **ReviewerAgent** — synthesizes all agent results into a coherent final response.
- **Role-based dispatch** — the orchestrator reads the planner-assigned `taskRole` and dispatches each sub-task to the correct specialist.
- **Live SSE progress** — the CLI renders the task plan, per-agent start/complete/fail events, and the review result as they happen.
- **Agent tree persistence** — every orchestration run is stored in SQLite (`agent_nodes`, `task_plans`, `sub_tasks`) and queryable from the CLI.
- **`pantheon agents` commands** — inspect past orchestration runs, agent details, and task plans.

### Model strategy

| Model ID | Upstream | Tier | Role |
|:---------|:---------|:-----|:-----|
| `llama-smart` | `groq/llama-3.3-70b-versatile` | `general` | Routing classifier + general Q&A |
| `deepseek-v4-flash` | `deepseek/deepseek-chat-v4-0324` | `simple` / `standard` | Simple & moderate coding tasks |
| `deepseek-v4-pro` | `deepseek/deepseek-reasoner-v4-0324` | `complex` | Complex tasks + all orchestration agents |

### New commands

```bash
pantheon agents list              # list recent orchestration runs
pantheon agents show <agentId>   # show agent node details and result
pantheon agents plan <sessionId> # show task plan + sub-task statuses for a session
```

### How routing works

```
User message + conversation history (last 5 turns)
        │
        ▼
  Classifier (llama-smart, max_tokens=5)
        │
   ┌────┴─────────────────────────────┐
general   simple     standard      complex
   │         │           │             │
llama-   deepseek-   deepseek-    deepseek-
smart    v4-flash    v4-flash     v4-pro
(direct) (single-   (single-     (Orchestrator)
         agent)     agent)
```

### How orchestration looks

```
⚙  Orchestrating with 3 tasks (plan: a1b2c3d4)

📋 Task Plan:
  1. [code]  Implement the new API endpoint
  2. [debug] Fix the failing auth middleware test
  3. [code]  Write integration tests

  ▶ [coder]    started task-1
  ▶ [debugger] started task-2
  ✓ [coder:a1b2]    completed
  ✓ [debugger:c3d4] completed
  ▶ [coder]    started task-3 (depends on task-1)
  ✓ [coder:e5f6]    completed

✅ Review: All 3 tasks completed successfully

[final synthesized response here]
```

---

## v0.5 — Observability & API Server

Every LLM call, tool invocation, and routing decision is now **fully traced**. A lightweight Hono API server replaces direct core imports in the CLI — the CLI is now a thin HTTP client. Rate limiting and Sentry error monitoring are built in from the start.

### What's new in v0.5

- **Pantheon API server** — Hono on `:3000`. All CLI commands go through the API. The server auto-starts in the background on the first `pantheon chat` and persists across terminal sessions.
- **Structured tracing** — Every agent turn, LLM call, routing decision, and tool execution is wrapped in an OpenTelemetry-style span. Spans are persisted to SQLite non-blockingly via `queueMicrotask`.
- **Trace explorer** — Browse and inspect traces from the CLI. The waterfall view shows the full span tree with offsets, durations, and status.
- **Rate limiting** — `hono-rate-limiter`: 100 req/IP/min globally, 15 req/IP/min on the LLM endpoint.
- **Sentry integration** — Error monitoring from day one of network exposure. No-op in local dev if `SENTRY_DSN` is unset.
- **Server lifecycle commands** — `pantheon server start/stop/status`.

### New commands

```bash
pantheon trace list               # list recent execution traces (default: 20)
pantheon trace list --limit 50    # list more
pantheon trace show <id>          # show trace waterfall for a specific trace
pantheon trace clear              # clear all trace data

pantheon server start             # start the API server in the background
pantheon server stop              # stop the background server
pantheon server status            # check if the server is running (shows PID + URL)
```

---

## v0.4 — Memory & Persistence

Sessions are now **automatically saved**. Every conversation is stored in a local SQLite database (`~/.pantheon/pantheon.db`) and can be resumed at any time. Previous conversations are summarized by the LLM and injected as **episodic memory context** into future chats — so Pantheon remembers what you've worked on before.

### What's new in v0.4

- **Session persistence** — Every `pantheon chat` creates a session. Messages are saved after each turn.
- **Resume sessions** — `pantheon chat --resume` picks up where you left off. Pass an ID to resume a specific session.
- **Episodic memory** — Recent session summaries are injected into the system prompt, giving the model context about past conversations.
- **Background summarization** — After 4+ exchanges, a 2–3 sentence summary is generated and stored for future recall.
- **Sessions command** — Browse, inspect, archive, and delete sessions from the CLI.
- **Drizzle ORM** — All database access now goes through Drizzle, making the future Postgres migration (v0.9) a configuration change, not a rewrite.

---

## All Commands

```bash
pantheon                          # branded welcome screen

# Chat
pantheon chat                     # agentic chat — tools enabled, session saved
pantheon chat --resume            # resume the last session
pantheon chat --resume <id>       # resume a specific session
pantheon chat --no-save           # chat without saving
pantheon chat --no-tools          # pure chat mode (no tool access)
pantheon chat --model deepseek-v4-pro  # manual model override

# Sessions
pantheon sessions list            # list recent sessions (default: 10)
pantheon sessions list -n 20      # list more sessions
pantheon sessions list --all      # include archived sessions
pantheon sessions show <id>       # show session details + summary
pantheon sessions delete <id>     # permanently delete (with confirmation)
pantheon sessions archive <id>    # soft-delete a session

# Models
pantheon models list              # list configured models
pantheon models default <id>      # change the default model

# Cost
pantheon cost                     # show total usage summary
pantheon cost recent              # show last 10 calls
pantheon cost reset               # clear usage data

# Agents (v0.6)
pantheon agents list              # list recent orchestration runs
pantheon agents show <agentId>   # show agent node details
pantheon agents plan <sessionId> # show task plan for a session

# Traces (v0.5)
pantheon trace list               # list recent execution traces
pantheon trace show <id>          # show trace waterfall
pantheon trace clear              # clear all trace data

# Server (v0.5)
pantheon server start             # start API server in the background
pantheon server stop              # stop the background server
pantheon server status            # check server status
```

### Chat TUI

Inside `pantheon chat`:

| Key | Action |
|:----|:-------|
| `tab` | Cycle through available models (auto-route → deepseek-v4-flash → deepseek-v4-pro → …) |
| `enter` | Send message |
| `ctrl+c` | Exit |

When the agent calls tools, you'll see inline prompts:

```
  🔧 readFile({ path: "src/index.ts" })
  First use of readFile — [a] allow once  [A] always allow  [n] deny
  ↳ ✓ Done · 42 lines

  🔧 shell({ command: "ls -la" })
  ⚠ Destructive operation — [y] approve  [n] deny
  ↳ ✓ Done · 12 lines
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v9+
- [Docker](https://www.docker.com/)
- A [Groq API key](https://console.groq.com/) (free) — for routing classifier
- A [DeepSeek API key](https://platform.deepseek.com/) — for coding and orchestration

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/affniz/Pantheon.git
cd pantheon

# 2. Install dependencies
pnpm install

# 3. Build all packages
pnpm turbo build

# 4. Link the CLI globally
cd packages/cli && npm link && cd ../..

# 5. Add your API keys
cp .env.example .env
# Edit .env and set GROQ_API_KEY and DEEPSEEK_API_KEY

# 6. Start the model gateway
docker compose up -d

# 7. Start chatting
pantheon chat
```

The Pantheon API server starts automatically in the background on the first `pantheon chat`. You can also start it manually with `pantheon server start`.

---

## Architecture

```
pantheon chat
     │
     ▼
ensureServerRunning()           ← spawns server as detached background process
     │                            writes ~/.pantheon/server-port
     ▼
PantheonApiClient (HTTP)
     │
     │  POST /api/chat  (SSE stream)
     ▼
┌─────────────────────────────────────────┐
│         Hono API Server (:3000)         │
│                                         │
│  ├── sentryMiddleware                   │
│  ├── requestLogger                      │
│  ├── globalRateLimiter  (100/IP/min)    │
│  └── llmRateLimiter     (15/IP/min)     │
└──────────────────┬──────────────────────┘
                   │
     classify complexity (llama-smart)
     with last N conversation turns
                   │
      ┌────────────┼──────────────────┐
   general      simple/standard    complex
      │               │               │
  llama-smart   deepseek-v4-flash  Orchestrator
  (direct)      (single-agent)         │
                                  PlannerAgent (deepseek-v4-pro)
                                       │  decomposes + assigns taskRole
                                       ▼
                              ┌────────────────────┐
                              │   Parallel Agents  │
                              │  (deepseek-v4-pro) │
                              │  ├── CoderAgent    │
                              │  ├── DebuggerAgent │
                              │  └── ExecutorAgent │
                              └────────────────────┘
                                       │
                              ReviewerAgent (deepseek-v4-pro)
                                       │  synthesize
                                       ▼
                             final response (SSE)
```

### Packages

```
packages/
├── shared/   # Shared types: ModelConfig, ChatMessage, Session, SessionSummary,
│             #   ToolCall, ToolResult, UsageRecord, Span, Trace,
│             #   AgentRole, SubTask (+ taskRole), TaskPlan, AgentNode, OrchestrationEvent
├── core/     # ModelRegistry, Gateway, Classifier (context-aware), CostTracker, Sandbox,
│             #   PermissionManager, ToolRegistry, AgentRuntime,
│             #   SessionManager, SessionSummarizer, Drizzle DB layer,
│             #   Tracer, TraceCollector, TraceStore,
│             #   Orchestrator, PlannerAgent, CoderAgent, DebuggerAgent,
│             #   ExecutorAgent, ReviewerAgent,
│             #   built-in tools (readFile, writeFile, listDirectory, shell)
├── server/   # @pantheon/server — Hono API server (:3000)
│             #   routes: /api/chat, /api/sessions, /api/models,
│             #           /api/cost, /api/traces, /api/agents, /api/health
│             #   middleware: rate-limiter, sentry, request-logger
└── cli/      # pantheon binary (Commander + Ink) — thin API client
              #   commands: chat, sessions, models, cost, trace, server, agents
              #   ui: theme, logo, input-box, message, status-bar,
              #       tool-call, tool-permission, trace-waterfall
```

### Database

Pantheon uses **SQLite** (via Drizzle ORM) for local-first persistence. The database lives at `~/.pantheon/pantheon.db` and is created automatically on first run.

| Table | Purpose |
|:------|:--------|
| `sessions` | One row per chat session (title, timestamps, model, archived flag) |
| `messages` | All messages per session (role, content, tool calls, timestamps) |
| `usage_records` | Per-call token usage and cost tracking |
| `session_summaries` | LLM-generated summaries for episodic memory |
| `spans` | Trace spans — one row per LLM call / tool use / routing decision (v0.5) |
| `agent_nodes` | One row per agent (orchestrator/planner/coder/debugger/executor/reviewer) with status, result, timing (v0.6) |
| `task_plans` | Task decomposition plan per orchestrated session (v0.6) |
| `sub_tasks` | Individual sub-tasks within a plan, with dependency graph, taskRole, and execution results (v0.6) |

> **v0.9** will introduce a PostgreSQL migration path — Drizzle makes this a driver swap, not a rewrite.

### Models

Pantheon uses **role-based model assignment** — models are matched to roles, not picked manually.

| ID | Model | Tier | Role |
|:---|:------|:-----|:-----|
| `llama-smart` | Llama 3.3 70B Versatile (Groq) | `general` | Routing classifier, general Q&A |
| `deepseek-v4-flash` | DeepSeek Chat V4 (0324) | `simple` / `standard` | Simple & moderate coding tasks |
| `deepseek-v4-pro` | DeepSeek Reasoner V4 (0324) | `complex` | Complex coding + all orchestration agents |

All models are accessed through the LiteLLM gateway (Docker on `:4000`).

---

## Development

```bash
pnpm turbo build      # build all packages
pnpm turbo dev        # watch mode
pnpm turbo lint       # run ESLint
pnpm vitest run       # run Vitest tests (from monorepo root)
pnpm turbo clean      # remove build artifacts
```

---

## Versions

| Version | What it adds |
|:--------|:-------------|
| **v0.1** | Multi-model CLI, streaming chat, model registry |
| **v0.2** | Intelligent routing, LLM complexity classifier, SQLite cost tracker, polished TUI |
| **v0.3** | Tool use (readFile, writeFile, listDirectory, shell), agent runtime (ReAct loop), sandbox + two-tier permissions, CI pipeline |
| **v0.4** | Session persistence, resume sessions, episodic memory (LLM summaries), `pantheon sessions` command, Drizzle ORM |
| **v0.5** | Hono API server, CLI becomes thin HTTP client, OpenTelemetry-style tracing, `pantheon trace` command, waterfall view, rate limiting, Sentry |
| **v0.6** | Multi-agent orchestration — Planner/Coder/Debugger/Reviewer pipeline; DeepSeek V4 Flash + Pro; context-aware routing (last N turns); `general` tier; role-based sub-task dispatch; `pantheon agents` commands |
