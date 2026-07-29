/**
 * `DualConversationStore` — shadow-write to two stores for canary validation.
 *
 * Hot reads come from `memory`; durable-listing reads return SQLite pages so
 * pagination cannot switch sources mid-flow during validation.
 * Writes apply to both; parity is recorded via the optional metrics callback.
 * Used when `CLERUM_SESSION_STORE=dual` to validate that the SQLite store
 * produces the same observable behavior as the in-memory store before we
 * flip the canary to `sqlite`.
 */
import { Counter } from 'prom-client'
import type { ReapedSession } from '../../../db/worker/protocol'
import type { Conversation, PendingApproval, TurnToolCall } from '../../types'
import type {
  ConversationSessionMessages,
  ConversationSessionSummary,
  ConversationStore,
  EvictCallback,
  GetOrCreateOptions,
  PersistedSessionListing,
  SessionListQuery,
  SessionMessagesQuery,
  SessionTokenUsage,
} from '../conversationStore'

const parityCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_conversation_store_parity_total',
      help: 'Dual-write parity outcomes between RAM and SQLite stores',
      labelNames: ['op', 'match'] as const,
    })
  } catch {
    return undefined
  }
})()

export interface DualStoreMetrics {
  recordParity?: (op: string, match: boolean) => void
}

export class DualConversationStore implements ConversationStore {
  constructor(
    private readonly memory: ConversationStore,
    private readonly sqlite: ConversationStore,
    private readonly metrics: DualStoreMetrics = {}
  ) {}

  // ─── Sync RAM-only path — reads from memory, writes to both ──────────

  get(key: string): Conversation | undefined {
    const memVal = this.memory.get(key)
    queueMicrotask(() => {
      const sqlVal = this.sqlite.get(key)
      this.recordParity('get', memVal === undefined ? sqlVal === undefined : sqlVal !== undefined)
    })
    return memVal
  }

  set(key: string, value: Conversation, opts?: { pinned?: boolean }): void {
    this.memory.set(key, value, opts)
    this.sqlite.set(key, value, opts)
  }

  has(key: string): boolean {
    const memHas = this.memory.has(key)
    queueMicrotask(() => {
      const sqlHas = this.sqlite.has(key)
      this.recordParity('has', memHas === sqlHas)
    })
    return memHas
  }

  listByPrefix(prefix: string): Array<{ key: string; conversation: Conversation }> {
    return this.memory.listByPrefix(prefix)
  }

  pin(key: string): void {
    this.memory.pin(key)
    this.sqlite.pin(key)
  }

  unpin(key: string): void {
    this.memory.unpin(key)
    this.sqlite.unpin(key)
  }

  onEvict(cb: EvictCallback): void {
    // Only the canonical (memory) store fires onEvict — sqlite eviction
    // would double-fire callbacks for the same event.
    this.memory.onEvict(cb)
  }

  // ─── Async durable path ─────────────────────────────────────────────

  async getOrLoad(key: string): Promise<Conversation | undefined> {
    // Memory-first cache, SQLite as cold-load backstop. Before B6 this method
    // queried both stores in parallel and returned `memVal` unconditionally;
    // a cold session present in SQLite but absent from memory was reported
    // as `undefined`, which the caller treated as "fresh session" and then
    // recreated the row via `ON CONFLICT(id) DO UPDATE` — destroying
    // `started_at`. Now: memory hit → return; memory miss + SQLite hit →
    // hydrate memory then return; both miss → undefined.
    const memVal = await this.memory.getOrLoad(key)
    if (memVal !== undefined) {
      // Parity peek is best-effort and out of the hot path.
      queueMicrotask(() => {
        this.sqlite.getOrLoad(key).then(
          sqlVal => this.recordParity('getOrLoad', sqlVal !== undefined),
          () => this.recordParity('getOrLoad', false)
        )
      })
      return memVal
    }
    const sqlVal = await this.sqlite.getOrLoad(key)
    if (sqlVal !== undefined) {
      // Hydrate the cache so subsequent sync `get()` calls hit RAM.
      this.memory.set(key, sqlVal)
      this.recordParity('getOrLoad', true)
      return sqlVal
    }
    this.recordParity('getOrLoad', true) // both stores agree the key is absent
    return undefined
  }

  async prefetchUserSessions(prefix: string): Promise<void> {
    await Promise.all([
      this.memory.prefetchUserSessions(prefix),
      this.sqlite.prefetchUserSessions(prefix),
    ])
  }

  async listSessionSummariesByPrefix(
    prefix: string,
    query: SessionListQuery = {}
  ): Promise<ConversationSessionSummary[]> {
    const [memList, sqlList] = await Promise.all([
      this.memory.listSessionSummariesByPrefix(prefix, query),
      this.sqlite.listSessionSummariesByPrefix(prefix, query),
    ])
    this.recordParity('listSessionSummariesByPrefix', memList.length === sqlList.length)
    return sqlList
  }

