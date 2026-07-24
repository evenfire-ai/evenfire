/**
 * R2 — one selectable model in the `GET /v1/runtime/models` projection. Mirrors
 * the enabled allowlist entry for the Host's provider; `models` is `[hostDefault]`
 * (name only) when the allowlist is unavailable (`degraded`).
 */
import type { ModelWireEntry } from '../config/modelResolution.js'
import type { ApprovalDecision } from '../core/extensions/approvalTypes'
import type { Attachment, TraceContextV1 } from '../core/types'
import type { McpServerStatusEntry } from '../mcp/serverStatus'
import type { TaskError } from '../queue/types'

export interface ProviderIdentity {
  medium: 'telegram' | 'slack' | 'teams'
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId: string
  providerChannelType?: string | null
  providerEventId?: string
  providerTarget?: {
    hostRef: string
    communicationChannelNamespace: string
    communicationChannelName: string
    providerBotId?: string | null
    providerBotUsername?: string | null
  }
}

export interface ProviderDecisionIdentity extends ProviderIdentity {
  providerEventId: string
}

export interface IncomingMessage {
  content: string
  channelType: 'telegram' | 'email' | 'slack' | 'teams' | 'rpc'
  channelId: string
  sender: string
  timestamp: string
  messageId: string
  hostRef: string
  threadId?: string
  attachments?: Attachment[]
  metadata?: Record<string, unknown>
  providerIdentity?: ProviderIdentity
  traceContext?: TraceContextV1 | null
  /**
   * R2 — optional per-session model that rides WITH the message. Because a
   * suspended Host (replicas=0) cannot serve `POST /v1/runtime/model`, the
   * desktop piggybacks the user's pick here so it is applied to THIS task when
   * the message wakes the Host. Only honoured for the `rpc` channel; a
   * non-allowlisted value is ignored (fail-open on the message).
   */
  model?: string
}

export type RuntimeCallerKind = 'rpc-proxy' | 'channel-reader' | 'workflow-approval-request-reader'

export interface RuntimeCallerContext {
  caller: RuntimeCallerKind
  hostRef?: string
  requestId?: string
  userId?: string
  teamId?: string
  channelType?: string
  channelId?: string
  sender?: string
}

export interface MessageResponse {
  success: boolean
  status?: 'completed' | 'waiting_approval' | 'pending'
  response?: string
  attachments?: Attachment[]
  error?: TaskError
  model?: string
  taskId?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  approval?: {
    taskId: string
    requestId: string
    userId: string
    notification: string
  }
}

export interface StatusResponse {
  agent: {
    state: string
    currentTaskId: string | null
    tasksProcessed: number
    tasksSucceeded: number
    tasksFailed: number
    uptime: number
  }
  queue: {
    pending: number
    processing: number
    completed: number
    failed: number
  }
  cronJobs: number
  pendingApprovals?: Array<{
    requestId: string
    userId: string
    toolName: string
    parameters: Record<string, unknown>
    description: string
    since: string
  }>
  /**
   * Per-MCP-server health snapshot (spec §4.2). Omitted by older mcp-host
   * builds; consumers MUST treat absence as "unknown for every server".
   */
  mcpServers?: McpServerStatusEntry[]
  /**
   * When set, the Host is degraded and refusing new tasks. Consumers should
   * surface this in status banners and disable the chat composer while it
   * is non-null. Currently the only reason emitted is `llm_key_missing`,
   * raised when the referenced LLM Secret is missing or lacks the
   * provider-matching key.
   */
  degraded?: {
    reason: 'llm_key_missing'
    message: string
  } | null
  /**
   * R2 — the Host's configured (default) provider + model. Optional for
   * forward/backward compat (older builds omit it; consumers treat absence as
   * "unknown"). This is the Host DEFAULT, not a per-session selection — the
   * per-session model is served by `GET /v1/runtime/models`.
   */
  model?: {
    provider: string
    name: string
  }
  /**
   * R5 — the provider/model pair currently SERVING the Host. Present only when a
   * failover policy is configured; `fallback: true` means a configured fallback
   * entry is serving (the desktop shows an "operating with fallback" badge). On
   * lazy recovery the engine flips `fallback` back to false. Optional for
   * forward/backward compat (older builds / no-policy Hosts omit it).
   *
   * `name` is a DELIBERATE alias of the served model (it mirrors the field name
   * of `StatusResponse.model.name`, not the engine's `ModelPair.model`), so the
   * desktop reads the same `.name` shape for the default model and the served
   * pair.
   */
  servedBy?: {
    provider: string
    name: string
    fallback: boolean
  }
}

