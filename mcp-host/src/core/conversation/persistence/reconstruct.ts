/**
 * Reconstruct a live `Conversation` from rows pulled out of the SQLite store.
 *
 * The on-disk shape is normalized (flat `messages` table). The in-memory
 * shape groups messages by `turn_number` to mirror `ConversationManager`'s
 * `Turn[]` representation.
 *
 * Anything ephemeral (`auto_approved_tools`, `compactionState`) is set to
 * empty defaults — by design (see T2.1 §11.3 and `aclaraciones/sqlite-persistence.md`).
 */
import type { MessageRow, PendingApprovalRow, PersistedSession } from '../../../db/worker/protocol'
import { deserializeCompletedResults } from '../../../db/worker/protocol'
import type {
  ChatMessage,
  Conversation,
  PendingApproval,
  TraceContextV1,
  Turn,
  TurnToolCall,
} from '../../types'
import { ConversationState, isTraceContextV1 } from '../../types'

function parseTraceContext(raw: string | null | undefined): TraceContextV1 | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isTraceContextV1(parsed) ? parsed : null
  } catch {
    return null
  }
}

export interface ReconstructResult {
  conversation: Conversation
  /** Highest ordinal seen in the messages table — used by the store to
   *  resume the per-session ordinal counter without scanning again. */
  highestOrdinal: number
  /** Highest turn_number seen — used to resume turn numbering. */
  highestTurnNumber: number
}

export function reconstructConversation(persisted: PersistedSession): ReconstructResult {
  const turns = groupMessagesIntoTurns(persisted.messages)
  const highestOrdinal = persisted.messages.reduce((acc, m) => Math.max(acc, m.ordinal), -1)
  const highestTurnNumber = turns.reduce((acc, t) => Math.max(acc, t.number), 0)

  let pending: PendingApproval | undefined
  if (persisted.pending_approval) {
    pending = reconstructPendingApproval(persisted.pending_approval)
  }

  const stateString = persisted.session.state || 'idle'
  const state = mapState(stateString)

  const startedAt = new Date(persisted.session.started_at * 1000)
  const lastActivityEpoch = persisted.messages.reduce(
    (latest, message) => Math.max(latest, message.timestamp),
    Math.max(
      persisted.session.started_at,
      persisted.session.last_activity_at ?? persisted.session.started_at
    )
  )
  const lastActivityAt = new Date(lastActivityEpoch * 1000)

  const conversation: Conversation = {
    id: persisted.session.id,
    session_key: persisted.session.session_key,
    user_id: persisted.session.user_id ?? '',
    state,
    turns,
    pending_approval: pending,
    auto_approved_tools: new Set(),
    created_at: startedAt,
    updated_at: lastActivityAt,
    // D.1 — repopulate the in-flight task from the durable column. After a pod
    // restart this may point at a task whose reporter is gone (ghost); the D.2
    // processing reaper reconciles that at boot.
    activeTaskId: persisted.session.active_task_id ?? undefined,
    traceContext:
      parseTraceContext(persisted.session.active_trace_context) ?? pending?.traceContext ?? null,
    // Lifetime token totals — rehydrate the RAM mirror from the durable columns.
    input_tokens: persisted.session.input_tokens,
    output_tokens: persisted.session.output_tokens,
    cache_read_tokens: persisted.session.cache_read_tokens,
    cache_write_tokens: persisted.session.cache_write_tokens,
    // Durable sticky flag (migration 006): 1 once any call reported cache. Read
    // it directly rather than (lossily) deriving from cache_*_tokens > 0, which
    // dropped to "no cache" after a restart for sessions whose lifetime cache
    // totals stayed 0 (e.g. prompt-cache disabled → Anthropic returns 0/0).
    cacheTokensReported: persisted.session.cache_tokens_reported === 1,
    // R2 (migration 007) — rehydrate the per-session model selection map so the
    // per-task resolver honours a saved choice after a pod restart. Read-plumbing
    // previously died at this store→Conversation frontier; parse it here.
    modelSelections: parseModelSelections(persisted.session.model_selections),
  }

  return { conversation, highestOrdinal, highestTurnNumber }
}

/**
 * Parse the persisted `model_selections` JSON into a `{ provider → model }`
 * map. Tolerant: NULL / malformed / non-object JSON → undefined (no selection),
 * which the resolver reads as "fall back to the Host-configured model". Only
 * string values survive, so a corrupted row can never inject a non-string model
 * into the resolver.
 */
