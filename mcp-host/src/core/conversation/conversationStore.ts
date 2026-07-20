import type { ReapedSession } from '../../db/worker/protocol'
import type { Conversation, PendingApproval, TurnToolCall } from '../types'

/**
 * Token usage from a SINGLE LLM call, accumulated additively into the durable
 * per-session counters (`sessions.input_tokens` / `output_tokens` /
 * `cache_read_tokens` / `cache_write_tokens`).
 *
 * `cache_*` are intentionally `number | undefined` (NOT normalized to 0):
 * `undefined` ⇔ the provider does not report cache info (OpenAI / zai / bailian),
 * a number (0 or +) ⇔ it does (Anthropic). This distinction drives whether the
 * desktop shows the cache breakdown — see `Conversation.cacheTokensReported`.
 * Normalization to 0 happens only at the SQLite boundary (NOT NULL columns).
 */
export interface SessionTokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}

/**
 * Optional metadata supplied by callers when creating a new session. Lets
 * the durable store project the sessionKey into indexable columns
 * (user_id, channel_type, channel_id, thread_id, source, team_id). All
 * fields are optional — the in-memory store ignores them; the SQLite store
 * derives any missing pieces from the sessionKey itself.
 */
export interface GetOrCreateOptions {
  userId?: string
  channelType?: string
  channelId?: string
  threadId?: string
  source?: string
  teamId?: string | null
  model?: string
}

export interface PersistedSessionListing {
  sessionKey: string
  approval: PendingApproval
  taskId: string
  sourceMessage?: Record<string, unknown>
  /** Absolute expiration time in epoch milliseconds, from the persisted
   *  `expires_at` column. Surfaced here (rather than on `PendingApproval`)
   *  because the TTL is a persistence concern; in-memory approvals enforce
   *  expiration via the agent's timer instead. Consumed by
   *  `SqliteColdStartLoader` for the B7 TTL filter. */
  expiresAt?: number
}

export type EvictCallback = (sessionKey: string, conversation: Conversation) => void

/**
 * Storage-level abstraction for the session-keyed conversation map.
 *
 * The interface is intentionally mixed sync + async:
 *
 *  - **Sync hot path**: `get/set/has/listByPrefix/pin/unpin` hit the RAM
 *    cache only. `get` returns `undefined` on a cache miss; cold callers
 *    must use `getOrLoad`.
 *  - **Async cold path**: `getOrLoad/prefetchUserSessions/loadAllPendingApprovals`
 *    consult the durable backing store (SQLite). They populate the RAM
 *    cache as a side effect.
 *  - **Persist hooks**: `persist*` are called by `ConversationManager` after
 *    state mutations. The in-memory store no-ops them; the SQLite store
 *    enqueues writes to the worker thread (`enqueueAsync` by default,
 *    `enqueueSync` for IronClaw-critical methods such as `persistSuspend` /
 *    `persistApprovalResolved`).
 *
 * **Reference-identity invariant**: `get` and `listByPrefix` MUST return the
 * exact object reference that was last passed to `set`. `ConversationManager`
 * mutates `Conversation` objects in place. Sessions that the LRU cache
 * pins (state !== Idle or pending_approval !== undefined) preserve identity
 * across their lifetime. Sessions that are Idle and get evicted lose identity
 * — callers that may face a cold load MUST use `getOrLoad` and accept that
 * the returned object is a fresh reconstruction.
 */
export interface ConversationStore {
  // ─── Sync RAM-only path ─────────────────────────────────────────────

  get(key: string): Conversation | undefined
  set(key: string, value: Conversation, opts?: { pinned?: boolean }): void
  has(key: string): boolean
  listByPrefix(prefix: string): Array<{ key: string; conversation: Conversation }>

  /** Toggle the pinned flag for an existing entry. */
  pin(key: string): void
  unpin(key: string): void

  /** Register a callback fired when an entry is LRU-evicted (NOT on delete). */
  onEvict(cb: EvictCallback): void

