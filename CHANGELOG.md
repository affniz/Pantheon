# Changelog

All notable changes to Pantheon are documented here.

---

## [0.7.0] — 2026-08-17

Pantheon becomes **extensible and hardened**. Any MCP-compatible tool server can now be wired in as a plugin — GitHub, Jira, web search, or anything built to the Model Context Protocol spec — without touching core source code. The shell sandbox is overhauled from a permissive blocklist to a strict allowlist, and further hardened with argument-level path validation. A new `pantheon doctor` command diagnoses installation health. The `--budget` flag gives fine-grained control over orchestration cost. DeepSeek is now optional — Pantheon runs with only a Groq key and gracefully degrades complex prompts with a warning. The test suite grows to 147 fully deterministic tests with no real LLM API calls required.

### Added
- **Plugin framework** — install plugins from local directories or npm packages via `pantheon plugins install`. Each plugin directory contains a `pantheon-plugin.json` manifest that declares inline TypeScript tools or an MCP server configuration.
- **MCP Client SDK** — full Model Context Protocol client supporting both stdio (subprocess) and SSE (HTTP) transports. Connects any Claude Desktop-compatible MCP server; tools are auto-discovered via `tools/list` and invoked via `tools/call`.
- **Sandbox hardening** — the `shell` tool flipped from a command blocklist to a strict allowlist (`DEFAULT_SHELL_ALLOWLIST`, ~30 entries). Configurable per-project via `sandbox.additionalAllowlist` / `sandbox.denyFromDefault` in `config.yml`.
- **`validateArgPaths()` in Sandbox** — new private method called after the allowlist check passes. For commands that accept file paths (`cat`, `head`, `tail`, `node`, `python`, `python3`, `stat`, `file`, `wc`), validates that any absolute-path or `../` argument resolves within the project root jail. Prevents `cat /etc/passwd`-style argument injection even when the binary is allowlisted.
- **Tighter `blockedArgs`** — `sed -i` (in-place modification) is now blocked. URL argument patterns (`https?://`) and path-traversal patterns are blocked for `node`, `python`, and `python3`.
- **Plugin badge in TUI** — plugin tool calls render `🔌 plugin-name` inline alongside the tool name in the terminal.
- **`pantheon plugins` commands** — `list`, `install <source>`, `remove <name>`, `info <name>`.
- **`/api/plugins` REST endpoints** — `GET /api/plugins`, `GET /api/plugins/:name`, `POST /api/plugins/install`, `POST /api/plugins/:name/remove`.
- **`MockGateway`** — deterministic test double implementing `complete()`, `stream()`, and `resolveRouting()`. Queue text and tool-call responses; inspect the call log without hitting any API.
- **`MockMCPServer`** — in-process MCP server for tests; handles `initialize`, `tools/list`, and `tools/call`; records a call log for assertions.
- **Example plugins** — GitHub (`@modelcontextprotocol/server-github`), Web Search (inline Tavily + Brave Search API), Jira (`@sooperset/mcp-atlassian`).
- **`ToolRegistry` enhancements** — `has()`, `getByPlugin()`, plugin-annotated `toOpenAITools()` descriptions.
- **`installed_plugins` table** — tracks installed plugins (name, version, source, directory, enabled flag, install timestamp) in SQLite.
- **`pantheon doctor`** — diagnostic command. Checks Node.js/pnpm versions, Docker daemon, LiteLLM gateway reachability, API key presence, and live model ping. Exits non-zero on critical failures. Shows ✓ / ⚠ / ✗ with actionable hints.
- **`--budget` flag on `pantheon chat`** — controls Planner cost/latency budget: `low` (no orchestration), `medium` (default, up to 3 sub-tasks), `high` (up to 6 sub-tasks). Flows all the way from CLI → API body → Orchestrator → PlannerAgent.
- **`getCapabilities()` helper** — exported from `@pantheon/core`. Returns `{ groqEnabled, orchestrationEnabled, anthropicFallbackEnabled, openaiFallbackEnabled }` based on environment variables. Used by `doctor` and the chat route.
- **Fallback model entries in `litellm-config.yaml`** — `claude-fallback` (Claude 3.5 Sonnet via Anthropic) and `gpt-fallback` (GPT-4o via OpenAI) registered as `fallback_models` in `router_settings`. Activated when primary providers return errors.
- **`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` documented in `.env.example`** — clearly marked as optional fallback keys.
- **`warning` SSE event** — emitted when a complex prompt is downgraded to direct LLM because `DEEPSEEK_API_KEY` is missing. Rendered as `⚠ …` inline in the TUI.
- **`maxSubTasks` in `PlannerConfig` and `OrchestratorConfig`** — clamps the number of sub-tasks generated. Default 3, range 1–6. Enforced both in the system prompt (`Generate AT MOST N tasks`) and via a hard slice after parsing.
- **`getEpisodicMemoryContext()` in `SessionSummarizer`** — builds a two-tier memory context: raw user+assistant messages from the most recent past session (last 10 messages, for precision) + LLM-generated summaries from up to 4 older sessions (for compact history). Replaces the previous `getRecentSummaries()`-only injection.
- **`edit_file` tool** — targeted substring replacement for existing files (`{ path, targetContent, replacementContent }`). Finds the first exact match and replaces it — no full-file rewrites, no accidental deletions. Errors loudly if `targetContent` is not found. `safety: "destructive"`. Preferred over `write_file` for all modifications to existing files.
- **`grep` tool** — first-class ripgrep wrapper, `safety: "safe"` (auto-approved, no permission prompt ever). Parameters: `{ pattern, path?, caseInsensitive?, contextLines?, fileGlob? }`. Calls `rg` directly via `child_process.execFile` — bypasses `Sandbox.validateCommand` so codebase search never triggers an allowlist gate or permission prompt.
- **`PermissionManager.fork()`** — creates a child `PermissionManager` pre-seeded with the parent session's `alwaysAllowed` grants. Called per concurrent sub-agent in `executeWave()` to eliminate shared mutable permission state.
- **`AgentConfig.maxContextChars`** (default `80_000`) — mid-turn context window cap. When `workingMessages` total chars exceed this, the oldest tool messages are compressed into a summary via `llama-smart` before the next iteration. Prevents silent API rejections on long `CoderAgent` turns.
- **Repo map module** (`packages/core/src/tools/repo-map/`) — `buildRepoMap(projectRoot)` uses `ts-morph` to scan all `.ts/.tsx/.js/.jsx` files, extract exported symbols, and produce a compact codebase index (~1,500–2,500 tokens for a typical TS monorepo). Injected into the agent system prompt as `## Codebase Map` at session start — eliminates blind `listDirectory` exploration loops.
- **`ts-morph`** dependency added to `packages/core` for AST-based repo map generation.

