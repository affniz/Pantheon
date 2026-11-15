export { loadConfig, saveConfig, getCapabilities } from "./config/loader.js";
export type { PantheonCapabilities } from "./config/loader.js";
export { ModelRegistry } from "./registry/model-registry.js";
export { Gateway } from "./gateway/gateway.js";
export type { ModelFallbackCallback, GatewayOptions } from "./gateway/gateway.js";
export { Classifier } from "./router/classifier.js";
export { CostTracker } from "./cost/tracker.js";
export { Sandbox, splitShellCommand } from "./sandbox/sandbox.js";
export { HostExecutor, DockerExecutor, filterEnv } from "./sandbox/executor.js";
export type { CommandExecutor, ExecRequest, ExecResult, DockerExecutorOptions } from "./sandbox/executor.js";
export type { SandboxConfig } from "./sandbox/sandbox.js";
export { PermissionManager } from "./sandbox/permission-manager.js";
export type { PermissionDecision, PermissionCallback } from "./sandbox/permission-manager.js";
export { ToolRegistry } from "./tools/tool-registry.js";
export type { Tool, OpenAITool } from "./tools/tool-registry.js";
export { registerBuiltinTools, editFileTool, grepTool } from "./tools/builtin/index.js";
export { buildRepoMap } from "./tools/repo-map/index.js";

export { AgentRuntime, hashPrompt } from "./agent/agent-runtime.js";
export type { AgentConfig, AgentTurnResult, AgentRunOptions } from "./agent/agent-runtime.js";
export {
    getDb,
    initDb,
    closeDb,
    openDatabase,
    closeDatabase,
    tablesFor,
    dialectOf,
    resolveDatabaseTarget,
    parseDatabaseTarget,
    describeTarget,
    redactUrl,
    getDatabaseStatus,
    copyDatabase,
    createTestDb,
    createTestPgDb,
    closeTestDbs,
    sqliteSchema,
    pgSchema,
    LATEST_SCHEMA_VERSION,
} from "./db/index.js";
export type {
    PantheonDatabase,
    Tables,
    Dialect,
    DatabaseTarget,
    DatabaseStatus,
    TransferReport,
    TransferOptions,
} from "./db/index.js";
export { DbStore } from "./db/store.js";
// Query operators re-exported so API consumers (e.g. @pantheon/server) can build
// Drizzle queries against `schema` without depending on drizzle-orm themselves —
// a second drizzle-orm instance would not type-unify with the one `schema` uses.
export { eq, desc, and, sql } from "drizzle-orm";
export { AuthStore, NotAuthorizedError, hashToken, safeEqual, normalizeEmail, TOKEN_PREFIX } from "./auth/auth-store.js";
export type { User, UserRole, AuthProvider, ApiTokenInfo } from "./auth/auth-store.js";
export { EventBus, eventBus } from "./events/event-bus.js";
export type { PantheonEvent, EventListener } from "./events/event-bus.js";
export { SemanticMemory, MemoryStore, cosineSimilarity, chunkText } from "./memory/index.js";
export type { Embedder, MemoryHit, MemoryStatus, SemanticMemoryOptions } from "./memory/index.js";
export { SessionManager } from "./session/session-manager.js";
export { SessionSummarizer } from "./session/summarizer.js";
export { Tracer } from "./tracing/tracer.js";
export { TraceCollector } from "./tracing/collector.js";
export { TraceStore } from "./tracing/store.js";
export { OrchestrationStore } from "./orchestrator/store.js";
export type { AgentNodeRow, TaskPlanRow, SubTaskRow } from "./orchestrator/store.js";
export { Orchestrator } from "./orchestrator/orchestrator.js";
export type { OrchestratorConfig, OrchestratorResult } from "./orchestrator/orchestrator.js";
export { PlannerAgent } from "./orchestrator/planner.js";
export type { PlannerConfig } from "./orchestrator/planner.js";
export { ExecutorAgent } from "./orchestrator/executor.js";
export type { ExecutorConfig, ExecutorResult } from "./orchestrator/executor.js";
export { CoderAgent } from "./orchestrator/coder.js";
export type { CoderConfig, CoderResult } from "./orchestrator/coder.js";
export { DebuggerAgent } from "./orchestrator/debugger.js";
export type { DebuggerConfig, DebuggerResult } from "./orchestrator/debugger.js";
export { ReviewerAgent } from "./orchestrator/reviewer.js";
export type { ReviewerConfig, ReviewResult } from "./orchestrator/reviewer.js";
export { PluginRegistry, loadPlugin, discoverPlugins, installPlugin, uninstallPlugin, DEFAULT_PLUGINS_DIR, validateManifest, parseManifest } from "./plugins/index.js";
export type { PluginManifest, PluginToolConfig, MCPServerConfig, LoadedPlugin, PluginInfo, PluginStatus, PluginTransport, PluginValidationResult } from "./plugins/index.js";
export { MCPClient, StdioTransport, SSETransport, mcpToolToDefinition, createMCPTool, createMCPTools, MCP_VERSION } from "./mcp/index.js";
export type { MCPTransportConfig, StdioTransportConfig, SSETransportConfig, MCPToolDefinition, MCPToolCallResult, ServerCapabilities } from "./mcp/index.js";

// ── v0.8: Consensus & A/B ────────────────────────────────────────────────────
export { ConsensusEngine, ConsensusStore } from "./consensus/index.js";
export type { ConsensusRunSummary, ConsensusRunDetail } from "./consensus/index.js";
export { ABRouter, QualityJudge, ABStore } from "./ab/index.js";
export type { ABResolution } from "./ab/index.js";