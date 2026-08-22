# ◆ Pantheon

> A self-hosted, multi-model AI orchestration system with intelligent routing, persistent memory, multi-agent task decomposition, and an extensible plugin ecosystem.

**Current version: v0.7.0** · [Changelog](./CHANGELOG.md)

---

## What is Pantheon?

Pantheon is an orchestration layer for AI models. Rather than locking you into a single model or provider, it routes every conversation through a unified LiteLLM gateway — automatically classifying task complexity and dispatching to the cheapest capable model. Complex tasks spawn a full multi-agent pipeline. Simple ones get a direct, fast response. All of it is traced, persisted, and observable.

It is self-hosted, local-first, and fully owned by you.

---

## Features

### Intelligent Routing

Every prompt is classified by complexity before a model is chosen. A one-shot call to `llama-smart` (`max_tokens: 5`, `temperature: 0`) assigns one of four tiers:

| Tier | Route | Use case |
|:-----|:------|:---------|
| `general` | `llama-smart` (direct) | Greetings, factual Q&A |
| `simple` | `deepseek-v4-flash` | Short code edits, quick fixes |
| `standard` | `deepseek-v4-flash` | Multi-file tasks, moderate complexity |
| `complex` | Orchestrator → DeepSeek V4 Pro | Architecture, debugging chains, large refactors |

The classifier receives the last N turns of conversation history (default: 5) — so short follow-ups like *"debug this"* are classified correctly in context. Use `--model` to pin a model and bypass routing entirely.

---

### Multi-Agent Orchestration

Complex prompts automatically trigger a full pipeline without any manual flags:

```
User prompt  →  PlannerAgent  →  parallel specialist agents  →  ReviewerAgent  →  final response
```

1. **PlannerAgent** (deepseek-v4-pro) — decomposes the task into sub-tasks, each stamped with a `taskRole` (`code` / `debug` / `general`). Budget-controlled: `--budget low` disables orchestration; `--budget medium` caps at 3 sub-tasks (default); `--budget high` allows up to 6.
2. **Wave scheduler** — runs dependency-free sub-tasks in parallel (`Promise.allSettled`); dependent tasks wait for their wave.
3. **CoderAgent** (deepseek-v4-pro) — specialist for code generation, implementation, and file modification.
4. **DebuggerAgent** (deepseek-v4-pro) — specialist for root-cause analysis, error diagnosis, and fix verification.
5. **ExecutorAgent** (deepseek-v4-pro) — general tasks: research, documentation, Q&A.
6. **ReviewerAgent** (deepseek-v4-pro) — synthesises all agent results into a single coherent response.

The plan preview is shown in the TUI with role badges before agents start executing:

```
◆ Plan (3 sub-tasks):
  1. [code]  Scaffold the Express router
  2. [debug] Investigate the failing test
  3. [general] Update the README
```

---

### Tool Use & Sandbox

The agent uses a ReAct (observe → think → act) loop. Built-in tools:

| Tool | Safety | What it does |
|:-----|:-------|:-------------|
| `read_file` | safe | Read any file within the project root |
| `write_file` | destructive | Create a new file (for new files only) |
| `edit_file` | destructive | Targeted substring replacement in an existing file — no full rewrites |
| `list_directory` | safe | List directory contents |
| `shell` | destructive | Execute allowlisted shell commands |
| `grep` | **safe** | Ripgrep-backed codebase search — auto-approved, no permission prompt |

**`edit_file`** is the preferred tool for all file modifications. The agent provides `{ path, targetContent, replacementContent }` to replace an exact substring rather than rewriting the whole file — preventing hallucinated deletions on large files.

**`grep`** is purpose-built for codebase search. It calls `rg` directly (bypasses the shell allowlist) and is auto-approved on first use — so searching across thousands of files never blocks on a permission prompt.

**Sandbox model (v0.7+):** the `shell` tool validates every command against a strict allowlist before execution. The default allowlist covers ~30 safe command families:

