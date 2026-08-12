/**
 * Core data types for the Clerum agent architecture.
 *
 * These types define the wire protocol and internal data structures
 * used across all layers (Provider, Reasoning, Orchestration, Agent Core).
 *
 * Phase 1: Pure type definitions — no runtime behavior changes.
 */
import type { SystemPromptParts } from './reasoning/systemPrompt'

// ─── Message Types ──────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: 'image/jpeg' | 'image/png'; data: string }

export interface ChatMessage {
  role: MessageRole
  content: string
  contentParts?: MessageContentPart[] // only set when tool results have images
  tool_call_id?: string
  name?: string
  tool_calls?: ToolCall[] | null
  /**
   * IronClaw invariant #2 (P.3, Opción D): lateral field that points at a
   * spillover blob written by T1.5. `content` always stays a string (a rich
   * summary if the blob exists, the literal output otherwise) so the wire
   * format never breaks. The resolver swaps in the full body at resume time.
   */
  spillover_ref?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
}

export interface Attachment {
  id: string
  kind: 'image' | 'file'
  mimeType: string
  encoding: 'base64'
  dataBase64: string
  filename?: string
  caption?: string
  width?: number
  height?: number
  sourceTool?: string
  lane?: 'workflow_result' | 'internal_generated_artifact' | 'tool_image'
  artifactFormat?: string
  artifactName?: string
  sizeBytes?: number
  redactionState?: 'applied' | 'scanned' | 'skipped:binary'
  producer?: string
}

// ─── Completion Types ───────────────────────────────────────

export enum FinishReason {
  Stop = 'stop',
  Length = 'length',
  ToolUse = 'tool_use',
  ContentFilter = 'content_filter',
  Unknown = 'unknown',
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  /**
   * T2.2 (P1-006). Anthropic-only today (other providers leave these unset).
   * `cache_read_tokens` ≡ `cache_read_input_tokens` from the SDK;
   * `cache_write_tokens` ≡ `cache_creation_input_tokens`.
   */
  cache_read_tokens?: number
  cache_write_tokens?: number
}

/**
 * Per-call attribution context for the usage reporter. Static fields like
 * host_ref and context_ref are owned by the adapter; the dimensions that
 * vary per task (source_kind, user_id, etc.) come from the call site.
 */
export interface UsageContext {
  source_kind: 'channel' | 'desktop' | 'workflow' | 'cron' | 'unknown' | 'plugin_workload_sdk'
  /** Immutable ingress trace identity. It is carried to usage ingestion, not treated as DB authority. */
  traceContext?: TraceContextV1 | null
  team_id?: string | null
  user_id?: string | null
  sender?: string | null
  channel_type?: string | null
  recipe_name?: string | null
  cron_job_id?: string | null
  task_id?: string | null
  iteration?: number | null
}

export interface CompletionRequest {
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
  stop_sequences?: string[]
  /** Abort signal forwarded to the underlying LLM HTTP call. */
  signal?: AbortSignal
  /** Optional attribution for the usage reporter. Adapter no-ops when absent. */
  usageContext?: UsageContext
  /**
   * T2.2 — Tiered system prompt. When set, `messages` MUST NOT carry a
   * `role:'system'` entry — the parts go through the cache-aware path
   * (cache_control breakpoints on Anthropic, concat for other providers).
   * Leaving this `undefined` preserves the legacy single-string path.
   */
  systemPromptParts?: SystemPromptParts
}

export interface CompletionResponse {
  content: string
  usage: TokenUsage
  /** True only when the provider response carried authoritative token counters. */
  usage_reported?: boolean
  finish_reason: FinishReason
}

export interface ToolCompletionRequest {
  messages: ChatMessage[]
  tools: ToolDefinition[]
  max_tokens?: number
  temperature?: number
  tool_choice?: 'auto' | 'none' | 'required'
  /** Abort signal forwarded to the underlying LLM HTTP call. */
  signal?: AbortSignal
  /** Optional attribution for the usage reporter. Adapter no-ops when absent. */
  usageContext?: UsageContext
  /**
   * T2.2 — Tiered system prompt. When set, `messages` MUST NOT carry a
   * `role:'system'` entry — see `CompletionRequest.systemPromptParts`.
   */
  systemPromptParts?: SystemPromptParts
}

