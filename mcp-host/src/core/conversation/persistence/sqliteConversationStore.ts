/**
 * `SqliteConversationStore` — write-through RAM + SQLite implementation.
 *
 * Layout:
 *   - `cache: PinnedLRUMap<sessionKey, Conversation>` is the hot path. Live
 *     references — `ConversationManager` mutates these in place.
 *   - `PersistQueue` fronts the worker thread. `enqueueAsync` for the hot
 *     path (preserves per-sessionKey ordering); `enqueueSync` for the
 *     IronClaw-critical persistSuspend/persistApprovalResolved.
 *
 * Sessions with `state !== Idle` or `pending_approval !== undefined` are
 * **pinned**: the LRU never evicts them, identity stays stable across the
 * session's lifetime. Sessions in Idle relax this — they can be evicted
 * and rehydrated; callers that may face a cold load MUST use `getOrLoad`.
 */
import { Counter, Gauge, Histogram } from 'prom-client'
import type {
  LoadAllPendingApprovalsRow,
  PendingApprovalRow,
  PersistedSession,
  ReapedSession,
  SessionRow,
} from '../../../db/worker/protocol'
import { parseSessionKey } from '../../../session/types'
import type { ChatMessage, Conversation, PendingApproval, TurnToolCall } from '../../types'
import {
  type ConversationStore,
  type EvictCallback,
  type GetOrCreateOptions,
  type PersistedSessionListing,
  type SessionTokenUsage,
} from '../conversationStore'
import type { PersistQueue } from './persistQueue'
import { CacheOverflowError, PinnedLRUMap } from './pinnedLruMap'
import { reconstructConversation, reconstructPendingApproval } from './reconstruct'

const cacheHitsCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_conversation_cache_hits_total',
      help: 'Cache hits on the conversation store RAM tier',
    })
  } catch {
    return undefined
  }
})()

const cacheMissesCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_conversation_cache_misses_total',
      help: 'Cache misses on the conversation store RAM tier',
    })
  } catch {
    return undefined
  }
})()

const cacheEvictionsCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_conversation_cache_evictions_total',
      help: 'LRU evictions from the conversation store RAM tier',
    })
  } catch {
    return undefined
  }
})()

const pinnedCountGauge = (() => {
  try {
    return new Gauge({
      name: 'clerum_lru_pinned_count',
      help: 'Number of pinned conversation entries in the LRU cache',
    })
  } catch {
    return undefined
  }
})()

const rehydrationDurationHistogram = (() => {
  try {
    return new Histogram({
      name: 'clerum_conversation_rehydration_duration_seconds',
      help: 'Time to rehydrate a Conversation from the SQLite store',
      labelNames: ['outcome'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    })
  } catch {
    return undefined
  }
})()

// D.2 — incremented from the MAIN thread (NOT the worker, whose prom-client
// registry is a separate V8 isolate — cross-ref D.2 P2) once per session the
// boot reaper transitioned from processing to idle.
const processingSessionsReapedCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_processing_sessions_reaped_total',
      help: 'Sessions transitioned processing→idle on boot due to an absent reporter',
      labelNames: ['channel_type'] as const,
    })
  } catch {
    return undefined
  }
})()

// D.8 (F7) — incremented from the MAIN thread once per session the boot reaper
// transitioned from awaiting_approval→idle because its approval expired (or was
// orphaned) and can no longer resolve.
const expiredApprovalsReapedCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_expired_approvals_reaped_total',
      help: 'Sessions transitioned awaiting_approval→idle on boot due to an unresolvable approval',
      labelNames: ['channel_type'] as const,
    })
  } catch {
    return undefined
  }
})()

// S1 — incremented once per session the boot reaper transitioned from
// awaiting_approval→idle because the approval was still live but cannot be
// resumed after a pod restart (no executor rehydration). Kept distinct from the
// expired counter so dashboards don't conflate restart-interruption with TTL
// expiry.
const restartInterruptedApprovalsReapedCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_restart_interrupted_approvals_reaped_total',
      help: 'Sessions transitioned awaiting_approval→idle on boot because a pod restart interrupted a live approval',
      labelNames: ['channel_type'] as const,
    })
  } catch {
    return undefined
  }
})()