  // ─── Async durable path ─────────────────────────────────────────────

  /** Load from durable storage if not in cache. Returns `undefined` when
   *  the sessionKey is unknown. Hits the cache first; on miss, queries the
   *  worker, reconstructs the Conversation, and inserts into cache. */
  getOrLoad(key: string): Promise<Conversation | undefined>

  /** Prefetch every session whose sessionKey starts with `prefix`. Used by
   *  list endpoints. Idempotent per prefix. */
  prefetchUserSessions(prefix: string): Promise<void>

  /** Cold-start sweep: load every session with a pending_approval row,
   *  pin them in cache, and return enough metadata for the
   *  `AgentStateMachine` cold-start to wire up `approvalMap`. */
  loadAllPendingApprovals(): Promise<PersistedSessionListing[]>

  /** D.2 — boot-time sweep: transition every session left in 'processing'
   *  (its reporter died with the previous pod) to 'idle', clear active_task_id,
   *  and append a synthetic interruption message. Returns the reaped sessions.
   *  Optional: durable stores implement it; `InMemoryConversationStore` is a
   *  no-op (nothing survives a restart in RAM, so there's nothing to reap). */
  reapProcessingSessions?(now: number): Promise<ReapedSession[]>

  /** D.8 (F7) — boot-time sweep: transition every session left in
   *  'awaiting_approval' whose approval can no longer resolve (all expired, or
   *  orphaned) to 'idle', delete the stale approval row(s), clear active_task_id,
   *  and append a synthetic interruption message. Returns the reaped sessions.
   *  Optional, same rationale as reapProcessingSessions. */
  reapExpiredAwaitingApprovalSessions?(now: number): Promise<ReapedSession[]>

  /** Legacy operator recovery sweep for every awaiting approval. Normal boot
   *  uses the expired-only sweep and reconstructs live executors. */
  reapAwaitingApprovalSessions?(now: number): Promise<ReapedSession[]>

  // ─── Persist hooks invoked by `ConversationManager` ─────────────────

  /** Called once per new conversation (right after `set`). */
  persistSessionCreate(conv: Conversation, opts: GetOrCreateOptions): Promise<void> | void
  /** Called when a turn starts (user message appended). D3: durable stores
   *  commit the user message + state flip as ONE transaction and return a
   *  promise the caller MUST await (the durability barrier for retry
   *  semantics); the in-memory store stays a sync no-op. */
  persistTurnStart(conv: Conversation, userInput: string): Promise<void> | void
  /** Called when a turn completes (assistant final response appended). D3:
   *  durable stores commit the assistant message + state flip +
   *  `active_task_id` clear as ONE transaction and return a promise the
   *  caller MUST await before ACKing the client; the in-memory store stays a
   *  sync no-op. */
  persistTurnComplete(conv: Conversation, response: string): Promise<void> | void
  /** Called when a turn is cancelled (synthetic response injected). */
  persistTurnCancel(conv: Conversation): Promise<void> | void
  /** Called when a turn fails (no response written). */
  persistTurnFail(conv: Conversation): Promise<void> | void
  /** Called when a tool call records a result. */
  persistToolCall(conv: Conversation, toolCall: TurnToolCall): Promise<void> | void

  /**
   * T2.2 — Persist the freshly built `system_prompt_stable_hash` for this
   * conversation. Async (enqueued via the worker); a slow DB does not block
   * the LLM call. In-memory stores no-op.
   */
  persistSystemPromptStableHash(conv: Conversation, stableHash: string): Promise<void> | void

  /**
   * R2 — persist the per-session `{ provider → model }` selection map after a
   * `set-model`. Async (enqueued via the worker), keyed by sessionKey so it
   * lands after the session's own `insert_session`. In-memory stores no-op.
   * Optional so legacy/in-memory stores don't have to implement it.
   */
  persistModelSelections?(conv: Conversation): Promise<void> | void