export interface ToolCompletionResponse {
  content: string | null
  tool_calls: ToolCall[] | null
  usage: TokenUsage
  /** True only when the provider response carried authoritative token counters. */
  usage_reported?: boolean
  finish_reason: FinishReason
}

// ─── Reasoning Types ────────────────────────────────────────

export interface ReasoningContext {
  messages: ChatMessage[]
  available_tools: ToolDefinition[]
  job_description?: string
  current_state?: string
  /** Abort signal forwarded down to the LLM HTTP call. */
  signal?: AbortSignal
}

export type RespondResult =
  | { type: 'text'; content: string }
  | { type: 'tool_calls'; calls: ToolCall[]; content?: string; usage?: TokenUsage }
  | { type: 'need_approval'; approval: PendingApproval }
  | { type: 'error'; error: Error }

// ─── Tool Execution Types ───────────────────────────────────

export interface ToolResult {
  tool_call_id: string
  name: string
  content: string
  is_error: boolean
  attachments?: Attachment[]
  metadata?: Record<string, unknown>
  /**
   * Pre-sanitization content for user-facing output preview.
   * WARNING: bypasses the XML safety wrapper. Do NOT use in LLM messages.
   * Intentionally unsanitized so the UI shows the real tool output, not the wrapped version.
   */
  rawContent?: string
  /**
   * IronClaw invariant #2 (P.3, Opción D): when T1.5 lands, this carries a
   * `spillover://<task_id>/<tool_call_id>` URI that the resolver swaps in at
   * resume time. Undefined for inline results.
   */
  spillover_ref?: string
}

export interface ToolOutput {
  content: string
  duration_ms: number
  is_error: boolean
  attachments?: Attachment[]
  metadata?: Record<string, unknown>
}

// ─── Safety Types ───────────────────────────────────────────

export interface ValidationResult {
  is_valid: boolean
  errors: string[]
}

export interface SanitizedOutput {
  content: string
  was_modified: boolean
  warnings: string[]
}

// ─── Channel Types ──────────────────────────────────────────

export const TRACE_CONTEXT_MAX_CORRELATION_REFS = 16
export const TRACE_CONTEXT_MAX_CORRELATION_REF_LENGTH = 256

export interface TraceContextV1 {
  version: 1
  runId: string
  sessionId?: string | null
  origin: 'channel_event' | 'direct_chat' | 'api'
  correlationRefs: readonly string[]
}

export function isTraceContextV1(value: unknown): value is TraceContextV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const context = value as Record<string, unknown>
  const allowedKeys = new Set(['version', 'runId', 'sessionId', 'origin', 'correlationRefs'])
  if (Object.keys(context).some(key => !allowedKeys.has(key))) return false
  if (context.version !== 1) return false
  if (typeof context.runId !== 'string' || context.runId.trim().length === 0) return false
  if (
    context.sessionId !== undefined &&
    context.sessionId !== null &&
    (typeof context.sessionId !== 'string' || context.sessionId.trim().length === 0)
  ) {
    return false
  }
  if (!['channel_event', 'direct_chat', 'api'].includes(context.origin as string)) return false
  if (!Array.isArray(context.correlationRefs)) return false
  if (context.correlationRefs.length > TRACE_CONTEXT_MAX_CORRELATION_REFS) return false

  return context.correlationRefs.every(
    ref =>
      typeof ref === 'string' &&
      ref.length > 0 &&
      ref.length <= TRACE_CONTEXT_MAX_CORRELATION_REF_LENGTH
  )
}

export interface IncomingMessage {
  id: string
  channel: string
  user_id: string
  content: string
  metadata: Record<string, unknown>
  received_at: Date
  traceContext?: TraceContextV1 | null
}

