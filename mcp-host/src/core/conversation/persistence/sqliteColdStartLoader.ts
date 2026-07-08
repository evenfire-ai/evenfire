/**
 * `SqliteColdStartLoader` — implements the P.3 `ColdStartLoader` contract by
 * delegating to a `ConversationStore.loadAllPendingApprovals()`. Optionally
 * probes spillover refs and filters out approvals whose snapshot is no
 * longer reachable.
 *
 * Wired in `main.ts` (T2.1) immediately after the store is constructed and
 * `await`ed via `agent.bootstrap()` before `sessionProcessor.start()` —
 * see the boot order in `T2.1-sqlite-store.md` §16.3.
 */
import type { ColdStartLoader, RehydratedApproval } from '../../../agent/stateMachine'
import type { ReapedSession } from '../../../db/worker/protocol'
import type { SpilloverResolver } from '../../orchestration/spilloverResolver'
import { hasSpilloverRef } from '../../orchestration/spilloverResolver'
import type { PendingApproval } from '../../types'
import { ConversationState } from '../../types'
import type { ConversationStore } from '../conversationStore'

export interface SqliteColdStartLoaderOptions {
  /** Optional resolver. When present we `probe()` spillover refs and skip
   *  approvals whose refs have expired. The store still pins the session
   *  in cache so a user-facing "approval expired" can be emitted. */
  spilloverResolver?: SpilloverResolver
  /** Notification hook for approvals dropped because their spillover refs
   *  expired or their `expires_at` is in the past. The caller emits
   *  whatever channel-side message is appropriate. */
  onExpired?: (entry: RehydratedApproval) => void | Promise<void>
}

/**
 * Collect every spillover_ref reachable from a pending approval. The B7
 * fix probes both arrays (previously only `context_snapshot` was checked,
 * leaving `completed_results` orphan refs to explode at `resumeAfterApproval`
 * time instead of producing a clean `approval_expired`).
 */
function collectSpilloverRefs(approval: PendingApproval): string[] {
  const refs: string[] = []
  for (const m of approval.context_snapshot) {
    if (hasSpilloverRef(m)) {
      const ref = (m as { spillover_ref?: string }).spillover_ref
      if (ref) refs.push(ref)
    }
  }
  for (const r of approval.completed_results ?? []) {
    if (hasSpilloverRef(r as unknown as { spillover_ref?: string })) {
      const ref = (r as { spillover_ref?: string }).spillover_ref
      if (ref) refs.push(ref)
    }
  }
  return refs
}

export class SqliteColdStartLoader implements ColdStartLoader {
  constructor(
    private readonly store: ConversationStore,
    private readonly opts: SqliteColdStartLoaderOptions = {}
  ) {}

  /**
   * D.2 — delegate the boot-time processing-session reap to the store. Guarded
   * because not every store implements it (the method is optional on the
   * interface; `InMemoryConversationStore` doesn't, since RAM doesn't survive
   * a restart).
   */
  async reapProcessingSessions(now: number): Promise<ReapedSession[]> {
    if (!this.store.reapProcessingSessions) return []
    return this.store.reapProcessingSessions(now)
  }

  /**
   * D.8 (F7) — delegate the boot-time awaiting_approval reap to the store.
   * Guarded like reapProcessingSessions.
   */
  async reapExpiredAwaitingApprovalSessions(now: number): Promise<ReapedSession[]> {
    if (!this.store.reapExpiredAwaitingApprovalSessions) return []
    return this.store.reapExpiredAwaitingApprovalSessions(now)
  }

  /**
   * S1 — delegate the boot-time reap of ALL awaiting_approval sessions (live or
   * expired) to the store. Guarded like the expired-only variant. The boot path
   * uses this because no awaiting_approval session is resumable after a restart.
   */
  async reapAwaitingApprovalSessions(now: number): Promise<ReapedSession[]> {
    if (!this.store.reapAwaitingApprovalSessions) return []
    return this.store.reapAwaitingApprovalSessions(now)
  }

  async loadPendingApprovals(now: number): Promise<RehydratedApproval[]> {
    const listings = await this.store.loadAllPendingApprovals()
    const result: RehydratedApproval[] = []

    for (const listing of listings) {
      const entry: RehydratedApproval = {
        request_id: listing.approval.request_id,
        task_id: listing.taskId,
        approval: listing.approval,
        source_message: listing.sourceMessage,
      }

      // B7 fix — TTL filter. The store surfaces `expiresAt` in epoch ms
      // (converted from the row's `expires_at REAL` seconds in
      // `sqliteConversationStore.loadAllPendingApprovals`). Drop approvals
      // whose declared TTL has passed and notify via `onExpired`. Without
      // this guard, an Idle pod restarted after a long gap rehydrates dead
      // approvals that can never resolve.
      if (
        typeof listing.expiresAt === 'number' &&
        Number.isFinite(listing.expiresAt) &&
        listing.expiresAt <= now
      ) {
        await this.notifyExpired(entry)
        this.releaseDropped(listing.sessionKey)
        continue
      }

      if (this.opts.spilloverResolver) {
        // B7 fix — probe refs from BOTH context_snapshot AND completed_results.
        const refs = collectSpilloverRefs(listing.approval)
        if (refs.length > 0) {
          const probe = await this.opts.spilloverResolver.probe(refs)
          if (probe.expired.length > 0) {
            await this.notifyExpired(entry)
            this.releaseDropped(listing.sessionKey)
            continue
          }
        }
      }
      result.push(entry)
    }
    return result
  }

  /**
   * Release a session whose approval we just dropped (TTL expired or spillover
   * ref gone). `loadAllPendingApprovals` PINS every pending-approval session in
   * the LRU before this filter runs; without releasing the dropped ones the
   * pinned slot leaks (and, because the expired DB row survives, re-pins on
   * every boot). Left unbounded this fills the pinned set → `CacheOverflowError`
   * on the next insert → host-wide refusal of new sessions (sqlite-stores-4).
   *
   * Transition the cached conversation to Idle (its approval is gone) and unpin
   * so the slot becomes reclaimable. Both ops are sync RAM-only; in-memory
   * stores treat `unpin` as a no-op.
   */
  private releaseDropped(sessionKey: string): void {
    const conv = this.store.get(sessionKey)
    if (conv) {
      conv.state = ConversationState.Idle
      conv.pending_approval = undefined
    }
    this.store.unpin(sessionKey)
  }

  private async notifyExpired(entry: RehydratedApproval): Promise<void> {
    if (!this.opts.onExpired) return
    try {
      await this.opts.onExpired(entry)
    } catch (err) {
      console.error('[SqliteColdStartLoader] onExpired hook threw:', err)
    }
  }
}