| Category | Commands |
|:---------|:---------|
| File inspection | `ls`, `cat`, `head`, `tail`, `stat`, `file` |
| Text processing | `grep`, `rg`, `find`, `awk`, `sed`, `jq`, `sort`, `diff` |
| System info | `echo`, `pwd`, `which`, `env`, `uname`, `date` |
| Git (read-only) | `status`, `log`, `diff`, `show`, `branch`, `describe` |
| Package managers | `npm`/`pnpm`/`yarn` safe subcommands (list, run, test, audit…) |
| Runtimes | `node`, `python`, `python3` (no `-e`/`-c` exec flags, no URL args) |
| Test runners | `vitest`, `jest`, `pytest`, `go`, `cargo`, `make` |
| Compilers | `tsc --noEmit`, `eslint`, `prettier` |

File-path arguments to `cat`, `head`, `tail`, `node`, `python3`, etc. are additionally validated to stay within the project root. `sed -i`, URL-as-arg, and `../` traversal patterns are blocked. **API keys and secrets are stripped from child process environments** — all env vars matching `/_API_KEY$/i`, `/_TOKEN$/i`, `/_SECRET$/i`, `/_PASSWORD$/i` are removed before `execFile`.

Extend or restrict the allowlist per-project:

```yaml
# ~/.pantheon/config.yml
sandbox:
  additionalAllowlist:
    - command: docker
      subcommands: [ps, images, logs]
      description: "Docker inspection commands"
  denyFromDefault: []
```

**Permission model:** safe tool calls (read-only, `grep`) are auto-allowed on first use. Destructive operations require explicit approval in the TUI.

---

### Plugin System & MCP

Pantheon is extensible via plugins. Any MCP-compatible server (Claude Desktop, GitHub, Jira, Slack, web search…) can be wired in without touching core source code.

**Plugin types:**

- **Inline** — TypeScript/JS handler executed in-process (e.g. web-search)
- **MCP stdio** — spawns a subprocess MCP server (e.g. GitHub, Jira)
- **MCP SSE** — connects to a remote HTTP MCP server

**Plugin structure:**

```
plugin-directory/
├── pantheon-plugin.json   ← manifest (name, version, tools or mcp config)
├── src/
│   └── handler.ts         ← inline tool handler (if not MCP)
└── README.md
```

**Quick-start:**

```bash
# Install the bundled web-search plugin
export TAVILY_API_KEY=tvly-xxxx
pantheon plugins install ./plugins/web-search

# Install the GitHub plugin (requires GITHUB_TOKEN)
export GITHUB_TOKEN=ghp_xxxx
pantheon plugins install ./plugins/github

# See what tools a plugin provides
pantheon plugins info @pantheon-plugins/github

# Remove a plugin
pantheon plugins remove @pantheon-plugins/web-search
```

Once installed, plugin tools are automatically available to all agents during `pantheon chat`. Plugin tool calls are flagged with `🔌 plugin-name` in the TUI.

Bundled example plugins: **GitHub** (`@modelcontextprotocol/server-github`), **Web Search** (Tavily + Brave Search), **Jira** (`@sooperset/mcp-atlassian`).

---

### Session Persistence & Memory

Every `pantheon chat` creates a UUID-keyed session in SQLite. Sessions are:

- **Resumable** — `pantheon chat --resume` picks up the last session; `--resume <id>` resumes a specific one.
- **Summarized** — after 4+ exchanges, a 2–3 sentence LLM summary is generated and stored.
- **Remembered** — episodic memory injects two layers of context into every new session: raw messages from the most recent past session (last 10), and LLM summaries from up to 4 older sessions.

---

### Observability & Tracing

Every LLM call, tool invocation, and routing decision is wrapped in an OpenTelemetry-style span and persisted to SQLite. Browse them with `pantheon trace list` and inspect the full waterfall with `pantheon trace show <id>`.

