# Changelog

All notable changes to Pantheon are documented here.

---

## [0.8.0] — 2026-09-03

Pantheon gains **multi-model consensus**, **A/B experiment routing**, and a **provider failover chain**. The routing classifier now emits a confidence score and auto-escalates ambiguous prompts. A full audit of v0.7 gap-fix tools uncovered two silent bugs in the `grep` tool (parameters accepted but never forwarded to `rg`), a missing `taskRole` column in the DB schema, orphaned gateway variable causing type unsafety in the chat route, and quality scores that were computed but never written back to the DB — all fixed in this version.

### Added
- **`ConsensusEngine`** (`packages/core/src/consensus/`) — fans out a single prompt to N models concurrently via `Promise.allSettled`, synthesizes the best answer using a configurable synthesis model. Handles 0/1/N success cases: falls back to the solo response when only one model succeeds, errors cleanly when all fail. Persists each run to `consensus_runs` with synthesized content, per-model responses, and latency.
- **`ConsensusEngine.updateQualityScore(runId, score)`** — new method to write the async LLM judge score back to the `consensus_runs` row after the response has been sent to the client.
- **`ABRouter`** (`packages/core/src/ab/`) — deterministic SHA-256 hash-based arm assignment per `experimentId:sessionId`. Reads active experiments from `loadConfig()`. Returns `ABResolution | null` with arm, modelId, and experimentId.
- **`ABStore`** — persists A/B run records to `ab_runs` table; computes per-arm averages (latency, quality score) for the `getComparison()` analytics endpoint.
- **`QualityJudge`** — async LLM-based 1–10 scorer (uses `llama-smart`). Called fire-and-forget after responses; result is written back to both `consensus_runs` and `ab_runs` via their respective `updateQualityScore()` methods.
- **Routing confidence threshold** — `Classifier` now parses an optional confidence float from the LLM response (e.g. `"standard 0.65"`). When confidence is below `confidenceThreshold` (default `0.6`) and tier is `standard`, the decision auto-escalates to `complex`. Confidence is emitted in the `routing` SSE event.
- **Provider failover chain** — `completeWithFailover()` in `Gateway` walks `DEFAULT_FAILOVER_CHAIN = ["deepseek-v4-pro", "claude-fallback", "gpt-fallback"]`. On provider error, falls back to the next model and emits a `model_fallback` SSE event (`{ from, to, reason }`).
- **`--consensus` flag on `pantheon chat`** — fan-out to all configured models and synthesize the best answer. Shows per-model streaming start/done events in the TUI.
- **`pantheon consensus list` / `consensus show <id>`** — inspect historical consensus runs.
- **`pantheon ab list`** — list configured A/B experiments from `config.yml`.
- **`pantheon ab comparison <id>`** — show control vs. variant analytics: run counts, avg latency, avg quality score, and a simple winner summary.
- **`/api/ab/experiments`** and **`/api/ab/experiments/:id/comparison`** REST endpoints.
- **`consensus_runs` SQLite table** — id, session_id, prompt_hash, synthesized_content, model_responses (JSON), synthesis_latency_ms, quality_score.
- **`ab_runs` SQLite table** — id, experiment_id, session_id, prompt_hash, arm, model_id, latency_ms, input_tokens, output_tokens, quality_score.
- **`quality_score REAL` column added to `consensus_runs`** — populated asynchronously after judge completes.
- **New unit tests: `edit-file.test.ts`** — 7 tests covering successful replacement, targetContent-not-found error, first-occurrence-only replacement, multi-line edits, missing file error, sandbox jail enforcement, and type validation.
- **New unit tests: `grep.test.ts`** — tests covering real `rg` invocations: pattern found, no-matches result, `fileGlob` filtering, `contextLines`, `caseInsensitive`, and large output truncation.
- **New `fork()` tests in `permission-manager.test.ts`** — 3 tests covering child inherits parent grants, child grants do not propagate to parent, and sibling fork isolation.
- **New unit tests: `repo-map.test.ts`** — 5 tests covering non-empty output for TS files, exported symbol extraction, `node_modules` exclusion, empty directory handling, and `dist` exclusion.

### Fixed
- **`grep.ts` silent data loss** — `contextLines` and `fileGlob` parameters were accepted by the tool definition and advertised to the LLM, but `rgArgs.push()` was called with no arguments. Changed to `rgArgs.push("-C", String(contextLines))` and `rgArgs.push("--glob", fileGlob)`. Every call using these options previously produced silently wrong results.
- **`schema.ts` / `client.ts` — missing `task_role` column** — `SubTask.taskRole` has existed in `@pantheon/shared` since v0.6, but was never in the Drizzle schema or `INIT_SQL`. Added to both the `CREATE TABLE` statement and the `ALTER TABLE` migration (best-effort, swallowed for existing DBs).
- **`client.ts` — `consensus_runs` missing `quality_score` column** — added to `CREATE TABLE` and `ALTER TABLE` migration so the `updateQualityScore` method has a column to write to.
- **`chat.ts` — `(gateway as any)` cast removed** — the agentic path previously created `const gateway = new Gateway(registry)` and `const gatewayWithFallback = new Gateway(registry, callback)` and then papered over them with a runtime `(gateway as any) = gatewayWithFallback` cast. Replaced with a single `gatewayWithFallback` instantiated at the top of the handler, used consistently for all paths (noTools, consensus, A/B, orchestration, single-agent). The orchestrator previously received the plain `gateway` (without the fallback callback); it now correctly receives `gatewayWithFallback`.
- **`chat.ts` — consensus quality score was fire-and-forget into void** — `judge.score()` was called but the result was never written anywhere. Now calls `engine.updateQualityScore(result.runId, score)` in the `.then()` callback.