export type HostActivitySeverity = 'info' | 'warn' | 'error'

export type HostActivityType =
  | 'task.queued'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'llm.requested'
  | 'llm.responded'
  | 'llm.failed'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.denied'
  | 'safety.input_blocked'
  | 'safety.output_sanitized'
  | 'queue.depth.changed'
  | 'agent.state.changed'
  // IronClaw invariant #1 (P.3): emitted whenever PressureContextManager.manage()
  // is bypassed by the loop because the conversation has a pending_approval.
  | 'compaction.skipped'
  // T1.4: emitted exactly once per task when consecutive compactions stop
  // yielding token savings and the manager switches to backoff.
  | 'compaction.thrashing'
  // T1.2: emitted whenever pre-prune (deterministic LLM-free compaction)
  // ran and reclaimed tokens. `meta` carries pre/post token counts and the
  // list of passes that actually mutated something.
  | 'compaction.pre_prune_executed'

export interface HostActivityEvent {
  version: '1.0'
  eventId: string
  hostRef: string
  ts: string
  taskId?: string
  type: HostActivityType
  title: string
  severity: HostActivitySeverity
  meta: Record<string, unknown>
  redactions: string[]
}

export interface HostActivitySnapshotResponse {
  hostRef: string
  version: '1.0'
  items: HostActivityEvent[]
  nextCursor: string | null
}