---

### Health Diagnostics

```bash
pantheon doctor
```

Runs 7 checks: Node.js version, pnpm version, Docker daemon, LiteLLM gateway reachability (with latency), GROQ_API_KEY (live ping), DEEPSEEK_API_KEY (live ping, optional), fallback providers. Shows ✓ / ⚠ / ✗ with actionable hints. Exits non-zero on critical failures.

---

## All Commands

```bash
pantheon                          # branded welcome screen
pantheon doctor                   # check prerequisites, API keys, gateway health

# Chat
pantheon chat                     # agentic chat — tools enabled, session saved
pantheon chat --resume            # resume the last session
pantheon chat --resume <id>       # resume a specific session
pantheon chat --no-save           # chat without saving
pantheon chat --no-tools          # pure chat mode (no tool access)
pantheon chat --model <id>        # pin a specific model (bypass routing)
pantheon chat --budget low        # Groq-only — no orchestration
pantheon chat --budget medium     # default — up to 3 sub-tasks
pantheon chat --budget high       # up to 6 sub-tasks

# Sessions
pantheon sessions list            # list recent sessions (default: 10)
pantheon sessions list -n 20      # list more
pantheon sessions list --all      # include archived
pantheon sessions show <id>       # show session details + summary
pantheon sessions delete <id>     # permanently delete (with confirmation)
pantheon sessions archive <id>    # soft-delete

# Plugins
pantheon plugins list             # list installed plugins (name, version, status, tool count)
pantheon plugins install <source> # install from local path or npm package
pantheon plugins remove <name>    # uninstall a plugin
pantheon plugins info <name>      # show plugin details and available tools

# Agents
pantheon agents list              # list recent orchestration runs
pantheon agents show <agentId>    # show agent node details
pantheon agents plan <sessionId>  # show the decomposed task plan for a session

# Cost
pantheon cost                     # show total usage summary
pantheon cost recent              # show last 10 calls
pantheon cost reset               # clear usage data

# Traces
pantheon trace list               # list recent execution traces
pantheon trace show <id>          # show trace waterfall
pantheon trace clear              # clear all trace data

# Models
pantheon models list              # list configured models
pantheon models default <id>      # change the default model

# Server
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

  🔧 search 🔌 web-search({ query: "TypeScript MCP libraries" })
  First use of search — [a] allow once  [A] always allow  [n] deny
  ↳ ✓ Done · 5 results
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v9+
- [Docker](https://www.docker.com/)
- A [Groq API key](https://console.groq.com/) (free) — **required** for routing classifier
- A [DeepSeek API key](https://platform.deepseek.com/) — **optional** (enables orchestration and coding agents; without it, complex prompts fall back to Groq)

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
# Edit .env and set GROQ_API_KEY (required)
# Set DEEPSEEK_API_KEY to enable orchestration (optional)

# 6. Check your installation
pantheon doctor

# 7. Start the model gateway
docker compose up -d

# 8. Start chatting
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
│             #   PermissionManager (+ fork()), ToolRegistry, AgentRuntime (+ maxContextChars, repoMap),
│             #   SessionManager, SessionSummarizer, Drizzle DB layer,
│             #   Tracer, TraceCollector, TraceStore,
│             #   Orchestrator, PlannerAgent, CoderAgent, DebuggerAgent,
│             #   ExecutorAgent, ReviewerAgent (+ verification),
│             #   PluginRegistry, PluginLoader, ManifestValidator,
│             #   MCPClient, StdioTransport, SSETransport, MCPAdapter,
│             #   built-in tools (read_file, write_file, edit_file, list_directory, shell, grep),
│             #   repo-map (buildRepoMap via ts-morph)
├── server/   # @pantheon/server — Hono API server (:3000)
│             #   routes: /api/chat, /api/sessions, /api/models,
│             #           /api/cost, /api/traces, /api/agents, /api/health,
│             #           /api/plugins
│             #   middleware: rate-limiter, sentry, request-logger
├── cli/      # pantheon binary (Commander + Ink) — thin API client
│             #   commands: chat, doctor, sessions, models, cost, trace, server, agents, plugins
│             #   ui: theme, logo, input-box, message, status-bar,
│             #       tool-call, tool-permission, trace-waterfall, plugin-badge
└── (root)    # plugins/ — example plugins: github, web-search, jira
```

