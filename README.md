# ◆ Pantheon

> A self-hosted, multi-model AI orchestration system with intelligent routing and persistent memory.

---

## What is Pantheon?

Pantheon is an orchestration layer for AI models. Rather than locking you into a single model or provider, Pantheon routes your conversations through a unified gateway — letting you switch models with a flag, build towards smarter agent-driven workflows, and remember past conversations across sessions.

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
- **CI fix** — Resolved `pnpm/action-setup@v4` version resolution; tests now run from the monorepo root via `pnpm vitest run`.

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
pantheon chat --model llama-fast  # manual model override

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
| `tab` | Cycle through available models (auto-route → llama-fast → llama-smart → …) |
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
- A [Groq API key](https://console.groq.com/) (free)

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/yourname/pantheon.git
cd pantheon

# 2. Install dependencies
pnpm install

# 3. Build all packages
pnpm turbo build

# 4. Link the CLI globally
cd packages/cli && npm link && cd ../..

# 5. Add your API key
echo "GROQ_API_KEY=your_key_here" > .env

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
                   ▼
            AgentRuntime
                   │
     Tracer.startTrace(sessionId)
                   │
       ┌───────────▼────────────┐
       │   span: agent.turn     │
       │                        │
       │  ┌─────────────────┐   │
       │  │ router.classify │   │   ← routing span
       │  └─────────────────┘   │
       │                        │
       │  ┌─────────────────┐   │
       │  │ llm.completion  │   │   ← LLM span (tokens, model)
       │  └─────────────────┘   │
       │                        │
       │  ┌─────────────────┐   │
       │  │ tool.<name>     │   │   ← tool span (args, safety)
       │  └─────────────────┘   │
       └────────────────────────┘
                   │
     TraceCollector.record(span)  ← queueMicrotask → SQLite (non-blocking)
```

### Packages

```
packages/
├── shared/   # Shared types: ModelConfig, ChatMessage, Session, SessionSummary,
│             #   ToolCall, ToolResult, UsageRecord, Span, Trace, etc.
├── core/     # ModelRegistry, Gateway, Classifier, CostTracker, Sandbox,
│             #   PermissionManager, ToolRegistry, AgentRuntime,
│             #   SessionManager, SessionSummarizer, Drizzle DB layer,
│             #   Tracer, TraceCollector, TraceStore,
│             #   built-in tools (readFile, writeFile, listDirectory, shell)
├── server/   # @pantheon/server — Hono API server (:3000)
│             #   routes: /api/chat, /api/sessions, /api/models,
│             #           /api/cost, /api/traces, /api/health
│             #   middleware: rate-limiter, sentry, request-logger
└── cli/      # pantheon binary (Commander + Ink) — thin API client
              #   commands: chat, sessions, models, cost, trace, server
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

> **v0.9** will introduce a PostgreSQL migration path — Drizzle makes this a driver swap, not a rewrite.

### Models

Pantheon is built around **role-based model assignment** — rather than picking models by provider or name, the system assigns models to roles like *planner*, *executor*, and *reviewer*. Each role gets the model best suited for it.

| ID | Model | Role |
|:---|:------|:-----|
| `llama-fast` | Llama 3.1 8B Instant | Executor — fast, precise output |
| `llama-smart` | Llama 3.3 70B Versatile | Planner — reasoning, decomposition |

As Pantheon grows, more providers will be added across roles — including models from Anthropic, OpenAI, DeepSeek, and others. The gateway (LiteLLM) already supports all of them; it's a matter of plugging in API keys and config.

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
| **v0.4** | Session persistence, resume sessions, episodic memory (LLM summaries), `pantheon sessions` command, Drizzle ORM, CI fixes (`packageManager` field, root-level Vitest) |
| **v0.5** | Hono API server, CLI becomes thin HTTP client, OpenTelemetry-style tracing (LLM + tool + routing spans), `pantheon trace` command, waterfall view, rate limiting, Sentry |
