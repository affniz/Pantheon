# ◆ Pantheon

> A self-hosted, multi-model AI orchestration system with intelligent routing.

---

## What is Pantheon?

Pantheon is an orchestration layer for AI models. Rather than locking you into a single model or provider, Pantheon routes your conversations through a unified gateway — letting you switch models with a flag and build towards smarter, agent-driven workflows.

---

## v0.3 — Tool Use, Agent Runtime & Sandboxing

Pantheon is now an **agentic system**. The LLM can call tools — read files, write files, list directories, and run shell commands — with a ReAct-style agent loop that handles multi-step reasoning autonomously.

**Safety-first**: All tools are sandboxed to the project root. Destructive tools (`writeFile`, `shell`) always require user confirmation. Safe tools (`readFile`, `listDirectory`) prompt on first use with the option to allow once or always allow for the session.

### Commands

```bash
pantheon                          # branded welcome screen
pantheon chat                     # agentic chat — tools enabled
pantheon chat --no-tools          # pure chat mode (v0.2 behavior)
pantheon chat --model llama-fast  # manual model override
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
npx turbo build

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
     ├── Sandbox(projectRoot: cwd)     ← path jail + command validation
     ├── PermissionManager             ← two-tier confirmation
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
  Display in TUI
```

### Packages

```
packages/
├── shared/   # Shared types: ModelConfig, ChatMessage, ToolDefinition, ToolCall, ToolResult, etc.
├── core/     # ModelRegistry, Gateway, Classifier, CostTracker, Sandbox, PermissionManager,
│             #   ToolRegistry, AgentRuntime, built-in tools
└── cli/      # pantheon binary (Commander + Ink) — chat, models, cost commands
               #   ui/  theme, logo, input-box, message, status-bar, tool-call, tool-permission
```

### Models

Pantheon is built around **role-based model assignment** — rather than picking models by provider or name, the system assigns models to roles like *planner*, *executor*, and *reviewer*. Each role gets the model best suited for it.

v0.2 ships with two Groq models as a starting point:

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
npx turbo build   # build all packages
npx turbo dev     # watch mode
npx turbo lint    # run ESLint
npx turbo test    # run Vitest tests
npx turbo clean   # remove build artifacts
```

---

## Versions

| Version | What it adds |
|:--------|:-------------|
| **v0.1** | Multi-model CLI, streaming chat, model registry |
| **v0.2** | Intelligent routing, LLM complexity classifier, SQLite cost tracker, polished TUI |
| **v0.3** | Tool use (readFile, writeFile, listDirectory, shell), agent runtime (ReAct loop), sandbox + two-tier permissions, CI pipeline (ESLint + Vitest + GitHub Actions) |