### Changed
- **Groq-only mode** — `DEEPSEEK_API_KEY` is no longer required to start. When it is missing and a complex prompt is classified, the server warns and falls back to `llama-smart` (general tier) instead of hard-failing.
- **Plan preview in TUI** — `plan_created` SSE event now renders a richer plan card: `◆ Plan (N sub-tasks): 1. [code] … / 2. [debug] … / 3. [general] …` with role badges before sub-agents start executing.
- **Episodic memory injection** — chat route now calls `getEpisodicMemoryContext(currentSessionId)` with `recentMessageCount: 10` and `summaryLimit: 4`, replacing the flat `getRecentSummaries(5)` call.
- **Shell tool: API key filtering (security fix)** — `shell.ts` previously passed `env: { ...process.env }` to `execFile`, exposing all secrets. Now strips keys matching `/_API_KEY$/i`, `/_TOKEN$/i`, `/_SECRET$/i`, `/_PASSWORD$/i` via `filterEnv()` before spawning.
- **ReviewerAgent now verifies output before approving** — previously set `approved = failedCount === 0`. Now runs `tsc --noEmit` and the detected test command (`vitest`/`jest`) before synthesis. If either fails, `approved = false` and the failure output is included in the synthesis prompt. `ReviewerConfig` gains a required `sandbox: Sandbox` field.
- **Orchestrator: per-agent PermissionManager** — `executeWave` now calls `permissionManager.fork()` per sub-agent instead of sharing one instance across concurrent agents.
- **Orchestrator: rich sub-agent context propagation** — `executeWave` now passes a structured context block (task title, status, files written/modified extracted from `toolResults`) to successor wave agents. All three agent result types (`CoderResult`, `DebuggerResult`, `ExecutorResult`) now carry `toolResults: ToolResult[]`.
- **`BASE_SYSTEM_PROMPT` extended** — adds file editing discipline (prefer `edit_file` for modifications, `write_file` for new files only) and codebase search discipline (use `grep` tool, not shell grep).

