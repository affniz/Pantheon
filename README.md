# ◆ Pantheon

> A self-hosted, multi-model AI orchestration system with intelligent routing and persistent memory.

---

## What is Pantheon?

Pantheon is an orchestration layer for AI models. Rather than locking you into a single model or provider, Pantheon routes your conversations through a unified gateway — letting you switch models with a flag, build towards smarter agent-driven workflows, and remember past conversations across sessions.

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

### New commands

```bash
pantheon sessions list              # list recent sessions (default: 10)
pantheon sessions list -n 20        # list more sessions
pantheon sessions list --all        # include archived sessions
pantheon sessions show <id>         # show session details + summary
pantheon sessions delete <id>       # permanently delete (with confirmation)
pantheon sessions archive <id>      # soft-delete a session

pantheon chat --resume              # resume the latest session
pantheon chat --resume <id>         # resume a specific session
pantheon chat --no-save             # run without saving the session
```

---

## v0.3 — Tool Use, Agent Runtime & Sandboxing

Pantheon is an **agentic system**. The LLM can call tools — read files, write files, list directories, and run shell commands — with a ReAct-style agent loop that handles multi-step reasoning autonomously.

**Safety-first**: All tools are sandboxed to the project root. Destructive tools (`writeFile`, `shell`) always require user confirmation. Safe tools (`readFile`, `listDirectory`) prompt on first use with the option to allow once or always allow for the session.

### All commands

```bash
pantheon                          # branded welcome screen
pantheon chat                     # agentic chat — tools enabled, session saved
pantheon chat --resume            # resume the last session
pantheon chat --resume <id>       # resume a specific session
pantheon chat --no-save           # chat without saving
pantheon chat --no-tools          # pure chat mode (no tool access)
pantheon chat --model llama-fast  # manual model override
pantheon sessions list            # list recent sessions
pantheon sessions show <id>       # show session details
pantheon sessions delete <id>     # delete a session
pantheon sessions archive <id>    # archive a session
pantheon models list              # list configured models
pantheon models default <id>      # change the default model
pantheon cost                     # show total usage summary
pantheon cost recent              # show last 10 calls
pantheon cost reset               # clear usage data
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

---

## Architecture

```
pantheon chat "Read src/index.ts and explain it"
     │
     ▼
  CLI (Ink TUI)
     │
     ├── SessionManager              ← create / resume / persist sessions
     ├── SessionSummarizer           ← episodic memory injection
     ├── Sandbox(projectRoot: cwd)   ← path jail + command validation
     ├── PermissionManager           ← two-tier confirmation
     │
     ▼
  AgentRuntime (@pantheon/core)
     │
     ├── 1. Classify → Route to model
     │
     ├── 2. Gateway.complete() ──→ LiteLLM ──→ Groq
     │        │
     │        ▼
     ├── 3. LLM returns tool_calls?
     │     YES → PermissionManager → Sandbox → ToolRegistry
     │           ├── readFile()      (safe)
     │           ├── writeFile()     (destructive)
     │           ├── listDirectory() (safe)
     │           └── shell()         (destructive)
     │           → Append results → Loop to step 2
     │     NO  → Stream final text response
     │
     ▼
  Persist messages + trigger background summarization
     │
     ▼
  Display in TUI
```

### Packages

```
packages/
├── shared/   # Shared types: ModelConfig, ChatMessage, Session, SessionSummary,
│             #   ToolDefinition, ToolCall, ToolResult, UsageRecord, etc.
├── core/     # ModelRegistry, Gateway, Classifier, CostTracker, Sandbox,
│             #   PermissionManager, ToolRegistry, AgentRuntime,
│             #   SessionManager, SessionSummarizer, Drizzle DB layer,
│             #   built-in tools (readFile, writeFile, listDirectory, shell)
└── cli/      # pantheon binary (Commander + Ink) — chat, sessions, models, cost
               #   ui/  theme, logo, input-box, message, status-bar, tool-call, tool-permission
```

### Database

Pantheon uses **SQLite** (via Drizzle ORM) for local-first persistence. The database lives at `~/.pantheon/pantheon.db` and is created automatically on first run.

| Table | Purpose |
|:------|:--------|
| `sessions` | One row per chat session (title, timestamps, model, archived flag) |
| `messages` | All messages per session (role, content, tool calls, timestamps) |
| `usage_records` | Per-call token usage and cost tracking |
| `session_summaries` | LLM-generated summaries for episodic memory |

> **v0.9** will introduce a PostgreSQL migration path — Drizzle makes this a driver swap, not a rewrite.

### Models

Pantheon is built around **role-based model assignment** — rather than picking models by provider or name, the system assigns models to roles like *planner*, *executor*, and *reviewer*. Each role gets the model best suited for it.

| ID | Model | Role |
|:---|:------|:-----|
| `llama-fast` | Llama 3.1 8B Instant | Executor — fast, precise output |
| `llama-smart` | Llama 3.3 70B Versatile | Planner — reasoning, decomposition |

As Pantheon grows, more providers will be added across roles — including models from Anthropic, OpenAI, DeepSeek, and others. The gateway (LiteLLM) already supports all of them; it's a matter of plugging in API keys and config.

### Configuration

Pantheon reads config from `.pantheon/config.yml` in the current directory, or `~/.pantheon/config.yml` globally. If neither exists, built-in defaults are used.

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
