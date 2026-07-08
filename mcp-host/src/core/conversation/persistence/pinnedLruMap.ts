/**
 * `PinnedLRUMap` — LRU eviction with explicit pinning.
 *
 * Design (P0-005 in `T2.1-sqlite-store.md` §11):
 * - `pin(key)` marks an entry as ineligible for LRU eviction. Idempotent.
 * - `unpin(key)` clears the pin. Idempotent.
 * - `set(key, value, { pinned })` — atomic insert+pin. Throws
 *   `CacheOverflowError` if the pinned entry would exceed `maxSize` (i.e.,
 *   every other slot is already pinned and can't be evicted to make room).
 * - `onEvict(cb)` registers a callback fired when an entry is evicted by LRU
 *   policy (NOT when deleted explicitly via `delete()`). Used by T2.2 to
 *   drop matching prompt-cache entries.
 *
 * The set of pinned keys is the materialization of the IronClaw invariant
 * "sessions with state !== Idle or pending_approval !== undefined survive
 * cross-pod-restart in RAM as long as they're pinned by the manager".
 */

export class CacheOverflowError extends Error {
  readonly code = 'CACHE_OVERFLOW' as const
  constructor(message: string) {
    super(message)
    this.name = 'CacheOverflowError'
  }
}

export interface PinnedLRUMapSetOptions {
  pinned?: boolean
}

export interface PinnedLRUMapStats {
  size: number
  pinnedCount: number
  maxSize: number
}

export type EvictCallback<K, V> = (key: K, value: V) => void

export class PinnedLRUMap<K, V> {
  private readonly map: Map<K, V> = new Map()
  private readonly pinned: Set<K> = new Set()
  private readonly evictCallbacks: Array<EvictCallback<K, V>> = []

  constructor(public readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new Error(`PinnedLRUMap: maxSize must be a positive integer, got ${maxSize}`)
    }
  }

  size(): number {
    return this.map.size
  }

  pinnedCount(): number {
    return this.pinned.size
  }

  stats(): PinnedLRUMapStats {
    return {
      size: this.map.size,
      pinnedCount: this.pinned.size,
      maxSize: this.maxSize,
    }
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  isPinned(key: K): boolean {
    return this.pinned.has(key)
  }

  /** Touch ordering by re-inserting at the end of the Map. Returns the value. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    // Re-insert to bump recency (Map preserves insertion order).
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  /**
   * Insert/update an entry. When `pinned` is true the entry is also pinned.
   * Replacing an existing entry preserves its pin state unless `pinned` is
   * explicitly provided.
   *
   * Throws `CacheOverflowError` when:
   *   - adding (or pinning) the entry would exceed `maxSize`, AND
   *   - no unpinned entry remains to evict.
   */
  set(key: K, value: V, opts: PinnedLRUMapSetOptions = {}): void {
    const willPin = opts.pinned === true
    const existing = this.map.has(key)

    if (!existing && this.map.size >= this.maxSize) {
      const victim = this.evictLeastRecent()
      if (!victim) {
        throw new CacheOverflowError(
          `PinnedLRUMap is full and every entry is pinned (maxSize=${this.maxSize}, pinned=${this.pinned.size})`
        )
      }
    }

    // Re-insert to move to MRU position.
    if (existing) this.map.delete(key)
    this.map.set(key, value)

    if (opts.pinned !== undefined) {
      if (willPin) this.pinned.add(key)
      else this.pinned.delete(key)
    }

    // If the pinned set + unpinned overflows even after eviction, refuse.
    if (this.pinned.size > this.maxSize) {
      this.pinned.delete(key)
      this.map.delete(key)
      throw new CacheOverflowError(
        `PinnedLRUMap overflow: pinning ${String(key)} would exceed maxSize=${this.maxSize}`
      )
    }
  }

  /** Touch ordering without retrieving the value. */
  touch(key: K): void {
    this.get(key)
  }

  pin(key: K): void {
    if (!this.map.has(key)) {
      throw new Error(`PinnedLRUMap.pin: unknown key ${String(key)}`)
    }
    if (this.pinned.has(key)) return
    if (this.pinned.size + 1 > this.maxSize) {
      throw new CacheOverflowError(
        `PinnedLRUMap.pin: pinning ${String(key)} would exceed maxSize=${this.maxSize}`
      )
    }
    this.pinned.add(key)
  }

  unpin(key: K): void {
    this.pinned.delete(key)
  }

  /**
   * Explicit removal — does NOT fire `onEvict`. Use for clean lifecycle
   * transitions (e.g. session ended). LRU eviction is the only path that
   * fires the callback.
   */
  delete(key: K): boolean {
    this.pinned.delete(key)
    return this.map.delete(key)
  }

  clear(): void {
    this.pinned.clear()
    this.map.clear()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  values(): IterableIterator<V> {
    return this.map.values()
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  onEvict(cb: EvictCallback<K, V>): void {
    this.evictCallbacks.push(cb)
  }

  /**
   * Evict the oldest unpinned entry. Returns true if something was evicted,
   * false if every entry is pinned (caller should refuse the insert).
   *
   * Visible for tests/diagnostics.
   */
  evictLeastRecent(): boolean {
    for (const key of this.map.keys()) {
      if (this.pinned.has(key)) continue
      const value = this.map.get(key) as V
      this.map.delete(key)
      for (const cb of this.evictCallbacks) {
        try {
          cb(key, value)
        } catch (err) {
          console.error('[PinnedLRUMap] onEvict callback threw:', err)
        }
      }
      return true
    }
    return false
  }
}