export interface OutgoingResponse {
  content: string
  metadata?: Record<string, unknown>
}

export type StatusUpdateType = 'thinking' | 'tool_started' | 'tool_completed' | 'approval_needed'

export interface StatusUpdate {
  type: StatusUpdateType
  detail?: string
}

// ─── Conversation Types ─────────────────────────────────────

export enum ConversationState {
  Idle = 'idle',
  Processing = 'processing',
  AwaitingApproval = 'awaiting_approval',
}

export interface Conversation {
  id: string
  user_id: string
  /**
   * The serialized session key this conversation is stored under
   * (`<userId>:<channelType>:<channelId>[:<threadId>]` — see `session.ts`).
   *
   * Distinct from `user_id`, which is the bare identity (`msg.sender`). The
   * store's LRU/evict key, `getSessionByKey`, the executor-busy guard, and the
   * prompt-cache key all key on THIS value, so they must agree. Optional for
   * back-compat with conversations created before this field existed; callers
   * fall back to `user_id` when absent.
   */
  session_key?: string
  state: ConversationState
  turns: Turn[]
  pending_approval?: PendingApproval
  auto_approved_tools: Set<string>
  /**
   * Guardrail doom-loop counter (spec §6.4) — tracks consecutive identical
   * `(resolved tool, effective-input)` tool calls across turns within a task.
   * Ephemeral (like `auto_approved_tools`): not persisted; resets on resume.
   * Absent until the first guarded tool call.
   */
  guardrail_doom_loop?: { lastKey?: string; count: number }
  created_at: Date
  updated_at: Date
  /**
   * D.1 — task currently in flight for this conversation. Set on `startTurn`,
   * cleared on any terminal transition (complete/fail/cancel). Lives in RAM
   * (like `state` / `pending_approval`) and is mirrored to the durable
   * `sessions.active_task_id` column so `GET /v1/runtime/sessions` can tell the
   * desktop which task to re-subscribe to. Ephemeral by design: not persisted
   * on the `Turn`, repopulated from SQLite on cold-load (see `reconstruct.ts`).
   */
  activeTaskId?: string
  /** Correlation context for the active turn only. Cleared on every terminal transition. */
  traceContext?: TraceContextV1 | null
  /**
   * T1.4 anti-thrash bookkeeping. Lives on `Conversation` (not in a per-process
   * map) so the lifetime is scoped to the task naturally: reset in
   * `handleLoopResult` terminal cases. Optional for back-compat.
   */
  compactionState?: CompactionState
  /**
   * Lifetime token totals for this session — a RAM mirror of the durable
   * `sessions.*_tokens` columns. Maintained by `ConversationManager.recordSessionUsage`
   * (additive on each LLM call) and rehydrated from SQLite on cold-load
   * (`reconstruct.ts`). Optional for back-compat with sessions created before
   * this existed; consumers treat `undefined` as 0.
   */
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  /**
   * True once ANY LLM call in this session reported cache token info (providers
   * with native prompt caching like Anthropic populate `cache_*`; others leave
   * them undefined). Drives whether
   * the desktop shows the cache breakdown. On cold-load it is derived from
   * whether the persisted cache columns are > 0 (see `reconstruct.ts`).
   */
  cacheTokensReported?: boolean
  /**
   * Snapshot of the prompt composition sent in the last turn. Ephemeral (RAM
   * only); recomputed every turn by the `ReasoningPort`. Null until the first
   * turn of the session (a cold-load has no "current prompt" yet). See
   * `.specs/mcp-session-persistence/context-window-breakdown-plan.md`.
   */
  contextBreakdown?: ContextBreakdown
  /**
   * Dynamic-tool-loading (F3.1, LOCKED #6): the LATCHED `bridgeActive` decision
   * for this session. Computed once — on the first `DeferrableToolController.
   * refreshTools` of the session — and frozen thereafter so the advertised
   * `tools[]` stays byte-stable for the whole session (a new `TaskExecutor` is
   * built per task/turn, so the latch must live on the session-scoped
   * `Conversation`, not on the per-task controller instance).
   *
   * Ephemeral RAM only (like `activeTaskId` / `contextBreakdown`): NOT a DB
   * column and NOT rehydrated in `reconstruct.ts` (LOCKED #3 forbids DB/
   * migration state for dynamic tools). On a cold-load it is recomputed on the
   * first turn — fine, because the recompute reads the same flag+threshold and
   * the catalog is stable enough across a cold-load boundary. `undefined` means
   * "not yet latched".
   */
  dynamicToolsBridgeActive?: boolean
  /**
   * R2 — the user's saved per-provider model selection for this session, keyed
   * by provider id (`{ provider → model }`). Durable: mirrored to the
   * `sessions.model_selections` column and rehydrated on cold-load
   * (`reconstruct.ts`). The per-task resolver reads the entry for the Host's
   * active provider; if it is still permitted by the allowlist it becomes the
   * effective model, otherwise the resolver falls back to the Host default and
   * the GET /models projection surfaces it as `sessionModelBlocked`. A map (not
   * a scalar) so it stays forward-compatible with the fallback model (R5.4) and
   * a future cross-provider selector without another migration. Optional /
   * `undefined` ⇔ no selection (today's behaviour).
   */
  modelSelections?: Record<string, string>
}

