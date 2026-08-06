# ◆ Pantheon

> A multi-model AI agent orchestration system.

---

## What is Pantheon?

Pantheon is an orchestration layer for AI models. Rather than locking you into a single model or provider, Pantheon routes your conversations through a unified gateway — letting you switch models with a flag and build towards smarter, agent-driven workflows.

---

## v0.1 — The Foundation

A working CLI that streams responses from multiple models through a local gateway.

### Commands

```bash
pantheon chat                     # interactive streaming chat (uses default model)
pantheon chat --model llama-fast  # pick a specific model
pantheon models list              # list configured models
pantheon models default <id>      # change the default model
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v8+
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
pantheon chat
     │
     ▼
  CLI (Ink TUI)
     │
     ▼
  Gateway (@pantheon/core)
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
├── shared/   # Shared types and interfaces
├── core/     # Model registry, config loader, gateway
└── cli/      # pantheon binary (Commander + Ink)
```

### Models

Pantheon is built around **role-based model assignment** — rather than picking models by provider or name, the system assigns models to roles like *planner*, *executor*, and *reviewer*. Each role gets the model best suited for it.

v0.1 ships with two Groq models as a starting point:

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
pnpm turbo build   # build all packages
pnpm turbo dev     # watch mode
pnpm turbo clean   # remove build artifacts
```

---

## Versions

| Version | What it adds |
|:--------|:-------------|
| **v0.1** | Multi-model CLI, streaming chat, model registry |