export type MessageHandler = (
  message: IncomingMessage,
  options?: { async?: boolean }
) => MessageResponse | Promise<MessageResponse>
export type StatusHandler = () => Promise<StatusResponse>
export type ActivitySnapshotHandler = (
  limit: number,
  sinceEventId?: string
) => Promise<HostActivitySnapshotResponse>
export type ActivityStreamHandler = (onEvent: (event: HostActivityEvent) => void) => {
  hostRef: string
  unsubscribe: () => void
}
export type ApprovalHandler = (
  decision: ApprovalDecision
) => Promise<{ success: boolean; error?: string }>
export interface ProviderWorkflowApprovalDecision {
  approvalRequestId: string
  decision: 'approve' | 'deny'
  providerIdentity: ProviderDecisionIdentity
  note?: string | null
}
export interface ProviderWorkflowApprovalResolve {
  recipeName: string
  providerIdentity: ProviderIdentity
}
export interface ProviderWorkflowResultRequest {
  workflowName?: string
  workflowRunId?: string
  artifactName?: string
  providerIdentity: ProviderIdentity
  source: {
    channelType: 'telegram' | 'slack' | 'teams'
    channelId: string
    sender: string
    messageId: string
    timestamp: string
    threadId?: string
  }
}
export interface ProviderMessageAuthorization {
  providerIdentity: ProviderIdentity
}
export type WorkflowApprovalNotificationMedium = 'telegram' | 'slack' | 'teams'
export interface WorkflowApprovalNotificationClaim {
  medium: WorkflowApprovalNotificationMedium
  providerChannelIds: string[]
  providerWorkspaceId?: string | null
  hostRef: string
  limit: number
}
export type WorkflowApprovalNotificationDelivery = {
  id: string
  medium: WorkflowApprovalNotificationMedium
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId: string
  attempts: number
  eventType: 'approval.requested' | 'approval.updated' | 'workflow.run.completed'
  payload: Record<string, unknown>
}
export interface WorkflowApprovalNotificationTerminal {
  medium: WorkflowApprovalNotificationMedium
  providerUserId: string
  providerChannelId: string
  providerWorkspaceId?: string | null
  hostRef: string
}
export interface TelegramWorkflowApprovalVerification {
  code: string
  providerUserId: string
  providerChannelId: string
  providerChannelType: string
  providerTarget: {
    hostRef: string
    communicationChannelNamespace: string
    communicationChannelName: string
    providerBotId?: string | null
    providerBotUsername?: string | null
  }
  providerTargets?: Array<{
    hostRef: string
    communicationChannelNamespace: string
    communicationChannelName: string
    providerBotId?: string | null
    providerBotUsername?: string | null
  }>
}
export interface WorkflowApprovalMediumEnrollment {
  nonce: string
  medium: 'telegram' | 'slack' | 'teams'
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId: string
  providerChannelType?: string | null
  serviceUrl?: string | null
  communicationChannelRef?: string | null
}
export type WorkflowApprovalMediumEnrollmentHandler = (
  input: WorkflowApprovalMediumEnrollment
) => Promise<{ ok: boolean; error?: string; account?: unknown }>
export type ProviderWorkflowApprovalDecisionHandler = (
  decision: ProviderWorkflowApprovalDecision
) => Promise<{
  success: boolean
  duplicate?: boolean
  status?: string
  run?: Record<string, unknown> | null
  error?: string
}>
export type ProviderWorkflowApprovalResolveHandler = (
  input: ProviderWorkflowApprovalResolve
) => Promise<
  | { status: 'found'; approvalRequestId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous' }
  | { status: 'error'; error: string }
>
export type ProviderWorkflowResultRequestHandler = (
  input: ProviderWorkflowResultRequest,
  caller?: RuntimeCallerContext
) => Promise<MessageResponse>
export type ProviderMessageAuthorizationHandler = (
  input: ProviderMessageAuthorization
) => Promise<{ authorized: boolean }>
export type WorkflowApprovalNotificationClaimHandler = (
  input: WorkflowApprovalNotificationClaim
) => Promise<{ deliveries: WorkflowApprovalNotificationDelivery[] } | { error: string }>
export type WorkflowApprovalNotificationTerminalHandler = (
  id: string,
  action: 'ack' | 'fail',
  input: WorkflowApprovalNotificationTerminal
) => Promise<{ ok: boolean; error?: string }>
export type TelegramWorkflowApprovalVerificationHandler = (
  input: TelegramWorkflowApprovalVerification
) => Promise<{ ok: true; accountId: string } | { ok: false; error: string }>
export type TaskResultHandler = (
  taskId: string,
  caller?: RuntimeCallerContext
) => Promise<MessageResponse | null>
export type CronResultsHandler = (caller?: RuntimeCallerContext) => Array<{
  id: string
  origin: { channelType: string; channelId: string; sender: string }
  response: string
  attachments?: Attachment[]
  cronJobId: string
  cronJobName: string
  timestamp: Date
  status?: 'completed' | 'waiting_approval'
  approval?: { taskId: string; requestId: string; userId: string }
}>
export type CronResultAckHandler = (taskId: string, caller?: RuntimeCallerContext) => boolean
export type ProgressStreamHandler = (
  taskId: string,
  onEvent: (event: import('../progress/types.js').ProgressEvent) => void,
  caller?: RuntimeCallerContext
) => { unsubscribe: () => void } | null | Promise<{ unsubscribe: () => void } | null>

/**
 * Result of a cancel attempt.
 *
 * - `cancelled`: task was pending/processing and has been cancelled
 * - `already_terminal`: task existed but was already completed/failed/cancelled (idempotent no-op)
 * - `not_found`: task not found in any state
 */
export type CancelResult = 'cancelled' | 'already_terminal' | 'not_found'

/**
 * Handler for POST /v1/runtime/tasks/:taskId/cancel.
 *
 * Receives the taskId, an optional requesterUserId (from request body,
 * mirrors approve/deny pattern), and returns whether the task was found
 * and cancelled, was already in a terminal state, or was not found at all.
 *
 * Ownership check: if the record carries a submittedBy identity AND
 * requesterUserId is provided AND they differ,
 * the handler returns 'not_found' (not 403 — don't leak task existence).
 * Fail-open when either side is absent for back-compat.
 */
export type CancelHandler = (
  taskId: string,
  requesterUserId?: string
) => CancelResult | Promise<CancelResult>

/**
 * T1.1 — POST /v1/runtime/compact. Operator-triggered compaction with an
 * optional focus topic. The handler is responsible for:
 *   - resolving the sessionKey to a Conversation,
 *   - rejecting when an approval is pending (IronClaw invariant #1),
 *   - constructing or reusing a PressureContextManager,
 *   - emitting `context:compacted` on success.
 *
 * The endpoint translates the discriminated result into HTTP status codes:
 *   `ok` → 200, `not_found` → 404, `pending_approval` → 409,
 *   `session_busy` → 409, `error` → 500.
 */
export type CompactionResult =
  | {
      kind: 'ok'
      before: number
      after: number
      focus: string | null
    }
  | { kind: 'not_found' }
  | { kind: 'pending_approval' }
  | { kind: 'session_busy' }
  | { kind: 'error'; message: string }

export type CompactionHandler = (request: {
  sessionKey: string
  focus?: string
  useMainLlm?: boolean
}) => Promise<CompactionResult>

/**
 * T3.1 — Handler for GET /v1/runtime/sessions/search.
 * `userSub` is the verified JWT identity; callers MUST derive it from the
 * request's `auth.sub`, never from query params. The handler reuses the same
 * `SessionSearchService` that drives the native tool, so the result shape is
 * identical across both surfaces.
 */
export interface SessionSearchRequest {
  userSub: string
  query: string
  scope: 'this_channel' | 'all_channels'
  channelType?: string
  since?: string
  limit: number
}

export interface SessionSearchResponse {
  results: Array<{
    snippet: string
    session_id: string
    timestamp: string
    channel: string
    role: string
  }>
  total: number
}

export type SessionSearchHandler = (
  request: SessionSearchRequest
) => SessionSearchResponse | Promise<SessionSearchResponse>

/**
 * D.1 — session liveness exposed to the desktop. `state` drives sidebar badges;
 * `activeTaskId` is the task to re-subscribe to (present when state ≠ idle);
 * `pendingApproval` lets the client render the approve button without waiting
 * for the SSE. NOTE: `tool_name` is intentionally NOT exposed (security patch
 * P1-1) — only the human-readable `displayName` derived server-side.
 */
/**
 * Lifetime token totals for a session, surfaced to the desktop. `cacheRead` /
 * `cacheWrite` are present ONLY when the model reports cache info (Anthropic);
 * absent for providers that don't (OpenAI / zai / bailian) so the UI shows the
 * 2-figure or 4-figure breakdown accordingly.
 */
export interface SessionTokensWire {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface SessionStateWire {
  state: 'idle' | 'processing' | 'awaiting_approval'
  activeTaskId?: string
  pendingApproval?: { requestId: string; displayName: string }
  /** Lifetime token totals; omitted when the session has had no LLM call yet. */
  tokens?: SessionTokensWire
}

/**
 * Handler for GET /v1/runtime/sessions — list this user's desktop conversations.
 * Receives the authenticated user's sub (canonical user ID) and returns a list
 * suitable for the sidebar.
 */
export type SessionsListItem = {
  agent: string
  chatId: string
  turnCount: number
  lastActivityAt: string
} & SessionStateWire

export type SessionsListQuery = {
  limit?: number
  cursor?: string
}

export type SessionsListResult = {
  items: SessionsListItem[]
  nextCursor?: string
}

export type SessionsListHandler = (
  userSub: string,
  query: SessionsListQuery
) => SessionsListResult | Promise<SessionsListResult>

/**
 * A single tool call within a turn, projected for the desktop progress stepper
 * (the "More details · N tools" view) so it survives a reload / cold-load. Mirrors
 * the minimal subset the live SSE `tool_complete` exposes — NEVER the raw
 * arguments or tool output (P1-1): `displayName` is derived server-side via
 * `getDisplayName`, and `errorSummary` is redacted at projection time (secret-scrub
 * + stack/path strip + truncate), matching the live SSE path.
 */
export type TurnToolStepWire = {
  toolName: string
  displayName: string
  state: 'completed' | 'error'
  durationMs?: number
  errorSummary?: string
}

/**
 * Handler for GET /v1/runtime/sessions/:agent/:chatId/messages — transcript for one session.
 * Returns null if the session does not exist for this user (which the route translates to 404).
 */

export type SessionMessagesResult = {
  agent: string
  chatId: string
  totalTurns: number
  oldestTurnNumber?: number
  latestTurnNumber?: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  revision: string
  turns: Array<{
    number: number
    user_input: string
    response?: string
    started_at: string
    completed_at?: string
    /** Per-turn token usage; omitted for a turn with no recorded LLM usage. */
    tokens?: SessionTokensWire
    /** Tools used in the turn; omitted when the turn made no tool calls. */
    tool_steps?: TurnToolStepWire[]
  }>
} & SessionStateWire

export type SessionMessagesQuery = {
  limit?: number
  beforeTurn?: number
  afterTurn?: number
}

export type SessionMessagesHandler = (
  userSub: string,
  agent: string,
  chatId: string,
  query: SessionMessagesQuery
) => SessionMessagesResult | null | Promise<SessionMessagesResult | null>

/**
 * Snapshot of the prompt composition sent in the last turn, surfaced to the
 * desktop on-demand. `cacheHitRate` is present ONLY when the model reported
 * cache info (`cacheTokensReported` — Anthropic); absent otherwise (#11).
 * See `.specs/mcp-session-persistence/context-window-breakdown-plan.md`.
 */
export interface ContextBreakdownWire {
  buckets: { messages: number; systemTools: number; metaContext: number; systemPrompt: number }
  totalInputTokens: number
  maxTokens: number
  /** totalInputTokens / maxTokens (0 when maxTokens is 0). */
  fillRatio: number
  /** cache_read / (cache_read + input); only when cacheTokensReported (#11). */
  cacheHitRate?: number
  /**
   * Turn-granular staleness marker: the 1-based conversation turn (including the
   * in-flight one) during which the snapshot was last captured. Not per-LLM-call
   * — it stays constant across the multiple captures within a turn. See
   * `ContextBreakdown.capturedAtTurn` in core/types.ts.
   */
  capturedAtTurn: number
}

/**
 * Handler for GET /v1/runtime/sessions/:agent/:chatId/context-breakdown.
 * Returns `{ breakdown: null }` when the session has no snapshot yet, and
 * (like the messages handler) `null` when the session does not exist for this
 * user — which the route translates to the SAME 404 (anti-enumeration).
 */
export type ContextBreakdownResult = { breakdown: ContextBreakdownWire | null }

export type ContextBreakdownHandler = (
  userSub: string,
  agent: string,
  chatId: string
) => ContextBreakdownResult | null | Promise<ContextBreakdownResult | null>

export type RuntimeModelEntry = ModelWireEntry

/**
 * Result of `GET /v1/runtime/models?chatId=…`. `sessionModel` is the session's
 * saved-and-still-allowed selection (null when unset or when it fell back);
 * `sessionModelBlocked` carries the stale saved model when it is no longer
 * allowed. `degraded` → allowlist unavailable, `models` collapses to the Host
 * default. `hostDefault` is the Host-configured default model.
 */
export interface ModelsListResult {
  provider: string
  hostDefault: string
  sessionModel: string | null
  sessionModelBlocked?: string
  degraded: boolean
  models: RuntimeModelEntry[]
}

export type ModelsListHandler = (
  userSub: string,
  hostRef: string,
  chatId: string | undefined
) => ModelsListResult | Promise<ModelsListResult>

/**
 * Result of `POST /v1/runtime/model`. `ok` → 200 `{ effective:'next-task', … }`;
 * `model_not_allowed` → 403. The route owns the 400 (missing chatId/model).
 */
export type SetModelResult =
  | { ok: true; provider: string; model: string }
  | { ok: false; reason: 'model_not_allowed'; provider: string; model: string }

export type SetModelHandler = (
  userSub: string,
  hostRef: string,
  chatId: string,
  model: string
) => SetModelResult | Promise<SetModelResult>
