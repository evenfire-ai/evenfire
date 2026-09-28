import { MemoryStore, type Options } from 'express-rate-limit'

/** Distinct keys one counter accepts per window before it refuses new ones. */
export const PROCESS_MEMORY_MAX_TRACKED_KEYS = 100_000

const WINDOW_MS = 60_000

export type ProcessMemoryDecision =
  | { outcome: 'allowed' | 'denied'; totalHits: number; resetMs: number }
  | { outcome: 'key_cap_reached' }

/**
 * A per-minute counter held in this process's memory. `rateLimitMiddleware`
 * uses it only while the Postgres limiter cannot count a request
 * (`onBackendUnavailable: 'process-memory'`).
 *
 * Each key gets a fixed 60 s window that starts at its first hit
 * (express-rate-limit's `MemoryStore`). A request is allowed while the key's
 * hit count in its window is at most `maxPerMinute`.
 *
 * `MemoryStore` has no key count, so this class records the distinct keys it
 * has seen in its own 60 s window, and refuses a new key once that set holds
 * `maxTrackedKeys`. The store keeps a key until its cleanup timer has run
 * twice without a hit on it, so it can hold a few times `maxTrackedKeys`
 * entries at once; the cap bounds how fast that grows.
 *
 * The set's window is this class's own and does not line up with each key's
 * window in the store. A key whose store window is still running is always
 * admitted, so clearing the set cannot turn a key that is already being
 * counted into a `key_cap_reached` refusal. Such a key was admitted under the
 * cap when its window opened, so this does not raise the bound.
 */
export class ProcessMemoryRateLimiter {
  private readonly store = new MemoryStore()
  private readonly keysThisWindow = new Set<string>()
  private windowStartMs = Date.now()

  constructor(
    private readonly maxPerMinute: number,
    private readonly maxTrackedKeys: number = PROCESS_MEMORY_MAX_TRACKED_KEYS
  ) {
    // MemoryStore.init reads only `windowMs` from the options. It starts an
    // unref'd cleanup timer, so an idle counter does not keep the process up.
    this.store.init({ windowMs: WINDOW_MS } as Options)
  }

  async hit(key: string): Promise<ProcessMemoryDecision> {
    const now = Date.now()
    if (now - this.windowStartMs >= WINDOW_MS) {
      this.keysThisWindow.clear()
      this.windowStartMs = now
    }
    if (!this.keysThisWindow.has(key)) {
      if (
        this.keysThisWindow.size >= this.maxTrackedKeys &&
        !(await this.hasLiveWindow(key, now))
      ) {
        return { outcome: 'key_cap_reached' }
      }
      this.keysThisWindow.add(key)
    }

    const { totalHits, resetTime } = await this.store.increment(key)
    if (resetTime === undefined) {
      throw new Error('express-rate-limit MemoryStore returned a hit without a reset time')
    }
    return {
      outcome: totalHits <= this.maxPerMinute ? 'allowed' : 'denied',
      totalHits,
      resetMs: resetTime.getTime(),
    }
  }

  private async hasLiveWindow(key: string, now: number): Promise<boolean> {
    const client = await this.store.get(key)
    return client?.resetTime !== undefined && client.resetTime.getTime() > now
  }
}