### Tests
- 147 tests passing across 19 test files (unchanged count; reviewer tests updated to mock `execFile` and provide `sandbox: Sandbox`)

---

## [0.6.0] — 2026-08-15

Pantheon gains its first multi-agent brain. Prompts classified as `complex` no longer go to a single LLM call — they trigger a full Planner → specialist agents → Reviewer pipeline where a `PlannerAgent` decomposes the task into typed sub-tasks, specialist agents execute them in parallel dependency waves, and a `ReviewerAgent` synthesises a coherent final response. DeepSeek V4 replaces `llama-fast` for all coding work. The routing classifier is upgraded to read the last N turns of conversation history, fixing misclassification of short follow-ups like "debug this" that are ambiguous without context.

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

Every LLM call, tool invocation, and routing decision is now **fully observable**. The CLI is redesigned as a thin HTTP client — all logic moves into a Hono API server that runs as a persistent background process. This architectural shift enables rate limiting, Sentry error monitoring, and a future web dashboard to be built on a stable API surface from day one.

### Added
- **Pantheon API server** — Hono on `:3000`; CLI becomes a thin HTTP client
- **Structured tracing** — OpenTelemetry-style spans for every LLM call, tool use, and routing decision
- **`pantheon trace` commands** — `list`, `show <id>` (waterfall view), `clear`
- **`pantheon server` commands** — `start`, `stop`, `status`
- **Rate limiting** — `hono-rate-limiter`: 100 req/IP/min globally, 15 req/IP/min on the LLM endpoint
- **Sentry integration** — error monitoring from first day of network exposure

---

## [0.4.0] — 2026-07

Conversations now **persist across terminal sessions**. Every `pantheon chat` creates a UUID-keyed session saved to SQLite. The LLM auto-generates a short summary of each session after 4+ exchanges, and those summaries are injected into future chats as episodic memory — giving the model context about work done in previous sessions without needing to re-read full transcripts.

### Added
- **Session persistence** — every `pantheon chat` creates a UUID-keyed session saved to SQLite
- **Resume sessions** — `pantheon chat --resume` / `pantheon chat --resume <id>`
- **Episodic memory** — LLM-generated summaries of past sessions injected into future system prompts
- **Background summarization** — triggered automatically after 4+ message exchanges
- **`pantheon sessions` commands** — `list`, `show`, `delete`, `archive`
- **Drizzle ORM** — all DB access through Drizzle (`better-sqlite3`); Postgres migration at v0.9 is a driver swap

---

## [0.3.0] — 2026-06

Pantheon gains its **agentic loop**. The model can now read files, write files, list directories, and run shell commands — using a ReAct (observe → think → act) loop that iterates until the task is complete. A two-tier permission system and a project-root filesystem jail prevent the agent from taking destructive actions without explicit approval. CI is introduced to gate all future changes.

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

Prompts are now **automatically routed** to the cheapest model that can handle them. A one-shot LLM call classifies each prompt as `simple`, `standard`, or `complex` before the main request is dispatched. Every model call's token usage and cost is recorded to SQLite, giving full visibility into spend over time.

### Added
- **LLM-based complexity classifier** — one-shot call to llama-smart classifies prompts into `simple` / `standard` / `complex`
- **Intelligent routing engine** — dispatches to the cheapest capable model per tier
- **Cost tracking** — per-call token usage and cost stored in SQLite
- **`pantheon cost` commands** — `cost`, `cost recent`, `cost reset`
- **`--model` flag** — escape hatch to pin a specific model and bypass routing

---

## [0.1.0] — 2026-04

The first working build. A single `pantheon chat` command streams tokens from Llama 3.3 70B (via Groq) through a local LiteLLM Docker gateway. The model registry is configurable, and the provider abstraction ensures all future model additions are gateway-side changes — no code rewrites.

### Added
- **`pantheon` CLI binary** — Commander.js + Ink (React for terminal)
- **Streaming chat** — real-time token streaming via `pantheon chat`
- **Model registry** — configurable via `.pantheon/config.yml`
- **Provider abstraction** — all model calls through LiteLLM gateway (Docker on `:4000`)
- **`pantheon models` commands** — `list`, `default <id>`
- **Groq integration** — Llama 3.3 70B as the initial model
