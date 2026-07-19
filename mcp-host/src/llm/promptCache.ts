/**
 * T2.2 — System-prompt cache (RAM-only, sessionKey-indexed).
 *
 * Holds the `SystemPromptParts` for every session whose conversation is
 * currently in the `ConversationStore` LRU. The `onEvict` hook of the store
 * (T2.1) drops the matching cache entry so RAM stays bounded.
 *
 * - `get/set/has/drop` are pure RAM operations. Callers query first via
 *   `get`; on miss they (re-)build via `PromptBuilder.buildParts` and `set`.
 *
 * - `invalidate(sessionKey, reason)` is called from the four invalidation
 *   sources documented in `T2.2-prompt-cache.md` §5.7:
 *     · `compact`              — drops the entry entirely so the next call
 *                                 re-snapshots `dailyLogSnapshot` (new session
 *                                 of the lineage).
 *     · `host_change`          — identity files may have changed.
 *     · `identity_reconciled`  — broadcast after applyAdminIdentityFiles.
 *     · `model_change`         — runtime metadata in `stable` shifts.
 *   For non-compact reasons we drop the `parts` but keep the
 *   `dailyLogSnapshot` reference so the next rebuild reuses it (the daily
 *   freeze invariant still holds).
 */
import type { SystemPromptParts } from '../core/reasoning/systemPrompt'

export type InvalidationReason = 'compact' | 'host_change' | 'model_change' | 'identity_reconciled'

export interface PromptCacheEntry {
  parts: SystemPromptParts | null
  /**
   * Frozen at first hit per session. `compact` is the only reason that
   * re-snapshots; everything else preserves the freeze.
   */
  dailyLogSnapshot: string
  /**
   * R2 — the effective model the cached `parts` were built for. The system
   * prompt embeds the model name (`buildParts({ model })`), so a per-task model
   * swap must NOT serve parts built for the previous model. The consumer treats
   * a `model` mismatch as a miss and rebuilds; part of the cache key without
   * changing the sessionKey-indexed map (eviction/invalidation stay intact).
   */
  model?: string
}

export interface PromptCacheObserver {
  onInvalidate?: (sessionKey: string, reason: InvalidationReason, prevStableHash?: string) => void
  onSet?: (sessionKey: string, parts: SystemPromptParts) => void
  onDrop?: (sessionKey: string) => void
}

export class PromptCache {
  private readonly entries = new Map<string, PromptCacheEntry>()
  private readonly observer: PromptCacheObserver

  constructor(observer: PromptCacheObserver = {}) {
    this.observer = observer
  }

  get(sessionKey: string): PromptCacheEntry | undefined {
    return this.entries.get(sessionKey)
  }

  set(sessionKey: string, entry: PromptCacheEntry): void {
    this.entries.set(sessionKey, entry)
    if (entry.parts) this.observer.onSet?.(sessionKey, entry.parts)
  }

  has(sessionKey: string): boolean {
    return this.entries.has(sessionKey)
  }

  /**
   * Called by the `ConversationStore.onEvict` hook. The entry is dropped
   * silently — if a later turn rehydrates the session via `getOrLoad`, the
   * prompt is rebuilt with the same identity files + a fresh
   * `snapshotDailyLogs(2)` (idempotent, identical `stableHash`).
   */
  drop(sessionKey: string): void {
    if (this.entries.delete(sessionKey)) {
      this.observer.onDrop?.(sessionKey)
    }
  }

  invalidate(sessionKey: string, reason: InvalidationReason): void {
    const prev = this.entries.get(sessionKey)
    if (!prev) return
    this.observer.onInvalidate?.(sessionKey, reason, prev.parts?.stableHash)
    if (reason === 'compact') {
      this.entries.delete(sessionKey)
      return
    }
    this.entries.set(sessionKey, { ...prev, parts: null })
  }

  /** Broadcast invalidation across every cached session. Used by host CRD /
   *  identity reconciliation events. */
  invalidateAll(reason: InvalidationReason): void {
    for (const key of Array.from(this.entries.keys())) {
      this.invalidate(key, reason)
    }
  }

  size(): number {
    return this.entries.size
  }
}