export interface SqliteConversationStoreOptions {
  cacheSize: number
  /** Optional callback invoked when a non-Idle session would have been
   *  evicted — for instrumentation. The pinning logic itself prevents the
   *  eviction; this is just for telemetry. */
  onPinnedBlocked?: (key: string) => void
  /** TTL applied to persisted pending approval rows (`pending_approvals.expires_at`).
   *  Defaults to 7 days when omitted, matching the previous hardcoded value. */
  pendingApprovalTtlMs?: number
}

const DEFAULT_PENDING_APPROVAL_TTL_MS = 7 * 24 * 3600 * 1000

interface SessionOrdinalState {
  nextOrdinal: number
  nextTurnNumber: number
}

export class SqliteConversationStore implements ConversationStore {
  private readonly cache: PinnedLRUMap<string, Conversation>
  private readonly prefetchedPrefixes = new Set<string>()
  private readonly ordinals = new Map<string, SessionOrdinalState>()
  private readonly sessionKeyById = new Map<string, string>()
  private readonly evictCallbacks: EvictCallback[] = []

  constructor(
    private readonly persistQueue: PersistQueue,
    private readonly opts: SqliteConversationStoreOptions
  ) {
    this.cache = new PinnedLRUMap<string, Conversation>(opts.cacheSize)
    this.cache.onEvict((key, value) => {
      cacheEvictionsCounter?.inc()
      this.ordinals.delete(value.id)
      this.sessionKeyById.delete(value.id)
      for (const cb of this.evictCallbacks) {
        try {
          cb(key, value)
        } catch (err) {
          console.error('[SqliteConversationStore] onEvict callback threw:', err)
        }
      }
    })
  }

  // ─── Sync RAM-only path ─────────────────────────────────────────────

  get(key: string): Conversation | undefined {
    const hit = this.cache.get(key)
    if (hit) {
      cacheHitsCounter?.inc()
      return hit
    }
    return undefined
  }

  set(key: string, value: Conversation, opts?: { pinned?: boolean }): void {
    // Default pin policy: pinned iff non-Idle or has pending approval.
    const pinned = opts?.pinned ?? (value.state !== 'idle' || value.pending_approval !== undefined)
    this.cache.set(key, value, { pinned })
    this.sessionKeyById.set(value.id, key)
    if (!this.ordinals.has(value.id)) {
      this.ordinals.set(value.id, { nextOrdinal: 0, nextTurnNumber: 1 })
    }
    pinnedCountGauge?.set(this.cache.pinnedCount())
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  listByPrefix(prefix: string): Array<{ key: string; conversation: Conversation }> {
    const out: Array<{ key: string; conversation: Conversation }> = []
    for (const [key, conversation] of this.cache.entries()) {
      if (key.startsWith(prefix)) {
        out.push({ key, conversation })
      }
    }
    return out
  }

  pin(key: string): void {
    if (!this.cache.has(key)) {
      console.warn(`[SqliteConversationStore] pin(${key}): unknown key`)
      return
    }
    this.cache.pin(key)
    pinnedCountGauge?.set(this.cache.pinnedCount())
  }

  unpin(key: string): void {
    this.cache.unpin(key)
    pinnedCountGauge?.set(this.cache.pinnedCount())
  }

  onEvict(cb: EvictCallback): void {
    this.evictCallbacks.push(cb)
  }

  // ─── Async durable path ─────────────────────────────────────────────

  async getOrLoad(sessionKey: string): Promise<Conversation | undefined> {
    const cached = this.cache.get(sessionKey)
    if (cached) {
      cacheHitsCounter?.inc()
      return cached
    }
    cacheMissesCounter?.inc()
    const start = process.hrtime.bigint()
    // Pass `sessionKey` so this read CHAINS after any pending async writes for
    // the same session. Without it, a just-completed Idle session that was
    // evicted while its persistTurnComplete writes were still queued could be
    // reloaded ahead of those writes — reconstructing a Conversation missing
    // the final turn or with stale state, then cached back as authoritative
    // (sqlite-stores-3). The durable store converges, but the in-RAM consumer
    // would read lost context within the window.
    const persisted = await this.persistQueue.enqueueSync<PersistedSession | null>(
      {
        kind: 'load_active_session',
        sessionKey,
      },
      sessionKey
    )
    if (!persisted) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9
      rehydrationDurationHistogram?.labels('miss').observe(seconds)
      return undefined
    }
    const { conversation, highestOrdinal, highestTurnNumber } = reconstructConversation(persisted)
    const pinned = conversation.state !== 'idle' || conversation.pending_approval !== undefined
    try {
      this.cache.set(sessionKey, conversation, { pinned })
    } catch (err) {
      if (err instanceof CacheOverflowError) {
        // Every slot is pinned and none can be evicted. Degrade rather than
        // propagating to executor task acquisition (which would refuse ALL new
        // sessions host-wide — sqlite-stores-4 / CRIT-4). Return the freshly
        // reconstructed conversation UNCACHED: the read succeeds, the host stays
        // up, and pinnedCountGauge surfaces the saturation for alerting. The
        // root-cause leak is fixed in SqliteColdStartLoader.releaseDropped; this
        // is the last-resort backstop.
        console.error(
          `[SqliteConversationStore] cache overflow loading sessionKey=${sessionKey} ` +
            `(pinned=${this.cache.pinnedCount()}/${this.cache.maxSize}); returning uncached`,
          err
        )
        pinnedCountGauge?.set(this.cache.pinnedCount())
        return conversation
      }
      throw err
    }
    this.sessionKeyById.set(conversation.id, sessionKey)
    this.ordinals.set(conversation.id, {
      nextOrdinal: highestOrdinal + 1,
      nextTurnNumber: Math.max(highestTurnNumber + 1, 1),
    })
    pinnedCountGauge?.set(this.cache.pinnedCount())
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    rehydrationDurationHistogram?.labels('hit').observe(seconds)
    return conversation
  }

