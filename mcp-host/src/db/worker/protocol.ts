/**
 * Wire protocol between the main thread (`PersistQueue`) and the SQLite
 * worker thread (`dbWorker.ts`). The schemas live here so both sides import
 * the same source of truth.
 *
 * `id` is a UUID correlation id; `op` is the discriminated union the
 * dispatcher switches on. Replies use `ok=true|false` with optional
 * `error`/`result` payloads.
 */
import type { ChatMessage, PendingApproval, ToolResult } from '../../core/types'

// ─── Row shapes (DB-side representation) ───────────────────────────────

export interface SessionRow {
  id: string
  session_key: string
  source: string
  user_id: string | null
  team_id: string | null
  channel_type: string | null
  channel_id: string | null
  thread_id: string | null
  /** Effective model of the FIRST task that created the row (INSERT-time
   *  telemetry, migration 007); NOT updated on a later mid-session swap —
   *  do not read it as "current model". Was always NULL before R2. */
  model: string | null
  /** R2 (migration 007) — JSON map `{ provider → model }` of the user's saved
   *  per-provider model selection. NULL until the first `set-model`. */
  model_selections: string | null
  system_prompt_stable_hash: string | null
  parent_session_id: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  /** 1 once any LLM call in this session reported cache info (Anthropic), 0
   *  otherwise (OpenAI/zai/bailian). Sticky — never flips back to 0. */
  cache_tokens_reported: number
  title: string | null
  state: string
  /** D.1 — task currently in flight for this session, or null when idle. */
  active_task_id: string | null
  /** Trace context for the active task only; null for idle and legacy sessions. */
  active_trace_context: string | null
}

export interface MessageRow {
  id?: number
  session_id: string
  ordinal: number
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  content_parts: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  spillover_ref: string | null
  is_error: 0 | 1
  turn_number: number | null
  /**
   * Per-turn token usage (migration 005). Set only on the final/cancel assistant
   * message of a turn; NULL on every other row. Optional on the in-memory shape
   * so callers that don't stamp usage omit them (the dispatcher binds NULL).
   */
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_tokens?: number | null
  cache_write_tokens?: number | null
}

export interface PendingApprovalRow {
  request_id: string
  session_id: string
  task_id: string
  tool_name: string
  tool_call_id: string
  parameters: string
  description: string
  context_snapshot: string
  completed_results: string | null
  intent_summary: string | null
  source_message: string | null
  registered_at: number
  expires_at: number
  trace_context: string | null
}

export interface SessionCountersUpdate {
  messageCountDelta?: number
  toolCallCountDelta?: number
  inputTokensDelta?: number
  outputTokensDelta?: number
  cacheReadTokensDelta?: number
  cacheWriteTokensDelta?: number
  /** When true, marks `cache_tokens_reported = 1` (sticky OR). Set by
   *  persistSessionUsage when the provider reported cache fields for the call. */
  cacheReported?: boolean
}

export interface PersistedSession {
  session: SessionRow
  messages: MessageRow[]
  pending_approval: PendingApprovalRow | null
}

export interface PersistedSessionSummary {
  session: SessionRow
  last_activity_at: number
  turn_count: number
  pending_approval: Pick<PendingApprovalRow, 'request_id' | 'tool_name'> | null
}

export interface LoadAllPendingApprovalsRow {
  approval: PendingApprovalRow
  session_key: string
}

/**
 * T3.1 — row shape returned by `fts_search_messages`. Mirrors the result shape
 * exposed by both `clerum__session_search` (tool) and `/v1/runtime/sessions/search`
 * (REST). All columns are populated server-side from `sessions` + `messages` so
 * the consumer never gets to choose the `user_id` filter.
 */
export interface SearchMessageRow {
  snippet: string
  session_id: string
  timestamp: number
  channel: string | null
  role: string
}

// ─── In-memory shape returned by reconstruct helpers ──────────────────

export interface RehydratedSnapshot {
  sessionKey: string
  taskId: string
  requestId: string
  approval: PendingApproval
  sourceMessage: Record<string, unknown> | null
}

// ─── Operations ───────────────────────────────────────────────────────

