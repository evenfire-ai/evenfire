import type { Rid32 } from './keys.js'

/**
 * gfsc caches an authorization decision for 5 s; one more second covers the
 * NOTIFY latency. A rid whose ancestry changed that recently may still be
 * decided by gfsc from the cache entry of before the move.
 */
export const RECENT_DIRTY_WINDOW_MS = 6_000
export const RECENT_DIRTY_CAPACITY = 1_024

export type RecentDirty = {
  readonly size: number
  prune(): void
  push(rid32: Rid32, at: number): void
  snapshot(): Set<Rid32>
  overflowed(): boolean
  markOverflow(): void
}

/**
 * Rids that changed ancestry or existence in the last six seconds, copied into
 * every new op so a decision gfsc may have cached before such a change is not
 * trusted. When the ring overflows, or a revocation hint could not be read,
 * the registry cannot tell which rids are dirty, so every op born within the
 * next window treats all its decisions as suspect.
 */
export function createRecentDirty(now: () => number): RecentDirty {
  const ring: { rid32: Rid32; at: number }[] = []
  let overflowUntil = -Infinity

  const recentDirty: RecentDirty = {
    get size() {
      return ring.length
    },
    prune() {
      while (ring.length > 0 && ring[0]!.at < now() - RECENT_DIRTY_WINDOW_MS) ring.shift()
    },
    push(rid32, at) {
      recentDirty.prune()
      if (ring.length >= RECENT_DIRTY_CAPACITY) {
        overflowUntil = now() + RECENT_DIRTY_WINDOW_MS
        ring.shift()
      }
      ring.push({ rid32, at })
    },
    snapshot() {
      recentDirty.prune()
      return new Set(ring.map(e => e.rid32))
    },
    overflowed() {
      return now() < overflowUntil
    },
    markOverflow() {
      overflowUntil = now() + RECENT_DIRTY_WINDOW_MS
    },
  }
  return recentDirty
}