  async prefetchUserSessions(prefix: string): Promise<void> {
    if (this.prefetchedPrefixes.has(prefix)) return
    // Drain any pending per-session writes for this prefix BEFORE the bulk
    // read, so a just-completed session whose persist writes are still queued
    // isn't reconstructed from stale rows (sqlite-stores-3 — the prefix
    // analogue of the `sessionKey`-chained `getOrLoad` read below). The bulk
    // `list_sessions_by_prefix` op carries no single sessionKey, so it cannot
    // chain via `enqueueSync`; we drain the matching chains explicitly.
    await this.persistQueue.drainPrefix(prefix)
    const rows = await this.persistQueue.enqueueSync<PersistedSession[]>({
      kind: 'list_sessions_by_prefix',
      sessionKeyPrefix: prefix,
    })
    for (const row of rows) {
      const key = row.session.session_key
      if (this.cache.has(key)) continue
      const { conversation, highestOrdinal, highestTurnNumber } = reconstructConversation(row)
      const pinned = conversation.state !== 'idle' || conversation.pending_approval !== undefined
      this.cache.set(key, conversation, { pinned })
      this.sessionKeyById.set(conversation.id, key)
      this.ordinals.set(conversation.id, {
        nextOrdinal: highestOrdinal + 1,
        nextTurnNumber: Math.max(highestTurnNumber + 1, 1),
      })
    }
    pinnedCountGauge?.set(this.cache.pinnedCount())
    this.prefetchedPrefixes.add(prefix)
  }