  async getSessionMessagesByKey(
    key: string,
    prefix: string,
    query: SessionMessagesQuery = {}
  ): Promise<ConversationSessionMessages | undefined> {
    // Transcript pages deliberately return the SQLite result in dual mode.
    // That keeps the durable pagination contract under canary coverage; a
    // memory-only session can read as absent until dual parity is complete.
    const [memPage, sqlPage] = await Promise.all([
      this.memory.getSessionMessagesByKey(key, prefix, query),
      this.sqlite.getSessionMessagesByKey(key, prefix, query),
    ])
    this.recordParity(
      'getSessionMessagesByKey',
      memPage === undefined ? sqlPage === undefined : sqlPage !== undefined
    )
    return sqlPage
  }

  async loadAllPendingApprovals(): Promise<PersistedSessionListing[]> {
    const [memList, sqlList] = await Promise.all([
      this.memory.loadAllPendingApprovals(),
      this.sqlite.loadAllPendingApprovals(),
    ])
    this.recordParity('loadAllPendingApprovals', memList.length === sqlList.length)
    // The DURABLE store is the source of truth for cold-start rehydration: this
    // method exists precisely to repopulate pending approvals after a restart,
    // when the in-memory store boots EMPTY. Returning `memList` would silently
    // drop every persisted approval (the dual canary's whole purpose is to
    // prove cross-restart durability — returning memList makes it a no-op).
    //
    // Merge by sessionKey, durable first, then overlay the live in-RAM listing
    // so a still-hot session prefers its in-memory reference. recordParity above
    // keeps divergence observability intact.
    const bySessionKey = new Map<string, PersistedSessionListing>()
    for (const entry of sqlList) bySessionKey.set(entry.sessionKey, entry)
    for (const entry of memList) bySessionKey.set(entry.sessionKey, entry)
    return Array.from(bySessionKey.values())
  }

  // D.2 — the reap only makes sense for the durable side; memory has nothing
  // to reap (it doesn't survive restarts). Delegate to sqlite.
  async reapProcessingSessions(now: number): Promise<ReapedSession[]> {
    return (await this.sqlite.reapProcessingSessions?.(now)) ?? []
  }

  // D.8 (F7) — same: only the durable side has awaiting_approval rows to reap.
  async reapExpiredAwaitingApprovalSessions(now: number): Promise<ReapedSession[]> {
    return (await this.sqlite.reapExpiredAwaitingApprovalSessions?.(now)) ?? []
  }

  // S1 — reap ALL awaiting_approval sessions (live or expired) at boot. Durable
  // side only, same as above.
  async reapAwaitingApprovalSessions(now: number): Promise<ReapedSession[]> {
    return (await this.sqlite.reapAwaitingApprovalSessions?.(now)) ?? []
  }

  // ─── Persist hooks ──────────────────────────────────────────────────

  async persistSessionCreate(conv: Conversation, opts: GetOrCreateOptions): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistSessionCreate(conv, opts)),
      Promise.resolve(this.sqlite.persistSessionCreate(conv, opts)),
    ])
  }

  async persistTurnStart(conv: Conversation, userInput: string): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistTurnStart(conv, userInput)),
      Promise.resolve(this.sqlite.persistTurnStart(conv, userInput)),
    ])
  }

  async persistTurnComplete(conv: Conversation, response: string): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistTurnComplete(conv, response)),
      Promise.resolve(this.sqlite.persistTurnComplete(conv, response)),
    ])
  }

  async persistTurnCancel(conv: Conversation): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistTurnCancel(conv)),
      Promise.resolve(this.sqlite.persistTurnCancel(conv)),
    ])
  }

  async persistTurnFail(conv: Conversation): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistTurnFail(conv)),
      Promise.resolve(this.sqlite.persistTurnFail(conv)),
    ])
  }

  async persistToolCall(conv: Conversation, toolCall: TurnToolCall): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistToolCall(conv, toolCall)),
      Promise.resolve(this.sqlite.persistToolCall(conv, toolCall)),
    ])
  }

  async persistSystemPromptStableHash(conv: Conversation, stableHash: string): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistSystemPromptStableHash(conv, stableHash)),
      Promise.resolve(this.sqlite.persistSystemPromptStableHash(conv, stableHash)),
    ])
  }

  async persistSessionUsage(conv: Conversation, usage: SessionTokenUsage): Promise<void> {
    await Promise.all([
      Promise.resolve(this.memory.persistSessionUsage?.(conv, usage)),
      Promise.resolve(this.sqlite.persistSessionUsage?.(conv, usage)),
    ])
  }

  async persistSuspend(conv: Conversation, approval: PendingApproval): Promise<void> {
    await Promise.all([
      this.memory.persistSuspend(conv, approval),
      this.sqlite.persistSuspend(conv, approval),
    ])
  }

  async persistApprovalResolved(
    conv: Conversation,
    requestId: string,
    decision: 'approve' | 'deny' | 'cancel'
  ): Promise<void> {
    await Promise.all([
      this.memory.persistApprovalResolved(conv, requestId, decision),
      this.sqlite.persistApprovalResolved(conv, requestId, decision),
    ])
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([this.memory.shutdown?.(), this.sqlite.shutdown?.()])
  }

  private recordParity(op: string, match: boolean): void {
    parityCounter?.labels(op, match ? 'true' : 'false').inc()
    this.metrics.recordParity?.(op, match)
  }
}