/**
 * Snapshot of the prompt composition sent in the last turn. Ephemeral (RAM);
 * recomputed every turn by the `ReasoningPort`. See context-window-breakdown-plan.
 */
export interface ContextBreakdown {
  /** Raw per-bucket counts (local, countSync). Used as proportions. */
  buckets: {
    messages: number
    /**
     * Token cost of the advertised `tools[]` schemas. With dynamic-tool-loading
     * active (the stable bridge), this reflects natives + the 3 bridge tools
     * only — deferrable MCP schemas LEAVE this array and instead appear
     * transiently in `messages` via `clerum__tool_describe` / `clerum__tool_call`
     * outputs. So a sharp drop here when the bridge engages is expected, not a
     * breakdown bug.
     */
    systemTools: number
    metaContext: number
    systemPrompt: number
  }
  /** Authoritative provider total (lastObservedInputTokens); Σbuckets until available. */
  totalInputTokens: number
  /** Context window denominator (appConfig.contextMaxTokens). */
  maxTokens: number
  /**
   * 1-based index of the conversation turn (including the in-flight one) during
   * which this snapshot was last (re)captured. Turn-granular, NOT per-LLM-call:
   * `captureBreakdown` runs on every LLM call within a turn (initial + each tool
   * continuation) and overwrites the snapshot, but every overwrite of the same
   * turn records the same number. It counts the in-flight turn, so it is the
   * turn *being processed*, not "completed turns" — beware an off-by-one if ever
   * compared against a completed-turn count. Intended as a debug/staleness marker.
   */
  capturedAtTurn: number
}

/**
 * T1.4 — Per-task anti-thrash bookkeeping for `PressureContextManager`.
 *
 * After `INEFFECTIVE_MAX_RUN` consecutive compactions whose `post/pre` token
 * ratio exceeds `INEFFECTIVE_RATIO`, the manager stops attempting compaction
 * for the rest of the task. The existing budgets
 * (`CLERUM_AGENT_MAX_TOOL_CALLS`, `CLERUM_AGENT_MAX_TASK_DURATION`) terminate
 * the task; the context window error (if any) is surfaced as a clean
 * provider-level failure.
 */
export interface CompactionState {
  /** Last observed `post/pre` token ratio. `1.0` ≈ no reduction. */
  lastRatio: number
  /** Compactions in a row with `ratio > INEFFECTIVE_RATIO`. */
  ineffectiveCount: number
  /** True once we crossed the threshold and stopped compacting in this task. */
  stoppedForTask: boolean
}

