/**
 * Per-plugin token buckets (spec §6.9).
 *
 * Two layers, both required:
 *   - per (plugin, capability), so a chatty `gfs.list` cannot starve anything;
 *   - per plugin across all capabilities, so a plugin cannot round-robin its
 *     way past the per-capability budgets.
 *
 * Buckets refill continuously rather than resetting on a window boundary, so a
 * plugin polling at the limit degrades smoothly instead of getting a burst
 * every 60 s. `now` is injectable for tests.
 */

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number }

export type RateLimitSpec = { perMinute: number; perHour: number }

type Bucket = { tokens: number; capacity: number; refillPerMs: number; updatedAt: number }

/** Global ceiling across every capability of one plugin (spec §6.9). */
export const PLUGIN_GLOBAL_LIMIT: RateLimitSpec = { perMinute: 120, perHour: 2400 }

function makeBucket(capacity: number, perMs: number, now: number): Bucket {
  return { tokens: capacity, capacity, refillPerMs: perMs, updatedAt: now }
}

function refill(bucket: Bucket, now: number): void {
  const elapsed = Math.max(0, now - bucket.updatedAt)
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs)
  bucket.updatedAt = now
}

/**
 * Refill both buckets of a pair, then take a token from each only if BOTH have
 * capacity. Checking before committing means a request denied by one window
 * never spends a token in the other — so the limiter stays exactly as strict as
 * the spec and no token is silently lost between the minute/hour windows.
 */
function tryTakePair(pair: [Bucket, Bucket], now: number): RateLimitDecision {
  for (const bucket of pair) refill(bucket, now)
  for (const bucket of pair) {
    if (bucket.tokens < 1) {
      // Time until one whole token exists again in the starved window.
      const deficit = 1 - bucket.tokens
      return { allowed: false, retryAfterMs: Math.ceil(deficit / bucket.refillPerMs) }
    }
  }
  for (const bucket of pair) bucket.tokens -= 1
  return { allowed: true }
}

export class PluginRateLimiter {
  /** key → [minuteBucket, hourBucket] */
  private readonly buckets = new Map<string, [Bucket, Bucket]>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  private pair(key: string, spec: RateLimitSpec): [Bucket, Bucket] {
    const existing = this.buckets.get(key)
    if (existing) return existing
    const t = this.now()
    const created: [Bucket, Bucket] = [
      makeBucket(spec.perMinute, spec.perMinute / 60_000, t),
      makeBucket(spec.perHour, spec.perHour / 3_600_000, t),
    ]
    this.buckets.set(key, created)
    return created
  }

  /**
   * Consume one token from the capability bucket AND the plugin-global bucket.
   * Both pairs must have capacity in both their windows; a denial anywhere spends
   * nothing. If the capability pair allows but the global pair denies, the
   * capability tokens are refunded so a globally throttled plugin does not also
   * burn its per-capability budget.
   */
  take(pluginId: string, capability: string, spec: RateLimitSpec): RateLimitDecision {
    const now = this.now()
    const capPair = this.pair(`${pluginId}::${capability}`, spec)
    const globalPair = this.pair(`${pluginId}::*`, PLUGIN_GLOBAL_LIMIT)

    const capDecision = tryTakePair(capPair, now)
    if (!capDecision.allowed) return capDecision

    const globalDecision = tryTakePair(globalPair, now)
    if (!globalDecision.allowed) {
      for (const b of capPair) b.tokens = Math.min(b.capacity, b.tokens + 1)
      return globalDecision
    }
    return { allowed: true }
  }

  /** Drop a plugin's budgets on unmount so a fresh session starts clean. */
  reset(pluginId: string): void {
    for (const key of [...this.buckets.keys()]) {
      if (key.startsWith(`${pluginId}::`)) this.buckets.delete(key)
    }
  }

  resetAll(): void {
    this.buckets.clear()
  }
}