### Changed
- **`package.json` version** bumped from `0.6.0` → `0.8.0` (was stale).
- **`README.md`** — version badge updated to v0.8.0; `--consensus`, `--orchestrate` flags added to command reference; `pantheon consensus` and `pantheon ab` commands documented; v0.8 row added to version history table; `consensus_runs` and `ab_runs` tables added to DB schema documentation.

- **Audit fixes (post-release pass)** — a second review of the v0.8 tree before merge fixed the items below.
  - `chat.ts` referenced the removed `gateway` variable in the orchestration path's background summarizer, so `@pantheon/server` did not compile; the new v0.8 test files also had type errors that broke `pnpm turbo build` (and therefore CI).
  - **Sub-task status was never persisted.** `PlannerAgent` stored `sub_tasks` rows with id `${planId}_${localId}` while Coder/Debugger/Executor updated rows by the LLM's local id (`task-1`), so every sub-task stayed `pending` forever. Planner now rewrites task ids (and dependency references) to the globally unique form before persisting, and also writes `task_role`, which was added to the schema but never populated.
  - **Routing classified up to three times per request** (A/B resolution, orchestrate=auto check, then again inside `AgentRuntime`), each an LLM call that could disagree. The chat route now classifies once and passes the decision to `AgentRuntime.run()` via the new `AgentRunOptions.decision`.
  - **Groq-only fallback was cosmetic.** When `DEEPSEEK_API_KEY` was missing, the route emitted a `warning` and a `general`-tier routing event but the agent re-classified and still called `deepseek-v4-pro`. The overridden decision is now the one actually executed.
  - **`experimentId` request field was ignored** — `ABRouter.resolveArm()` always picked the first active experiment. It now accepts an optional `experimentId` and returns `null` if the requested experiment is not active. Stale "(no sticky sessions in v0.8)" comment corrected: assignment is sticky per session by hash.
  - **A/B runs recorded `latencyMs: 0` and zero tokens.** `AgentTurnResult` now carries `usage` summed across all LLM calls in the turn, and the route records real turn latency and usage.
  - **`Gateway.stream()` had no failover** — `complete()` walked the failover chain but streaming did not. Streams that fail before producing output now fall back to the next chain model and emit `model_fallback`; mid-stream failures still propagate.
  - **Malformed tool-call JSON crashed the turn** — `JSON.parse` on model-emitted arguments was unguarded. Arguments that fail to parse now become `{}` (logged, recorded on the span) so the tool returns a clear error the model can act on.
  - **`pantheon agents list/show/plan` were broken** — the CLI read `id`, `createdAt`, `completedAt`, `updatedAt` from rows whose real fields are `agentId`, `startTime`, `endTime`; `list` threw on `a.id.slice`. Fixed and `plan` now shows `taskRole`.
  - **ReviewerAgent flagged every orchestration as failed verification** when the project root has no `tsconfig.json` (`tsc --noEmit` errors with "No inputs were found"). tsc is now skipped (and reported as skipped) in that case.
  - `/api/health` reported version `0.5.0`; CLI hard-coded `0.8.0` twice. Both now read `PANTHEON_VERSION` from `@pantheon/shared`. All workspace packages bumped from `0.6.0` to `0.8.0`.
  - `/api/consensus` and `/api/agents` loaded entire tables into memory and filtered/sorted in JS; now filtered, ordered and limited in SQL.
  - `docker-compose.yml` never passed `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` to the LiteLLM container, so the documented fallback models could not work under Docker.
  - **Cost tracking always recorded `$0`.** `ModelConfig` gains optional `pricing: { inputPer1M, outputPer1M }`; when set, the gateway computes `costUsd` for every call (tokens are tracked regardless).
  - Mid-turn escalation in `AgentRuntime` made a wasted classifier call and reached into `Gateway` internals via `as any`; replaced with `Gateway.getRoutingConfig()`.
  - Removed unused imports/variables flagged by ESLint; `no-unused-vars` now ignores `_`-prefixed names.
- **Test suite stability** — the suite intermittently aborted with `RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr` (better-sqlite3's native destructor running during GC after a Vitest worker context was torn down, on Node 24). Fixed by upgrading `better-sqlite3` to `12.11.1`, switching Vitest to the `forks` pool, closing every test SQLite handle after each file (`vitest.setup.ts` + `closeTestDbs()`), and making the gateway retry backoff configurable (`GatewayOptions.retryBaseDelayMs`) so failover tests no longer sleep for 12s.

### Tests
- Test count: **278 tests passing** across **30 test files** (up from 147/19 in v0.7). New coverage: stream failover, malformed tool-call arguments, cost computation, `AgentRunOptions.decision`, usage aggregation, explicit A/B `experimentId`, planner id rewriting + `task_role` persistence.

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