### Database

Pantheon uses **SQLite** (via Drizzle ORM) for local-first persistence. The database lives at `~/.pantheon/pantheon.db` and is created automatically on first run.

| Table | Purpose |
|:------|:--------|
| `sessions` | One row per chat session (title, timestamps, model, archived flag) |
| `messages` | All messages per session (role, content, tool calls, timestamps) |
| `usage_records` | Per-call token usage and cost tracking |
| `session_summaries` | LLM-generated summaries for episodic memory |
| `spans` | Trace spans — one row per LLM call / tool use / routing decision |
| `agent_nodes` | One row per agent (orchestrator/planner/coder/debugger/executor/reviewer) with status, result, timing |
| `task_plans` | Task decomposition plan per orchestrated session |
| `sub_tasks` | Individual sub-tasks within a plan, with dependency graph, taskRole, and execution results |
| `installed_plugins` | Tracks installed plugins — name, version, source, enabled flag, install timestamp |

> **v0.9** will introduce a PostgreSQL migration path — Drizzle makes this a driver swap, not a rewrite.

### Models

Pantheon uses **role-based model assignment** — models are matched to roles, not picked manually.

| ID | Model | Tier | Role |
|:---|:------|:-----|:-----|
| `llama-smart` | Llama 3.3 70B Versatile (Groq) | `general` | Routing classifier, general Q&A |
| `deepseek-v4-flash` | DeepSeek Chat V4 (0324) | `simple` / `standard` | Simple & moderate coding tasks |
| `deepseek-v4-pro` | DeepSeek Reasoner V4 (0324) | `complex` | Complex coding + all orchestration agents |

All models are accessed through the LiteLLM gateway (Docker on `:4000`). Optional fallback models (`claude-fallback`, `gpt-fallback`) activate automatically on primary provider errors if `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` are set.

---

## Development

```bash
pnpm turbo build      # build all packages
pnpm turbo dev        # watch mode
pnpm turbo lint       # run ESLint
pnpm vitest run       # run tests (147 tests, from monorepo root)
pnpm turbo clean      # remove build artifacts
```

---

## Version History

Full details in [CHANGELOG.md](./CHANGELOG.md).

| Version | Summary |
|:--------|:--------|
| **v0.7** | Plugin system (inline + MCP); sandbox overhauled to allowlist + arg path validation; `pantheon doctor`; `--budget` flag; Groq-only graceful degradation; `edit_file` + `grep` tools; repo map (AST codebase index); shell API key filtering; ReviewerAgent tsc+test verification; PermissionManager fork; context window pruning; 147 deterministic tests |
| **v0.6** | Multi-agent orchestration — Planner/Coder/Debugger/Reviewer pipeline; DeepSeek V4; context-aware routing; `general` tier; `pantheon agents` commands |
| **v0.5** | Hono API server; CLI becomes thin HTTP client; OpenTelemetry-style tracing; `pantheon trace`; rate limiting; Sentry |
| **v0.4** | Session persistence; resume sessions; episodic memory; `pantheon sessions`; Drizzle ORM |
| **v0.3** | ReAct agent loop; tool use (read_file, write_file, list_directory, shell); sandbox; two-tier permissions; CI pipeline |
| **v0.2** | Intelligent routing; LLM complexity classifier; cost tracking; `pantheon cost` |
| **v0.1** | Multi-model CLI; streaming chat; model registry; LiteLLM gateway |
