/**
 * TTL-based Map store for pending results.
 * Replaces duplicate cleanup logic in main.ts.
 */
export class ResultStore<T> {
  private store = new Map<string, T>()

  constructor(
    private readonly ttlMs: number,
    private readonly getTimestamp: (entry: T) => number
  ) {}

  set(id: string, entry: T): void {
    this.store.set(id, entry)
  }

  get(id: string): T | undefined {
    this.cleanup()
    return this.store.get(id)
  }

  delete(id: string): boolean {
    return this.store.delete(id)
  }

  getAndDelete(id: string): T | undefined {
    this.cleanup()
    const entry = this.store.get(id)
    if (entry) this.store.delete(id)
    return entry
  }

  entries(): Array<[string, T]> {
    this.cleanup()
    return Array.from(this.store.entries())
  }

  /**
   * Number of live (non-expired) entries. Used by the stateless heartbeat's
   * `pendingResults` condition (Stage 3, stateless-agents).
   */
  size(): number {
    this.cleanup()
    return this.store.size
  }

  /**
   * Number of live (non-expired) entries matching `predicate`. Used by the
   * stateless heartbeat's `pendingResults` gauge to exclude recoverability-only
   * cache entries (e.g. C3 inline-delivered sync results) that were already
   * consumed by their caller and therefore are NOT genuinely-pending work.
   */
  countWhere(predicate: (entry: T) => boolean): number {
    this.cleanup()
    let n = 0
    for (const entry of this.store.values()) {
      if (predicate(entry)) n++
    }
    return n
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [id, entry] of this.store) {
      if (now - this.getTimestamp(entry) > this.ttlMs) {
        this.store.delete(id)
      }
    }
  }
}