  async loadAllPendingApprovals(): Promise<PersistedSessionListing[]> {
    const rows = await this.persistQueue.enqueueSync<LoadAllPendingApprovalsRow[]>({
      kind: 'load_all_pending_approvals',
    })
    const out: PersistedSessionListing[] = []
    for (const row of rows) {
      const sessionKey = row.session_key
      let conv = this.cache.get(sessionKey)
      if (!conv) {
        // Chain after pending per-session writes (same rationale as getOrLoad).
        const persisted = await this.persistQueue.enqueueSync<PersistedSession | null>(
          {
            kind: 'load_active_session',
            sessionKey,
          },
          sessionKey
        )
        if (!persisted) continue
        const reconstructed = reconstructConversation(persisted)
        conv = reconstructed.conversation
        this.cache.set(sessionKey, conv, { pinned: true })
        this.sessionKeyById.set(conv.id, sessionKey)
        this.ordinals.set(conv.id, {
          nextOrdinal: reconstructed.highestOrdinal + 1,
          nextTurnNumber: Math.max(reconstructed.highestTurnNumber + 1, 1),
        })
      } else {
        this.cache.pin(sessionKey)
      }
      const approval =
        conv.pending_approval ?? reconstructPendingApproval(row.approval as PendingApprovalRow)
      const sourceMessage = row.approval.source_message
        ? (JSON.parse(row.approval.source_message) as Record<string, unknown>)
        : undefined
      out.push({
        sessionKey,
        approval,
        taskId: row.approval.task_id,
        sourceMessage,
        // expires_at is REAL (epoch seconds); convert to ms so the
        // cold-start loader's TTL compare against `Date.now()` is a direct
        // numeric compare.
        expiresAt: row.approval.expires_at * 1000,
      })
    }
    pinnedCountGauge?.set(this.cache.pinnedCount())
    return out
  }

  /**
   * D.2 — boot-time reaper. Delegates the (chunked, transactional) sweep to the
   * worker and increments the Prometheus counter here in the MAIN thread (the
   * worker's prom-client registry is a separate isolate). The worker returns []
   * fast when no session is in 'processing', so there's no extra round-trip
   * cost on the happy path.
   *
   * Also reconciles the RAM cache: a reaped session that happens to be cached
   * (rare at boot, but possible if loadAllPendingApprovals pinned it) gets its
   * in-memory state/activeTaskId cleared so RAM and SQLite stay consistent.
   */
  async reapProcessingSessions(now: number): Promise<ReapedSession[]> {
    const reaped = await this.persistQueue.enqueueSync<ReapedSession[]>({
      kind: 'reap_processing_sessions',
      nowEpoch: now,
    })
    for (const r of reaped) {
      processingSessionsReapedCounter?.inc({ channel_type: r.channelType ?? 'unknown' })
      // If the reaped session is cached, DROP it (not just mutate state): the
      // worker inserted the synthetic message at maxOrdinal+1 directly, so the
      // RAM `ordinals.nextOrdinal` is now stale. Mutating only state/activeTaskId
      // would leave the next startTurn writing at a colliding ordinal
      // (UNIQUE(session_id, ordinal) → silently dropped user message). It would
      // also leave the entry pinned (was 'processing') and never LRU-evictable.
      // Evicting forces a clean cold-load (reconciled state, cleared
      // active_task_id, correct ordinals) on next access. All three deletes are
      // idempotent no-ops when the session isn't cached (the boot happy path).
      this.cache.delete(r.sessionKey)
      this.ordinals.delete(r.sessionId)
      this.sessionKeyById.delete(r.sessionId)
    }
    return reaped
  }

  /**
   * D.8 (F7) — boot-time reaper for sessions stuck in 'awaiting_approval' whose
   * approval can no longer resolve (all expired, or orphaned). Same chunked
   * worker sweep + main-thread counter + cache-evict pattern as
   * reapProcessingSessions. Runs at PHASE 1b, before approval rehydration.
   */
  async reapExpiredAwaitingApprovalSessions(now: number): Promise<ReapedSession[]> {
    const reaped = await this.persistQueue.enqueueSync<ReapedSession[]>({
      kind: 'reap_awaiting_approval_sessions',
      nowEpoch: now,
    })
    for (const r of reaped) {
      expiredApprovalsReapedCounter?.inc({ channel_type: r.channelType ?? 'unknown' })
      // Same cache reconciliation rationale as reapProcessingSessions: the
      // worker inserted a synthetic message + flipped state directly, so drop
      // any cached entry to force a clean cold-load with correct ordinals.
      this.cache.delete(r.sessionKey)
      this.ordinals.delete(r.sessionId)
      this.sessionKeyById.delete(r.sessionId)
    }
    return reaped
  }

