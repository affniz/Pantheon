# ◆ Pantheon

> A self-hosted, multi-model AI orchestration system with intelligent routing, persistent memory, multi-agent task decomposition, and an extensible plugin ecosystem.

**Current version: v0.9.1** · [Changelog](./CHANGELOG.md)

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

The model's answer is not taken on faith. Structural facts about the prompt set a **floor** it cannot go below: a prompt carrying code, a stack trace or file names is never routed as `general`, and one spanning several files or thousands of characters is at least `standard`. Pure small talk ("thanks!") is routed without a classifier call at all. If the classifier is unreachable or rate-limited, the request is routed on structure alone instead of failing. Classifier calls are included in `pantheon cost`.

---

### Multi-Agent Orchestration

Complex prompts automatically trigger a full pipeline without any manual flags:

```
User prompt  →  PlannerAgent  →  parallel specialist agents  →  ReviewerAgent  →  final response
```

1. **PlannerAgent** — decomposes the task into sub-tasks, each stamped with a `taskRole` (`code` / `debug` / `general`). It sees the repo map and memory of earlier sessions. Budget-controlled: `--budget low` disables orchestration; `--budget medium` caps at 3 sub-tasks (default); `--budget high` allows up to 6.
2. **Baseline check** — while the planner works, the project's own checks (`tsc --noEmit` when there is a `tsconfig.json`, and the test command from `package.json`) are run once, so later failures can be told apart from ones that were already there.
3. **Wave scheduler** — runs dependency-free sub-tasks in parallel; dependent tasks wait for their wave.
4. **Specialist agents** — `coder`, `debugger` and `executor` are role presets (instructions and iteration budget) over one implementation. Each gets the session's full tool set — built-ins plus installed plugins and MCP servers — the repo map, and memory. Agents running at the same time are coordinated: writes to a file are applied one at a time, and an agent cannot overwrite a file another agent has just written (it is told to read it and use `edit_file` instead).
5. **Verify and fix** — the checks run again. If this run broke them, a debugger agent is given the failure output and the list of files that changed, and asked to fix it; then the checks run again (up to 2 rounds). Failures that predate the run, or a run that changed no files, do not trigger a fix. Fix attempts appear as extra sub-tasks in `pantheon agents plan`.
6. **ReviewerAgent** — synthesises the results and the verification outcome into one answer, streamed as it is written. It is told when a fix was needed or when checks were already failing.

All of these run on the `complex` tier model.

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

**`grep`** is purpose-built for codebase search. It calls `rg` directly (bypasses the shell allowlist) and is auto-approved on first use — so searching across thousands of files never blocks on a permission prompt. Because it is auto-approved it is strictly confined to the project root: absolute paths, `../` traversal and symlinks that lead outside are refused. Results are reported as `path:line:text` relative to the project root.

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

A command line is split into its individual commands and **every one** must be on the allowlist — `ls -la | head`, `git status && git log` and `npm test 2>&1 | tail -50` work; `ls; curl … | sh` does not. Command substitution (`$(…)`, backticks), redirection to files, here-documents and background jobs are refused, and path arguments are checked after quote removal with `~` / `$VAR` expansion disallowed.

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

Arguments are restricted where a command could otherwise run a program or write a file on the side: `find` has no `-exec`/`-delete`, `awk` no `system()`/pipes/redirection, `sed` no `-i` or `e`/`w` commands, `rg` no `--pre`, and `git` is limited to inspection (`git config` is read-only, no `stash`/branch/tag/remote changes).

> **What this is and is not.** The allowlist controls which programs a model may start. It does not make `npm test`, `node script.js` or `make` safe — those run the project's own code with the server's privileges, by design. On your own machine that is the same trust you extend to the project anyway. For a server other people can reach, use isolated execution (below); the server prints a warning at start-up if it is exposed while running commands on the host.