export type WorkerOp =
  | { kind: 'ping' }
  | { kind: 'insert_session'; payload: SessionRow }
  | {
      kind: 'update_session_state'
      sessionId: string
      state: string
      endedAt?: number | null
      endReason?: string | null
      /**
       * D.1 — undefined = keep current active_task_id (COALESCE),
       * a string = set it, null = clear it (dedicated statement).
       */
      activeTaskId?: string | null
      /** undefined = keep, string = set, null = clear. */
      activeTraceContext?: string | null
    }
  | { kind: 'reap_processing_sessions'; nowEpoch: number; chunkSize?: number }
  | {
      kind: 'reap_awaiting_approval_sessions'
      nowEpoch: number
      chunkSize?: number
      /**
       * S1 — when true, reap EVERY 'awaiting_approval' session (live or expired),
       * not just those whose approval has expired/orphaned. Used by the boot
       * reaper because no awaiting_approval session is resumable after a restart.
       * The synthetic message + error_code differ between the two modes. Default
       * (false/undefined) keeps the expired-only behaviour.
       */
      includeLive?: boolean
    }
  | { kind: 'update_session_counters'; sessionId: string; counters: SessionCountersUpdate }
  | { kind: 'update_session_prompt_stable_hash'; sessionId: string; stableHash: string }
  | {
      /** R2 — persist the per-session `{ provider → model }` selection map.
       *  `modelSelections` is the already-serialized JSON string. */
      kind: 'update_session_model_selections'
      sessionId: string
      modelSelections: string
    }
  | { kind: 'insert_message'; payload: MessageRow }
  | {
      /**
       * D3 (stateless-agents) — a turn boundary: the boundary message (user
       * message at turn start / assistant message at turn complete) and the
       * session-state flip commit in ONE SQLite transaction. A crash between
       * the two writes can therefore never leave `active_task_id` pointing at
       * a task whose boundary message is absent (or vice versa) — the pair is
       * all-or-nothing on disk.
       */
      kind: 'persist_turn_boundary'
      message: MessageRow
      sessionId: string
      state: string
      /**
       * Same semantics as `update_session_state.activeTaskId`:
       * undefined = keep current, a string = set it, null = clear it.
       */
      activeTaskId?: string | null
      /** Same keep/set/clear semantics as update_session_state. */
      activeTraceContext?: string | null
    }
  | { kind: 'replace_messages'; sessionId: string; messages: MessageRow[] }
  | { kind: 'insert_pending_approval'; payload: PendingApprovalRow }
  | { kind: 'delete_pending_approval'; requestId: string }
  | { kind: 'load_active_session'; sessionKey: string }
  | { kind: 'list_sessions_by_prefix'; sessionKeyPrefix: string }
  | {
      kind: 'list_session_summaries_by_prefix'
      sessionKeyPrefix: string
      limit?: number
      cursorUpdatedAt?: number
      cursorKey?: string
    }
  | { kind: 'load_all_pending_approvals' }
  | { kind: 'sweep_expired'; nowEpoch: number; ttlSeconds: number }
  | { kind: 'fts_search'; query: string; limit: number; userId?: string }
  | {
      kind: 'fts_search_messages'
      query: string
      userId: string
      channelType?: string
      since?: string
      limit: number
    }
  | { kind: 'sweep_closed_sessions'; cutoffEpoch: number }
  | { kind: 'integrity_check' }
  | { kind: 'checkpoint' }
  | { kind: 'shutdown' }

export interface WorkerMessage {
  id: string
  op: WorkerOp
}

/**
 * D.2 — one entry per session the processing reaper transitioned from
 * 'processing' to 'idle' at boot (its task's reporter died with the previous
 * pod). Uses the columns that actually exist on `sessions` (NOT agent/chatId,
 * which aren't part of the session_key — cross-ref D.2 P1).
 */
export interface ReapedSession {
  sessionId: string
  sessionKey: string
  userId: string | null
  channelType: string | null
  channelId: string | null
  threadId: string | null
  activeTaskId: string | null
  reapedAt: number
}

export interface WorkerReply<T = unknown> {
  id: string
  ok: boolean
  error?: { code: string; message: string; stack?: string }
  result?: T
}

/** Internal heartbeat payload — uses a sentinel id. */
export const HEARTBEAT_ID = '__heartbeat__'

export interface HeartbeatPayload {
  kind: 'heartbeat'
  writesSinceCheckpoint: number
  dbBytes: number
  walBytes: number
}

export function isWriteOp(op: WorkerOp): boolean {
  switch (op.kind) {
    case 'insert_session':
    case 'update_session_state':
    case 'update_session_counters':
    case 'update_session_prompt_stable_hash':
    case 'update_session_model_selections':
    case 'insert_message':
    case 'persist_turn_boundary':
    case 'replace_messages':
    case 'insert_pending_approval':
    case 'delete_pending_approval':
    case 'reap_processing_sessions':
    case 'reap_awaiting_approval_sessions':
    case 'sweep_expired':
    case 'sweep_closed_sessions':
      return true
    default:
      return false
  }
}

// ─── Helpers for ChatMessage / ToolResult serialization ────────────────

export function serializeContextSnapshot(snapshot: ChatMessage[]): string {
  return JSON.stringify(snapshot)
}

export function deserializeContextSnapshot(raw: string): ChatMessage[] {
  return JSON.parse(raw) as ChatMessage[]
}

export function serializeCompletedResults(results: ToolResult[] | undefined): string | null {
  if (!results || results.length === 0) return null
  return JSON.stringify(results)
}

export function deserializeCompletedResults(raw: string | null): ToolResult[] | undefined {
  if (!raw) return undefined
  return JSON.parse(raw) as ToolResult[]
}
