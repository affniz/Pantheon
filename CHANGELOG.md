# Changelog

All notable changes to Pantheon are documented here.

---

## [0.6.0] — 2026-08-15

### Added
- **Multi-agent orchestration** — complex tasks automatically trigger the full Planner → Coder/Debugger/Executor → Reviewer pipeline
- **CoderAgent** — specialist for code generation, implementation, and file modification (deepseek-v4-pro, 15-iteration budget)
- **DebuggerAgent** — specialist for root-cause analysis, error diagnosis, and fix verification (deepseek-v4-pro)
- **Role-based dispatch** — PlannerAgent assigns `taskRole` (`"code"` / `"debug"` / `"general"`) to each sub-task; Orchestrator dispatches to the correct specialist
- **Context-aware routing** — classifier receives the last N user turns (default: 5) alongside the current prompt for accurate follow-up classification
- **`general` routing tier** — greetings and factual Q&A route to `llama-smart` without consuming DeepSeek quota
- **DeepSeek V4 Flash** — new model for `simple` / `standard` coding tasks
- **DeepSeek V4 Pro** — new model for `complex` tasks and all orchestration agents (Planner, Coder, Debugger, Executor, Reviewer)
- **`pantheon agents` commands** — `list`, `show <agentId>`, `plan <sessionId>` for inspecting orchestration runs
- **Agent persistence** — `agent_nodes`, `task_plans`, `sub_tasks` (with `taskRole`) tables in SQLite
- **Topological sort wave scheduler** — sub-tasks with no unmet dependencies run in parallel; dependent tasks wait for their wave
- **`SubTask.taskRole`** field in `@pantheon/shared`
- **`AgentRole`** extended with `"coder"` | `"debugger"` in `@pantheon/shared`
- **`ComplexityTier`** extended with `"general"` in `@pantheon/shared`
- **`RoutingConfig.routingContextDepth`** — configures how many recent user turns the classifier receives (default: 5)
- **`pantheon_context.md`** added to `.gitignore`

### Changed
- **`llama-fast` removed** — `llama-smart` handles routing and general Q&A; DeepSeek handles all coding
- **`OrchestratorConfig.agentModelId`** replaces the old `executorModelId` at the orchestrator config level
- **`litellm-config.yaml`** updated — `llama-fast` removed, `deepseek-v4-flash` and `deepseek-v4-pro` added
- **`.env`** now requires `DEEPSEEK_API_KEY` in addition to `GROQ_API_KEY`

### Tests
- 83 tests passing (up from 78)
- New classifier tests: context-aware routing, `general` tier classification

---

## [0.5.0] — 2026-08

### Added
- **Pantheon API server** — Hono on `:3000`; CLI becomes a thin HTTP client
- **Structured tracing** — OpenTelemetry-style spans for every LLM call, tool use, and routing decision
- **`pantheon trace` commands** — `list`, `show <id>` (waterfall view), `clear`
- **`pantheon server` commands** — `start`, `stop`, `status`
- **Rate limiting** — `hono-rate-limiter`: 100 req/IP/min globally, 15 req/IP/min on the LLM endpoint
- **Sentry integration** — error monitoring from first day of network exposure

---

## [0.4.0] — 2026-07

### Added
- **Session persistence** — every `pantheon chat` creates a UUID-keyed session saved to SQLite
- **Resume sessions** — `pantheon chat --resume` / `pantheon chat --resume <id>`
- **Episodic memory** — LLM-generated summaries of past sessions injected into future system prompts
- **Background summarization** — triggered automatically after 4+ message exchanges
- **`pantheon sessions` commands** — `list`, `show`, `delete`, `archive`
- **Drizzle ORM** — all DB access through Drizzle (`better-sqlite3`); Postgres migration at v0.9 is a driver swap

---

## [0.3.0] — 2026-06

### Added
- **AgentRuntime** — ReAct-style observe → think → act loop
- **ToolRegistry** — extensible tool system with OpenAI function-calling format
- **Built-in tools** — `readFile`, `writeFile`, `listDirectory`, `shell`
- **Sandbox** — project-root jail, symlink prevention, command safety classification
- **PermissionManager** — two-tier permission system (safe vs destructive) with per-session memory
- **`--no-tools` flag** — pure chat mode bypassing the agent loop
- **CI pipeline** — GitHub Actions: typecheck, lint, build, Vitest on push/PR

---

## [0.2.0] — 2026-05

### Added
- **LLM-based complexity classifier** — one-shot call to llama-smart classifies prompts into `simple` / `standard` / `complex`
- **Intelligent routing engine** — dispatches to the cheapest capable model per tier
- **Cost tracking** — per-call token usage and cost stored in SQLite
- **`pantheon cost` commands** — `cost`, `cost recent`, `cost reset`
- **`--model` flag** — escape hatch to pin a specific model and bypass routing

---

## [0.1.0] — 2026-04

### Added
- **`pantheon` CLI binary** — Commander.js + Ink (React for terminal)
- **Streaming chat** — real-time token streaming via `pantheon chat`
- **Model registry** — configurable via `.pantheon/config.yml`
- **Provider abstraction** — all model calls through LiteLLM gateway (Docker on `:4000`)
- **`pantheon models` commands** — `list`, `default <id>`
- **Groq integration** — Llama 3.3 70B as the initial model