**Permission model:** safe tool calls (read-only, `grep`) are auto-allowed on first use. Destructive operations require explicit approval in the TUI.

**Isolated execution (v0.9).** By default shell commands run as processes of the Pantheon server, with credentials stripped from their environment. That is appropriate for one person on their own machine. When other people can reach the server, run commands in throw-away containers instead:

```yaml
# ~/.pantheon/config.yml          (or: PANTHEON_EXEC=docker, PANTHEON_EXEC_IMAGE=…)
sandbox:
  execution:
    mode: docker
    image: node:22-slim      # must contain your project's toolchain
    network: none            # "bridge" to allow outbound access (e.g. package installs)
    memory: 2g
    cpus: 2
```

Each `shell` command — and the reviewer's `tsc` / test run — then executes in its own container that sees only the project directory (mounted at the same path), has no network, none of the server's environment variables, no Linux capabilities, a read-only root filesystem, and memory/CPU/process limits; it is removed afterwards and killed on timeout. File tools (`read_file`, `write_file`, `edit_file`, `list_directory`, `grep`) do not execute project code and stay path-jailed on the host. If the Pantheon server itself runs in Docker, it needs access to a Docker daemon for this mode.

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

Every `pantheon chat` creates a UUID-keyed session in the database (SQLite by default, PostgreSQL optionally — see [Storage Backends](#storage-backends)). Sessions are:

- **Resumable** — `pantheon chat --resume` picks up the last session; `--resume <id>` resumes a specific one. The stored transcript includes the agent's tool calls and their results (large outputs truncated), so a follow-up turn knows what the agent read and did, not just what it said.
- **Summarized** — after 4+ exchanges, a 2–3 sentence LLM summary is generated and stored.
- **Remembered** — episodic memory injects two layers of context into every new session: raw messages from the most recent past session (last 10), and LLM summaries from up to 4 older sessions. Optional [semantic memory](#semantic-memory) adds retrieval of the most relevant passages from *any* past session.

---

### Semantic Memory

Summaries lose detail as a project ages. Semantic memory keeps the original messages: every user and assistant message is embedded after its turn, and at the start of each new turn the passages most similar to the prompt — from any past session — are injected under `## Relevant memory`. The session in progress is never fed back to itself, and with authentication on, a user only recalls their own sessions.

It needs an embedding model, which Groq and DeepSeek do not offer, so it is off by default. With `OPENAI_API_KEY` set (the bundled `litellm-config.yaml` maps `pantheon-embed` to `text-embedding-3-small`; any LiteLLM embedding model works):

```yaml
# ~/.pantheon/config.yml          (or: PANTHEON_EMBEDDING_MODEL=pantheon-embed)
memory:
  semantic:
    enabled: true
    embeddingModel: pantheon-embed
    topK: 5          # memories injected per turn
    minScore: 0.35   # minimum cosine similarity
```

```bash
pantheon memory reindex                       # embed conversations from before it was enabled
pantheon memory search "how did we set up connection pooling"
pantheon memory status                        # → Search: pgvector | in-process
```

On PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector) extension installed, nearest-neighbour search runs inside the database (Pantheon creates the extension and a native `vector` column itself when it is allowed to). On SQLite, or PostgreSQL without pgvector, the same exact cosine search is computed by the server over the most recent 5,000 passages — fine for a personal history. Embeddings are stored portably, so `pantheon db migrate` carries the index across.

---

### Authentication

Out of the box there is none, and none is needed: the server listens on `127.0.0.1` only and serves the one person logged in to the machine. **Before exposing it on a network, turn authentication on** — the API drives an agent that can run commands and read files.

```bash
# .env
PANTHEON_AUTH=required
HOST=0.0.0.0                      # listen beyond localhost (the server warns if you do this with auth off)
PANTHEON_WORKSPACE=/srv/projects  # remote users can only work inside this directory
PANTHEON_EXEC=docker              # recommended: run agent commands in containers (see Tool Use & Sandbox)
```

Every request must then carry a credential:

| Credential | For | How to get it |
|:-----------|:----|:--------------|
| **API token** (`pth_…`) | CLI, scripts, CI | `pantheon auth login` (browser sign-in) or `pantheon auth token create` |
| **Session cookie** (JWT, 7 days) | Browsers / the future dashboard | Sign in at `/api/auth/login/github` or `/google` |

**Without an OAuth app** — on the server's machine, mint a token directly:

```bash
pantheon auth token create --name laptop     # prints the token once and saves it for this CLI
export PANTHEON_API_TOKEN=pth_…              # or use it from another machine / CI
```

**With GitHub or Google sign-in** — register an OAuth app whose callback URL is `<public URL>/api/auth/callback/github` (or `/google`), then:

```bash
PANTHEON_PUBLIC_URL=https://pantheon.example.com
PANTHEON_GITHUB_CLIENT_ID=…        PANTHEON_GITHUB_CLIENT_SECRET=…
PANTHEON_GOOGLE_CLIENT_ID=…        PANTHEON_GOOGLE_CLIENT_SECRET=…
PANTHEON_ALLOWED_EMAILS=teammate@example.com     # optional; see below
PANTHEON_JWT_SECRET=<32+ random characters>      # required when running several server processes
```

```bash
pantheon auth login --server https://pantheon.example.com   # opens the browser, saves a token to ~/.pantheon/credentials
pantheon auth status
pantheon auth token list
pantheon auth logout                                        # revokes the token server-side
```

**Who gets in.** Sign-up is closed by default: the first person to sign in becomes the **owner**; anyone else is refused unless their (provider-verified) e-mail is in `PANTHEON_ALLOWED_EMAILS` / `auth.allowedEmails`. `*` opens it to anyone with an account at a configured provider.

**What is isolated.** With auth required, each user sees and can continue only their own sessions, their semantic memory, and the live activity of their own sessions. Traces, cost totals, agent records and plugin management are still instance-wide in v0.9 — treat everyone you admit as trusted with those. Per-resource roles are planned for v1.0.

Details: tokens are stored only as SHA-256 hashes and shown once; the CLI login uses a loopback redirect with a single-use code bound to a PKCE-style verifier, so the token never passes through the browser; OAuth state is signed and tied to the initiating browser; cookie-authenticated writes are checked against the server's origin.

---

### Live Activity Feed

`GET /api/ws` is a WebSocket carrying the same events the chat stream emits — routing decisions, tool calls, agent spawn/complete/fail, plan and review results — for every session you are allowed to see, as they happen. It is what a dashboard would subscribe to; today you can watch it from a second terminal:

```bash
pantheon agents watch                 # all sessions
pantheon agents watch -s <sessionId>  # one session
pantheon agents watch --json          # raw events, one JSON object per line
```

```
ws://localhost:3000/api/ws?sessionId=<id>&types=agent_spawned,agent_completed&access_token=pth_…
→ { "type": "agent_spawned", "sessionId": "…", "timestamp": 1794721831529, "data": { … } }
```

Token deltas (`text`) are excluded unless listed in `types`. Clients may send `{"action":"subscribe","sessionId":…,"types":[…]}` to change filters and `{"action":"ping"}`. Authentication is the same as for HTTP; since browsers cannot set headers on a WebSocket, the token may be passed as `access_token` (accepted on the upgrade request only).

---

### Storage Backends

Pantheon is local-first: out of the box everything lives in a single SQLite file at `~/.pantheon/pantheon.db`, with nothing to install or run. Since v0.9 the same code runs unchanged on **PostgreSQL**, for when you want the server in a container, on another machine, or shared by several processes.

| Backend | Select it with | Good for |
|:--------|:---------------|:---------|
| SQLite (default) | nothing — or `PANTHEON_DB_PATH=/path/to/file.db` | Single machine, zero setup |
| PostgreSQL (tested on 16) | `DATABASE_URL=postgres://user:pass@host:5432/db` | Docker / remote deployments, multiple server processes |

**Moving to PostgreSQL**

```bash
# 1. Start a database (or point at one you already run)
docker compose --profile postgres up -d postgres

# 2. Copy your existing sessions, traces, usage and orchestration history
pantheon server stop
pantheon db migrate --to postgres://pantheon:pantheon@localhost:5432/pantheon

# 3. Switch over — add to .env, then start the server again
#    DATABASE_URL=postgres://pantheon:pantheon@localhost:5432/pantheon
pantheon server start
pantheon db status          # → Backend: postgres
```

`pantheon db migrate` never modifies the source, preserves every id, and skips rows that already exist in the destination — so an interrupted copy is simply re-run. It works in any direction (`--from` / `--to` accept a `postgres://` URL or a SQLite file path), which also makes it a backup tool: `pantheon db migrate --to ./backup.db`.

**Schema migrations** are versioned and applied automatically at startup on both backends (recorded in `schema_migrations`; concurrent server starts are serialised on PostgreSQL with an advisory lock). Databases created by v0.4–v0.8 are upgraded in place. A database written by a *newer* Pantheon is refused rather than risk corrupting it.

Configuration precedence: `DATABASE_URL` → `database.url` in `config.yml` → `PANTHEON_DB_PATH` → `database.sqlitePath` in `config.yml` → `~/.pantheon/pantheon.db`. Prefer the environment variable for PostgreSQL so the password stays out of config files; Pantheon redacts passwords wherever it prints a connection URL.

---

### Observability & Tracing

Every LLM call, tool invocation, and routing decision is wrapped in an OpenTelemetry-style span and persisted to SQLite. Browse them with `pantheon trace list` and inspect the full waterfall with `pantheon trace show <id>`.

---

### Evaluation

Tests prove the plumbing works; they cannot tell you whether Pantheon does good work with your models. `pantheon eval` runs repeatable tasks against the real stack — each one a small project, a prompt, and checks on the result:

```yaml
# evals/02-fix-failing-test.yml
name: fix-failing-test
prompt: "`node test.js` fails. Find the bug in src/range.js and fix it. Do not modify test.js."
files:
  src/range.js: |
    function range(start, end) { … }
  test.js: |
    …
checks:
  - command: node test.js                 # passes when it exits 0
  - file_contains: { path: test.js, text: "assert.deepStrictEqual(range(1, 3), [1, 2, 3]);" }
  - tool_called: edit_file
```

```bash
pantheon eval                              # run ./evals (six starter tasks are bundled)
pantheon eval --report before.json         # save a report
pantheon eval --compare before.json        # …change a prompt or a model, then see what regressed or got fixed
pantheon eval --only fix-failing --keep    # one task; keep its project directory for inspection
```

Each task runs in a throw-away copy of its project (so tool prompts are approved automatically) and reports pass/fail per check, duration, tool calls, the routing decision and token usage; the command exits non-zero if any task fails. Checks: `file_exists`, `file_absent`, `file_contains`, `file_not_contains`, `file_equals`, `command`, `response_contains`, `response_not_contains`, `tool_called`, `tool_not_called`, `max_tool_calls`. Task options: `orchestrate`, `model`, `noTools`, `timeoutSeconds`.

The bundled tasks are a starting point — the valuable ones are the tasks you actually use Pantheon for. Run the set after changing a prompt, a model, or the orchestration.

---

### Health Diagnostics

```bash
pantheon doctor
```

Runs 8 checks: Node.js version, pnpm version, Docker daemon, database (connects, applies migrations, reports backend and schema version), LiteLLM gateway reachability (with latency), GROQ_API_KEY (live ping), DEEPSEEK_API_KEY (live ping, optional), fallback providers. Shows ✓ / ⚠ / ✗ with actionable hints. Exits non-zero on critical failures.

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
pantheon chat --consensus         # fan-out to all models and synthesize the best answer
pantheon chat --orchestrate       # force multi-agent orchestration for this prompt
pantheon chat --orchestrate false # force single-agent (skip orchestration auto-detect)

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
pantheon agents watch             # follow live agent activity over the WebSocket feed (v0.9)

# Consensus (v0.8)
pantheon consensus list           # list recent consensus runs
pantheon consensus show <id>      # show per-model responses and synthesized result

# A/B experiments (v0.8)
pantheon ab list                  # list configured A/B experiments
pantheon ab comparison <id>       # show control vs. variant analytics (latency + quality score)

# Auth (v0.9)
pantheon auth status              # server auth mode and who you are signed in as
pantheon auth login               # browser sign-in (GitHub/Google); saves an API token
pantheon auth logout              # revoke and forget the saved token
pantheon auth token create        # mint a token directly in the database (no OAuth needed)
pantheon auth token list          # your tokens
pantheon auth token revoke <id>   # revoke one

# Semantic memory (v0.9)
pantheon memory status            # enabled? search path, what is indexed
pantheon memory search <query>    # passages from past conversations similar to the query
pantheon memory reindex           # embed messages that are not indexed yet
pantheon memory clear             # drop the index (conversations are kept)

# Database (v0.9)
pantheon db status                # backend, location, schema version, row counts
pantheon db status --url <loc>    # inspect another database (postgres://… or a SQLite path)
pantheon db migrate --to <loc>    # copy all data to another database (SQLite ⇄ PostgreSQL)
pantheon db migrate --from <loc> --to <loc> --yes   # explicit source; merge into a non-empty target

# Evaluation
pantheon eval [location]          # run eval tasks against the real model; exit 1 if any fail
pantheon eval --report out.json   # write a JSON report
pantheon eval --compare old.json  # show regressions and fixes against an earlier report

# Cost
pantheon cost                     # show total usage summary
pantheon cost --session <id>      # usage of one session (v0.9)
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

The answer is streamed as it is written — in agent mode too, including the short commentary before each tool call — rather than appearing all at once when the turn ends.

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
cd Pantheon

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

The Pantheon API server starts automatically in the background on the first `pantheon chat`. You can also start it manually with `pantheon server start`. Its output goes to `~/.pantheon/server.log`; if it fails to start, the CLI prints the last lines of that log.

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
│  ├── globalRateLimiter  (100/client/min)│
│  ├── llmRateLimiter     (15 remote / 60 local per min)
│  │     keyed on the TCP peer; proxy headers only with PANTHEON_TRUST_PROXY=1
│  └── authMiddleware     (token / JWT)   │
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
│             #   SessionManager, SessionSummarizer,
│             #   DB layer (Drizzle; SQLite + PostgreSQL, versioned migrations, copyDatabase),
│             #   OrchestrationStore, ConsensusStore, ABStore, AuthStore,
│             #   SemanticMemory, MemoryStore, EventBus,
│             #   HostExecutor, DockerExecutor,
│             #   Tracer, TraceCollector, TraceStore,
│             #   Orchestrator, PlannerAgent, CoderAgent, DebuggerAgent,
│             #   ExecutorAgent, ReviewerAgent (+ verification),
│             #   PluginRegistry, PluginLoader, ManifestValidator,
│             #   MCPClient, StdioTransport, SSETransport, MCPAdapter,
│             #   built-in tools (read_file, write_file, edit_file, list_directory, shell, grep),
│             #   repo-map (buildRepoMap via ts-morph)
├── server/   # @pantheon/server — Hono API server (:3000)
│             #   routes: /api/chat, /api/sessions, /api/models,
│             #           /api/cost, /api/traces, /api/agents, /api/health (+ /db),
│             #           /api/plugins, /api/consensus, /api/ab,
│             #           /api/auth, /api/memory, /api/ws (WebSocket)
│             #   middleware: rate-limiter, sentry, request-logger, auth
├── cli/      # pantheon binary (Commander + Ink) — thin API client
│             #   commands: chat, doctor, sessions, models, cost, trace, server, agents, plugins, db, auth, memory
│             #   ui: theme, logo, input-box, message, status-bar,
│             #       tool-call, tool-permission, trace-waterfall, plugin-badge
└── (root)    # plugins/ — example plugins: github, web-search, jira
```

### Database

Pantheon persists through Drizzle ORM to **SQLite** (default, `~/.pantheon/pantheon.db`, created automatically) or **PostgreSQL** — see [Storage Backends](#storage-backends). The schema is identical on both:

| Table | Purpose |
|:------|:--------|
| `sessions` | One row per chat session (title, timestamps, model, archived flag, owning user) |
| `messages` | All messages per session (role, content, tool calls, timestamps) |
| `usage_records` | Per-call token usage and cost tracking |
| `session_summaries` | LLM-generated summaries for episodic memory |
| `spans` | Trace spans — one row per LLM call / tool use / routing decision |
| `agent_nodes` | One row per agent (orchestrator/planner/coder/debugger/executor/reviewer) with status, result, timing |
| `task_plans` | Task decomposition plan per orchestrated session |
| `sub_tasks` | Individual sub-tasks within a plan, with dependency graph, taskRole, and execution results |
| `installed_plugins` | Tracks installed plugins — name, version, source, enabled flag, install timestamp |
| `consensus_runs` | Per-request consensus fan-out results with synthesized content, per-model responses, and async quality score |
| `ab_runs` | Per-request A/B experiment records — arm, model, latency, token counts, and async quality score |

| `users` | People who may use the instance — e-mail, sign-in provider, role (`owner` / `member`) |
| `api_tokens` | API tokens (SHA-256 hash only), with last-used, expiry and revocation times |
| `memory_chunks` | Semantic memory — embedded passages of past messages |
| `schema_migrations` | Applied schema versions — drives automatic, idempotent upgrades at startup |

All database access goes through store classes in `@pantheon/core` (`SessionManager`, `CostTracker`, `TraceStore`, `OrchestrationStore`, `ConsensusStore`, `ABStore`). They are fully async and dialect-agnostic; the two Drizzle schemas (`schema.sqlite.ts`, `schema.pg.ts`) are kept identical by a parity test.

### Models

Pantheon uses **role-based model assignment** — models are matched to roles, not picked manually.

| ID | Model | Tier | Role |
|:---|:------|:-----|:-----|
| `llama-smart` | Llama 3.3 70B Versatile (Groq) | `general` | Routing classifier, general Q&A |
| `deepseek-v4-flash` | DeepSeek Chat V4 (0324) | `simple` / `standard` | Simple & moderate coding tasks |
| `deepseek-v4-pro` | DeepSeek Reasoner V4 (0324) | `complex` | Complex coding + all orchestration agents |

All models are accessed through the LiteLLM gateway (Docker on `:4000`). Optional fallback models (`claude-fallback`, `gpt-fallback`) activate automatically on primary provider errors if `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` are set — for both `complete()` and streaming calls.

Provider-specific request parameters belong in config, not code — for example a reasoning model that needs thinking switched on:

```yaml
models:
  - id: deepseek-v4-pro
    provider: deepseek
    extraParams: { thinking: { type: enabled }, reasoning_effort: high }   # sent with every request to this model
```

No model name is hard-coded: the classifier, the context summariser and the quality judge use the `general` tier model, orchestration uses the `complex` tier, and the failover chain starts at the `complex` tier model.

To have `pantheon cost` report dollar amounts (not just tokens), add per-model pricing to `config.yml`; without it, cost is recorded as `$0` and tokens are still tracked:

```yaml
models:
  - id: deepseek-v4-flash
    provider: deepseek
    pricing: { inputPer1M: 0.27, outputPer1M: 1.10 }   # USD per 1M tokens
```

---

## Development

```bash
pnpm turbo build      # build all packages
pnpm turbo dev        # watch mode
pnpm turbo lint       # run ESLint
pnpm vitest run       # run tests (from monorepo root)
pnpm turbo clean      # remove build artifacts
```

Tests run against the TypeScript sources (no build needed) and never call a real LLM. Besides unit tests there is an **end-to-end suite** (`packages/server/src/__tests__/e2e.test.ts`): the real server, real gateway and real tools against a scripted stand-in for the model endpoint, speaking the actual wire protocol (streaming, fragmented tool calls) — so the path from HTTP request to tool execution to stored transcript is exercised with nothing mocked in between. A **Docker integration test** runs the isolated executor against a real daemon when one is available (it is in CI) and is skipped otherwise. Every storage test runs twice — on in-memory SQLite and on [PGlite](https://pglite.dev) (real PostgreSQL compiled to WASM, in-process) — so no database server is required. To additionally exercise the production `pg` driver against a real server (CI does this):

```bash
PANTHEON_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/postgres pnpm vitest run
```

Each test gets its own throw-away database on that server, dropped afterwards; the role needs `CREATEDB`.

`@typescript-eslint/no-floating-promises` is enforced: every database call is async, and a forgotten `await` would silently drop a write.

---

## Version History

Full details in [CHANGELOG.md](./CHANGELOG.md).

| Version | Summary |
|:--------|:--------|
| **v0.9.1** | Orchestration verifies its work and fixes what it broke; parallel agents no longer overwrite each other; sub-agents get plugins, repo map and memory; streamed answers in agent mode; tool calls kept in session history; routing that degrades instead of failing; argument-level shell restrictions; rate limiter no longer spoofable; `pantheon eval`; end-to-end tests over the real wire protocol |
| **v0.9** | PostgreSQL backend alongside SQLite + `pantheon db migrate`; authentication (API tokens, GitHub/Google OAuth, JWT sessions, `pantheon auth`); live WebSocket activity feed + `agents watch`; Docker-isolated command execution; semantic memory (RAG, pgvector); per-session cost, tier-scoped A/B, mid-turn repo-map refresh; two sandbox escapes closed; server and CLI test coverage. Web dashboard deferred. |
| **v0.8** | Consensus engine (fan-out to N models, LLM synthesis); A/B experiment router with deterministic session assignment, quality judge, and analytics; provider failover chain; routing confidence threshold with auto-escalation; `--consensus` flag; `pantheon consensus` + `pantheon ab` commands |
| **v0.7** | Plugin system (inline + MCP); sandbox overhauled to allowlist + arg path validation; `pantheon doctor`; `--budget` flag; Groq-only graceful degradation; `edit_file` + `grep` tools; repo map (AST codebase index); shell API key filtering; ReviewerAgent tsc+test verification; PermissionManager fork; context window pruning; 147 deterministic tests |
| **v0.6** | Multi-agent orchestration — Planner/Coder/Debugger/Reviewer pipeline; DeepSeek V4; context-aware routing; `general` tier; `pantheon agents` commands |
| **v0.5** | Hono API server; CLI becomes thin HTTP client; OpenTelemetry-style tracing; `pantheon trace`; rate limiting; Sentry |
| **v0.4** | Session persistence; resume sessions; episodic memory; `pantheon sessions`; Drizzle ORM |
| **v0.3** | ReAct agent loop; tool use (read_file, write_file, list_directory, shell); sandbox; two-tier permissions; CI pipeline |
| **v0.2** | Intelligent routing; LLM complexity classifier; cost tracking; `pantheon cost` |
| **v0.1** | Multi-model CLI; streaming chat; model registry; LiteLLM gateway |