export interface Turn {
  number: number
  user_input: string
  response?: string
  tool_calls: TurnToolCall[]
  started_at: Date
  completed_at?: Date
  /**
   * Per-turn token usage — the sum of every LLM call made while serving this
   * turn (tool-loop iterations + in-loop compaction). A RAM mirror accumulated
   * by `ConversationManager.recordSessionUsage` while the turn is in flight, and
   * rehydrated from the turn's persisted messages on cold-load (`reconstruct.ts`).
   * Undefined until the turn has had at least one LLM call. `cache_*` stay
   * undefined for providers that don't report cache.
   */
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}

export interface TurnToolCall {
  name: string
  parameters: Record<string, unknown>
  result?: string
  error?: string
  duration_ms?: number
  /** Lateral channel for T1.5 tool-result spillover. When the persisted
   *  `result` was spilled to disk, this carries the `clerum://spillover/...`
   *  URI so the in-memory consumer can swap in the live blob (or detect
   *  expiration). Mirrored from `ToolResult.spillover_ref`. */
  spillover_ref?: string
}

export interface PendingApproval {
  request_id: string
  tool_name: string
  /** Producer-owned governed replay classification; never inferred by Control UI. */
  tool_kind?: 'internal_tool' | 'mcp_server_tool' | 'workflow'
  /** Safe source reference such as an MCP server name or workflow recipe ref. */
  tool_source_ref?: string | null
  parameters: Record<string, unknown>
  description: string
  tool_call_id: string
  context_snapshot: ChatMessage[]
  /** Results for tools that completed before the suspended tool,
   *  plus synthetic errors for tools after the suspended one (F3). */
  completed_results?: ToolResult[]
  /** Attachments collected before suspension. Kept off the LLM message context
   *  but preserved across approval resume so response-file downloads survive. */
  attachments?: Attachment[]
  /** Intent summary (LLM's explanation of why this tool was called),
   *  captured at suspend time so resumeAfterApproval can preserve it on the
   *  re-emitted tool_start event. */
  intent_summary?: string
  /** Exact active-turn context retained while this approval is pending. */
  traceContext?: TraceContextV1 | null
}

// ─── Loop Types ─────────────────────────────────────────────

export type LoopResult =
  | { type: 'response'; content: string; usage: TokenUsage; attachments?: Attachment[] }
  | { type: 'need_approval'; approval: PendingApproval }
  | { type: 'error'; error: Error }
  | { type: 'exhaustion'; message: string; iterations: number; attachments?: Attachment[] }
  | { type: 'cancelled'; reason?: string }

export type AgentEventType =
  | 'state:changed'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'tool:called'
  | 'tool:completed'
  | 'tool:approval_needed'
  | 'tool:approval_granted'
  | 'tool:approval_denied'
  | 'loop:iteration'
  | 'loop:completed'
  | 'llm:completed'
  | 'safety:input_blocked'
  | 'safety:output_sanitized'
  | 'guardrail:decision'
  | 'context:compacted'
  | 'compaction:skipped'
  | 'compaction:thrashing'
  | 'compaction:pre_prune_executed'
  | 'spillover:persisted'

export interface AgentEvent {
  type: AgentEventType
  data: Record<string, unknown>
  timestamp: Date
}

// ─── IronClaw Approval Errors (P.3) ─────────────────────────

export interface ApprovalExpiredErrorPayload {
  code: 'approval_expired'
  request_id: string
  task_id: string
  tool_name: string
  /**
   * Failing spillover ref URIs (for ops/audit logs). Do NOT surface in
   * user-facing messages — the URI embeds task_id which could cross-leak
   * in multi-user log aggregators.
   */
  expired_refs: string[]
  /** User-facing message. Localizable downstream. */
  user_message: string
}

export class ApprovalExpiredError extends Error {
  constructor(public readonly payload: ApprovalExpiredErrorPayload) {
    super(payload.user_message)
    this.name = 'ApprovalExpiredError'
  }
}