  /**
   * Accumulate the token usage of ONE LLM call into the durable per-session
   * counters. Additive (`col = col + delta`). Async (enqueued via the worker);
   * a slow DB never blocks the LLM path. In-memory stores no-op. Optional so
   * legacy/in-memory stores don't have to implement it.
   */
  persistSessionUsage?(conv: Conversation, usage: SessionTokenUsage): Promise<void> | void

  /** Sync write-through: pending_approval must be durable before notifying
   *  the user (channel callback may happen immediately). */
  persistSuspend(conv: Conversation, approval: PendingApproval): Promise<void>
  /** Sync write-through: approval state change before returning 200 to the
   *  client and resuming the executor. */
  persistApprovalResolved(
    conv: Conversation,
    requestId: string,
    decision: 'approve' | 'deny' | 'cancel'
  ): Promise<void>

  /** Optional shutdown drain. Implementations without a worker may no-op. */
  shutdown?(): Promise<void>
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly map = new Map<string, Conversation>()
  private readonly evictCallbacks: EvictCallback[] = []

  get(key: string): Conversation | undefined {
    return this.map.get(key)
  }

  set(key: string, value: Conversation, _opts?: { pinned?: boolean }): void {
    this.map.set(key, value)
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  listByPrefix(prefix: string): Array<{ key: string; conversation: Conversation }> {
    const out: Array<{ key: string; conversation: Conversation }> = []
    for (const [key, conversation] of this.map) {
      if (key.startsWith(prefix)) {
        out.push({ key, conversation })
      }
    }
    return out
  }

  pin(_key: string): void {
    /* in-memory store has no LRU — pinning is a no-op */
  }

  unpin(_key: string): void {
    /* no-op */
  }

  onEvict(cb: EvictCallback): void {
    this.evictCallbacks.push(cb)
  }

  async getOrLoad(key: string): Promise<Conversation | undefined> {
    return this.map.get(key)
  }

  async prefetchUserSessions(_prefix: string): Promise<void> {
    /* nothing to prefetch — everything that exists is already in RAM */
  }

  async loadAllPendingApprovals(): Promise<PersistedSessionListing[]> {
    const out: PersistedSessionListing[] = []
    for (const [sessionKey, conv] of this.map) {
      if (conv.pending_approval) {
        if (!conv.activeTaskId) {
          throw new Error(`Pending approval ${conv.pending_approval.request_id} has no active task`)
        }
        out.push({
          sessionKey,
          approval: conv.pending_approval,
          taskId: conv.activeTaskId,
        })
      }
    }
    return out
  }

  persistSessionCreate(_conv: Conversation, _opts: GetOrCreateOptions): void {
    /* no-op */
  }
  persistTurnStart(_conv: Conversation, _userInput: string): void {
    /* no-op */
  }
  persistTurnComplete(_conv: Conversation, _response: string): void {
    /* no-op */
  }
  persistTurnCancel(_conv: Conversation): void {
    /* no-op */
  }
  persistTurnFail(_conv: Conversation): void {
    /* no-op */
  }
  persistToolCall(_conv: Conversation, _toolCall: TurnToolCall): void {
    /* no-op */
  }

  persistSystemPromptStableHash(_conv: Conversation, _stableHash: string): void {
    /* no-op */
  }

  persistModelSelections(_conv: Conversation): void {
    /* no-op — RAM-only store keeps the selection on the Conversation object */
  }

  persistSessionUsage(_conv: Conversation, _usage: SessionTokenUsage): void {
    /* no-op — RAM-only store does not persist counters */
  }

  async persistSuspend(_conv: Conversation, _approval: PendingApproval): Promise<void> {
    /* no-op */
  }

  async persistApprovalResolved(
    _conv: Conversation,
    _requestId: string,
    _decision: 'approve' | 'deny' | 'cancel'
  ): Promise<void> {
    /* no-op */
  }
}