  /**
   * S1 — boot-time reaper for EVERY session left in 'awaiting_approval', live or
   * expired. No awaiting_approval session is resumable after a pod restart (no
   * executor rehydration exists), so the boot path uses this form instead of the
   * expired-only one above. Same chunked worker sweep + counter + cache-evict
   * pattern; the worker stamps a distinct APPROVAL_INTERRUPTED_BY_RESTART message.
   */
  async reapAwaitingApprovalSessions(now: number): Promise<ReapedSession[]> {
    const reaped = await this.persistQueue.enqueueSync<ReapedSession[]>({
      kind: 'reap_awaiting_approval_sessions',
      nowEpoch: now,
      includeLive: true,
    })
    for (const r of reaped) {
      restartInterruptedApprovalsReapedCounter?.inc({ channel_type: r.channelType ?? 'unknown' })
      this.cache.delete(r.sessionKey)
      this.ordinals.delete(r.sessionId)
      this.sessionKeyById.delete(r.sessionId)
    }
    return reaped
  }

  // ─── Persist hooks ──────────────────────────────────────────────────

  persistSessionCreate(conv: Conversation, opts: GetOrCreateOptions): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) {
      console.warn(
        `[SqliteConversationStore] persistSessionCreate: no sessionKey for conv ${conv.id}`
      )
      return
    }
    const parsed = parseSessionKey(sessionKey)
    const row: SessionRow = {
      id: conv.id,
      session_key: sessionKey,
      source: opts.source ?? parsed?.channelType ?? 'internal',
      user_id: opts.userId ?? parsed?.userId ?? conv.user_id ?? null,
      team_id: opts.teamId ?? null,
      channel_type: opts.channelType ?? parsed?.channelType ?? null,
      channel_id: opts.channelId ?? parsed?.channelId ?? null,
      thread_id: opts.threadId ?? parsed?.threadId ?? null,
      model: opts.model ?? null,
      system_prompt_stable_hash: null,
      parent_session_id: null,
      started_at: conv.created_at.getTime() / 1000,
      ended_at: null,
      end_reason: null,
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_tokens_reported: 0,
      title: null,
      state: conv.state,
      active_task_id: conv.activeTaskId ?? null,
    }
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'insert_session',
      payload: row,
    })
  }

  persistTurnStart(conv: Conversation, userInput: string): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    this.reconcilePinning(sessionKey, conv)
    const state = this.ordinals.get(conv.id) ?? this.initOrdinalState(conv.id)
    const ordinal = state.nextOrdinal++
    const turnNumber = state.nextTurnNumber
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'insert_message',
      payload: {
        session_id: conv.id,
        ordinal,
        role: 'user',
        content: userInput,
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: Date.now() / 1000,
        token_count: null,
        finish_reason: null,
        spillover_ref: null,
        is_error: 0,
        turn_number: turnNumber,
      },
    })
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'update_session_state',
      sessionId: conv.id,
      state: conv.state,
      // D.1 — mirror the in-RAM activeTaskId (set by startTurn) to the column.
      activeTaskId: conv.activeTaskId ?? null,
    })
  }

  persistTurnComplete(conv: Conversation, response: string): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    this.reconcilePinning(sessionKey, conv)
    const state = this.ordinals.get(conv.id) ?? this.initOrdinalState(conv.id)
    const ordinal = state.nextOrdinal++
    const turnNumber = state.nextTurnNumber
    state.nextTurnNumber += 1
    // Stamp the per-turn token total onto the final assistant message (the turn
    // accumulated it in RAM via recordSessionUsage). reconstruct sums these back
    // onto the Turn on cold-load.
    const turn = conv.turns[conv.turns.length - 1]
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'insert_message',
      payload: {
        session_id: conv.id,
        ordinal,
        role: 'assistant',
        content: response,
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: Date.now() / 1000,
        token_count: null,
        finish_reason: 'stop',
        spillover_ref: null,
        is_error: 0,
        turn_number: turnNumber,
        input_tokens: turn?.input_tokens ?? null,
        output_tokens: turn?.output_tokens ?? null,
        cache_read_tokens: turn?.cache_read_tokens ?? null,
        cache_write_tokens: turn?.cache_write_tokens ?? null,
      },
    })
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'update_session_state',
      sessionId: conv.id,
      state: conv.state,
      activeTaskId: null, // D.1 — turn complete clears the in-flight task
    })
  }

  persistTurnCancel(conv: Conversation): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    this.reconcilePinning(sessionKey, conv)
    const state = this.ordinals.get(conv.id) ?? this.initOrdinalState(conv.id)
    const ordinal = state.nextOrdinal++
    const turnNumber = state.nextTurnNumber
    state.nextTurnNumber += 1
    // Stamp the partial per-turn total accumulated before cancellation.
    const turn = conv.turns[conv.turns.length - 1]
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'insert_message',
      payload: {
        session_id: conv.id,
        ordinal,
        role: 'assistant',
        content: '[Task cancelled by user before completion]',
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: Date.now() / 1000,
        token_count: null,
        finish_reason: 'stop',
        spillover_ref: null,
        is_error: 0,
        turn_number: turnNumber,
        input_tokens: turn?.input_tokens ?? null,
        output_tokens: turn?.output_tokens ?? null,
        cache_read_tokens: turn?.cache_read_tokens ?? null,
        cache_write_tokens: turn?.cache_write_tokens ?? null,
      },
    })
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'update_session_state',
      sessionId: conv.id,
      state: 'idle',
      activeTaskId: null, // D.1 — cancel clears the in-flight task
    })
  }

  persistTurnFail(conv: Conversation): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    this.reconcilePinning(sessionKey, conv)
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'update_session_state',
      sessionId: conv.id,
      state: 'idle',
      activeTaskId: null, // D.1 — fail clears the in-flight task
    })
  }

  persistToolCall(conv: Conversation, toolCall: TurnToolCall): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    const state = this.ordinals.get(conv.id) ?? this.initOrdinalState(conv.id)
    const assistantOrdinal = state.nextOrdinal++
    const toolOrdinal = state.nextOrdinal++
    const turnNumber = state.nextTurnNumber
    const now = Date.now() / 1000
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'insert_message',
      payload: {
        session_id: conv.id,
        ordinal: assistantOrdinal,
        role: 'assistant',
        content: null,
        content_parts: null,
        tool_call_id: null,
        tool_calls: JSON.stringify([{ name: toolCall.name, arguments: toolCall.parameters }]),
        tool_name: null,
        timestamp: now,
        token_count: null,
        finish_reason: 'tool_use',
        spillover_ref: null,
        is_error: 0,
        turn_number: turnNumber,
      },
    })
    if (toolCall.result !== undefined || toolCall.error !== undefined) {
      this.persistQueue.enqueueAsync(sessionKey, {
        kind: 'insert_message',
        payload: {
          session_id: conv.id,
          ordinal: toolOrdinal,
          role: 'tool',
          content: toolCall.result ?? toolCall.error ?? null,
          content_parts: null,
          tool_call_id: null,
          tool_calls: null,
          tool_name: toolCall.name,
          timestamp: now,
          token_count: null,
          finish_reason: null,
          // B8 fix — was hard-coded to `null`, so the `idx_messages_spillover`
          // index was never populated. The TurnToolCall now carries the
          // lateral; persistToolCall surfaces it through the row.
          spillover_ref: toolCall.spillover_ref ?? null,
          is_error: toolCall.error !== undefined ? 1 : 0,
          turn_number: turnNumber,
        },
      })
    } else {
      // The tool message arrives later — give back the ordinal slot so we
      // don't leave a permanent hole.
      state.nextOrdinal -= 1
    }
  }

  persistSystemPromptStableHash(conv: Conversation, stableHash: string): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'update_session_prompt_stable_hash',
      sessionId: conv.id,
      stableHash,
    })
  }

  /**
   * Accumulate one LLM call's token usage into `sessions.*_tokens`. Enqueued
   * (async) so a slow DB never blocks the LLM path; `enqueueAsync(sessionKey)`
   * preserves the per-session FIFO. The deltas are additive and independent
   * per column, so ordering relative to `insert_message` is irrelevant.
   *
   * IMPORTANT: only the token deltas are sent. `message_count` / `tool_call_count`
   * are bumped exclusively by the `insert_message` op — passing them here too
   * would double-count.
   */
  persistSessionUsage(conv: Conversation, usage: SessionTokenUsage): void {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    this.persistQueue.enqueueAsync(sessionKey, {
      kind: 'update_session_counters',
      sessionId: conv.id,
      counters: {
        inputTokensDelta: usage.input_tokens,
        outputTokensDelta: usage.output_tokens,
        // NOT NULL columns → normalize undefined (provider without cache) to 0.
        cacheReadTokensDelta: usage.cache_read_tokens ?? 0,
        cacheWriteTokensDelta: usage.cache_write_tokens ?? 0,
        // Sticky "model reports cache" flag — a defined cache field (even 0)
        // means the provider reports cache (Anthropic), undefined means it
        // doesn't (OpenAI/zai/bailian). Persisted so cold-load doesn't have to
        // (lossily) re-derive it from cache_*_tokens > 0.
        cacheReported:
          usage.cache_read_tokens !== undefined || usage.cache_write_tokens !== undefined,
      },
    })
  }

  async persistSuspend(conv: Conversation, approval: PendingApproval): Promise<void> {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (!sessionKey) return
    this.reconcilePinning(sessionKey, conv)
    const now = Date.now()
    const row: PendingApprovalRow = {
      request_id: approval.request_id,
      session_id: conv.id,
      task_id: approval.request_id,
      tool_name: approval.tool_name,
      tool_call_id: approval.tool_call_id,
      parameters: JSON.stringify(approval.parameters),
      description: approval.description,
      context_snapshot: JSON.stringify(approval.context_snapshot satisfies ChatMessage[]),
      completed_results: approval.completed_results
        ? JSON.stringify(approval.completed_results)
        : null,
      intent_summary: approval.intent_summary ?? null,
      source_message: null,
      registered_at: now / 1000,
      expires_at:
        (now + (this.opts.pendingApprovalTtlMs ?? DEFAULT_PENDING_APPROVAL_TTL_MS)) / 1000,
    }
    await this.persistQueue.enqueueSync(
      { kind: 'insert_pending_approval', payload: row },
      sessionKey
    )
    await this.persistQueue.enqueueSync(
      { kind: 'update_session_state', sessionId: conv.id, state: conv.state },
      sessionKey
    )
  }

  async persistApprovalResolved(
    conv: Conversation,
    requestId: string,
    decision: 'approve' | 'deny' | 'cancel'
  ): Promise<void> {
    const sessionKey = this.sessionKeyById.get(conv.id)
    if (sessionKey) this.reconcilePinning(sessionKey, conv)
    await this.persistQueue.enqueueSync({ kind: 'delete_pending_approval', requestId }, sessionKey)
    await this.persistQueue.enqueueSync(
      {
        kind: 'update_session_state',
        sessionId: conv.id,
        state: conv.state,
        endedAt: decision === 'cancel' ? Date.now() / 1000 : undefined,
        endReason: decision === 'cancel' ? 'cancelled' : undefined,
        // D.1 — approve resumes the SAME task (→ Processing): preserve.
        // deny/cancel are terminal (→ Idle): clear the in-flight task.
        activeTaskId: decision === 'approve' ? undefined : null,
      },
      sessionKey
    )
  }

  async shutdown(): Promise<void> {
    await this.persistQueue.close()
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private initOrdinalState(sessionId: string): SessionOrdinalState {
    const state: SessionOrdinalState = { nextOrdinal: 0, nextTurnNumber: 1 }
    this.ordinals.set(sessionId, state)
    return state
  }

  /**
   * Synchronize the LRU pin flag with the conversation state. Sessions in
   * `Processing` / `AwaitingApproval` (or carrying a `pending_approval`)
   * are pinned; Idle sessions are unpinned. Idempotent.
   */
  private reconcilePinning(sessionKey: string, conv: Conversation): void {
    if (!this.cache.has(sessionKey)) return
    const shouldPin = conv.state !== 'idle' || conv.pending_approval !== undefined
    if (shouldPin && !this.cache.isPinned(sessionKey)) {
      this.cache.pin(sessionKey)
      pinnedCountGauge?.set(this.cache.pinnedCount())
    } else if (!shouldPin && this.cache.isPinned(sessionKey)) {
      this.cache.unpin(sessionKey)
      pinnedCountGauge?.set(this.cache.pinnedCount())
    }
  }
}
