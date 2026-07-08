/**
 * T2.2 — Tiered system prompt types.
 *
 * Two cache-friendly tiers (`stable`, `context`) plus content hashes for
 * observability. Tier ordering and contents follow
 * `.specs/mcp-hermes/implementation-plans/T2.2-prompt-cache.md` §4.1.
 *
 * - `stable`  — identity files (IDENTITY/SOUL/AGENTS/USER) + frozen daily-log
 *               snapshot + runtime metadata (model, provider, platform hints).
 *               Changes only on identity reconciliation, host CRD update, or
 *               model change. Bound to `cache_control: { type: 'ephemeral' }`
 *               on Anthropic; concatenated into a single `system` string for
 *               providers without explicit cache markers.
 *
 * - `context` — capabilities contract + memory-guidance block. Stable for the
 *               life of a session; rebuilt only on compaction (the lifecycle
 *               marker we adopt by convention).
 *
 * `stableHash` / `contextHash` are sha256(content) — emitted as Prometheus
 * labels so a regression that mutates the supposedly stable tier mid-session
 * is observable, not silent.
 */
export interface SystemPromptParts {
  stable: string
  context: string
  stableHash: string
  contextHash: string
}

/**
 * Inputs to `DefaultPromptBuilder.buildParts()`. Every field is computed once
 * at the start of the session and held constant; mid-session mutations to the
 * underlying files do NOT reach the LLM until the next compaction (T1.1) or
 * an explicit invalidation event.
 */
export interface BuilderInput {
  identityFiles: IdentityFiles
  /**
   * Daily-log snapshot captured at session start. The `WorkspaceService`
   * helper `snapshotDailyLogs(days)` performs the read; mid-session writes to
   * `daily/<today>.md` go to disk but do NOT re-flow into the prompt.
   */
  dailyLogSnapshot: string
  model: string
  provider: string
  /**
   * Platform-detected hints (e.g. "DESKTOP ENVIRONMENT" when desktop tools are
   * present). Decided at session start from the initial tool registry.
   */
  platformHints: string[]
  /**
   * Capability contract emitted when `clerum__get_capabilities` is registered.
   * Decided at session start; the contract text does not depend on the
   * concrete set of MCP servers, so a polling refresh does not invalidate.
   */
  capabilities: string
  /**
   * Workflow-recipe behavioral contract (`WORKFLOW_RECIPES_TEXT`). Empty string
   * when no `workflow_*` tools are registered. Static, tool-presence gated —
   * lives in the `context` tier alongside `capabilities`/`memoryGuidance`.
   * Without this the cache path would drop the workflow protocol + non-leakage
   * guidance that the legacy `buildSystemPrompt` emits.
   */
  workflowGuidance: string
  /**
   * MCP server-selection contract (`MCP_SERVER_SELECTION_TEXT`). Empty string
   * when no namespaced (`<server>__<tool>`) MCP tools are registered. Same
   * tier and invariant as `workflowGuidance`.
   */
  mcpServerGuidance: string
  /**
   * Tool-discovery guidance (`TOOL_DISCOVERY_TEXT`, dynamic-tool-loading F4.1).
   * Empty string unless the stable bridge is active (detected by the presence
   * of `clerum__tool_search`). Constant when present, so it lives in the
   * `context` tier alongside `mcpServerGuidance` without breaking the cache hash.
   */
  toolDiscoveryGuidance: string
  /**
   * Memory guidance (P.4). Empty string when the session does not have
   * `memory_*` tools registered (P1-009): if memory tools light up
   * mid-session the cache stays valid — the guidance is best-effort and not
   * load-bearing for correctness.
   */
  memoryGuidance: string
}

export interface IdentityFiles {
  identity: string
  soul: string
  agents: string
  user: string
}
