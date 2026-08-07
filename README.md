# ◆ Pantheon

> A self-hosted, multi-model AI orchestration system with intelligent routing.

---

## What is Pantheon?

Pantheon is an orchestration layer for AI models. Rather than locking you into a single model or provider, Pantheon routes your conversations through a unified gateway — letting you switch models with a flag and build towards smarter, agent-driven workflows.

---

## v0.2 — Intelligent Routing & Cost Tracking

Pantheon now classifies every prompt and routes it to the cheapest capable model automatically. Usage is tracked in a local SQLite database. The CLI ships with a polished terminal UI — branded splash screen, bordered input, and live streaming output.

### Commands

```bash
pantheon                          # branded welcome screen
pantheon chat                     # auto-routes based on prompt complexity
pantheon chat --model llama-fast  # manual override — bypasses routing
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

The input box shows the active model and routing mode. Each assistant response includes a routing badge: `↳ routed: llama-fast · simple · ~42 tokens`.

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
pantheon chat
     │
     ▼
  CLI (Ink TUI)
     │
     ▼
  Classifier (@pantheon/core)   ← one-shot LLM call, picks tier
     │  simple / standard / complex
     ▼
  Gateway (@pantheon/core)      ← routes to correct model, records usage
     │  OpenAI-compatible API
     ▼
  LiteLLM Proxy (Docker :4000)
     │
     ▼
  Groq → llama-3.1-8b-instant / llama-3.3-70b-versatile
```

### Packages

```
packages/
├── shared/   # Shared types: ModelConfig, ChatMessage, RoutingDecision, UsageRecord, etc.
├── core/     # ModelRegistry, Gateway, Classifier, CostTracker, config loader
└── cli/      # pantheon binary (Commander + Ink) — chat, models, cost commands
               #   ui/  theme, logo, input-box, message, status-bar, key-hints
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
npx turbo clean   # remove build artifacts
```

---

## Versions

| Version | What it adds |
|:--------|:-------------|
| **v0.1** | Multi-model CLI, streaming chat, model registry |
| **v0.2** | Intelligent routing, LLM complexity classifier, SQLite cost tracker, polished TUI |