function parseModelSelections(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const out: Record<string, string> = {}
    for (const [provider, model] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof model === 'string' && model.length > 0) out[provider] = model
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

export function reconstructPendingApproval(row: PendingApprovalRow): PendingApproval {
  const snapshot = JSON.parse(row.context_snapshot) as ChatMessage[]
  return {
    request_id: row.request_id,
    tool_name: row.tool_name,
    parameters: JSON.parse(row.parameters) as Record<string, unknown>,
    description: row.description,
    tool_call_id: row.tool_call_id,
    context_snapshot: snapshot,
    completed_results: deserializeCompletedResults(row.completed_results),
    intent_summary: row.intent_summary ?? undefined,
    traceContext: parseTraceContext(row.trace_context),
  }
}

function mapState(raw: string): ConversationState {
  switch (raw) {
    case 'idle':
      return ConversationState.Idle
    case 'processing':
      return ConversationState.Processing
    case 'awaiting_approval':
      return ConversationState.AwaitingApproval
    default:
      return ConversationState.Idle
  }
}

export function groupMessagesIntoTurns(messages: MessageRow[]): Turn[] {
  const byTurn = new Map<number, Turn>()
  for (const m of messages) {
    const turnNum = m.turn_number ?? 0
    let turn = byTurn.get(turnNum)
    if (!turn) {
      turn = {
        number: turnNum,
        user_input: '',
        tool_calls: [],
        started_at: new Date(m.timestamp * 1000),
      }
      byTurn.set(turnNum, turn)
    }
    // Sum per-turn token usage across the turn's messages (today only the final
    // assistant message carries it; summing is robust if that ever changes).
    // Per-field nullability is preserved: an unreported cache column (NULL) stays
    // undefined on the Turn, matching the hot-path RAM attribution (so a provider
    // that omits cache reads identically hot and cold). A genuine 0 is summed.
    //
    // Known limitation: compaction's `replace_messages` rewrites the message set
    // with summary rows that carry no per-turn token columns, so on cold-load the
    // per-turn breakdown for COMPACTED turns is lost (the columns are NULL). The
    // session-level totals (`sessions.*_tokens`) are unaffected by compaction, so
    // the lifetime number stays correct; only the per-message label goes dark.
    if (m.input_tokens != null) turn.input_tokens = (turn.input_tokens ?? 0) + m.input_tokens
    if (m.output_tokens != null) turn.output_tokens = (turn.output_tokens ?? 0) + m.output_tokens
    if (m.cache_read_tokens != null) {
      turn.cache_read_tokens = (turn.cache_read_tokens ?? 0) + m.cache_read_tokens
    }
    if (m.cache_write_tokens != null) {
      turn.cache_write_tokens = (turn.cache_write_tokens ?? 0) + m.cache_write_tokens
    }
    if (m.role === 'user') {
      turn.user_input = m.content ?? ''
      turn.started_at = new Date(m.timestamp * 1000)
    } else if (m.role === 'assistant') {
      if (m.tool_calls) {
        const parsed = safeParseToolCalls(m.tool_calls)
        for (const tc of parsed) {
          const call: TurnToolCall = {
            name: tc.name ?? 'unknown',
            parameters: (tc.arguments as Record<string, unknown>) ?? {},
          }
          turn.tool_calls.push(call)
        }
      } else {
        turn.response = m.content ?? ''
        turn.completed_at = new Date(m.timestamp * 1000)
      }
    } else if (m.role === 'tool') {
      // Attach to the last tool_call with matching name. The mcp-host loop
      // emits tool messages in the same order as the assistant.tool_calls
      // they answer, so the position lookup is sufficient.
      const target = turn.tool_calls.find(
        c => c.name === m.tool_name && c.result === undefined && c.error === undefined
      )
      if (target) {
        if (m.is_error) target.error = m.content ?? ''
        else target.result = m.content ?? ''
        // B8 fix — propagate the persisted spillover_ref back to the
        // in-memory TurnToolCall so consumers can detect the lateral.
        if (m.spillover_ref) target.spillover_ref = m.spillover_ref
      }
    }
  }
  return [...byTurn.values()].sort((a, b) => a.number - b.number)
}

interface ParsedToolCall {
  name?: string
  arguments?: unknown
}

function safeParseToolCalls(raw: string): ParsedToolCall[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as ParsedToolCall[]
    return []
  } catch {
    return []
  }
}
