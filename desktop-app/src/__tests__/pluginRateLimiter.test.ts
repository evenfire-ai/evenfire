import { describe, expect, it } from 'vitest'
import { PLUGIN_GLOBAL_LIMIT, PluginRateLimiter } from '../pluginRateLimiter.js'

const PLUGIN = 'ns/plugin'
const CAP = 'gfs.read'

/** A limiter whose clock is a mutable number we advance by hand. */
function makeLimiter(startAt = 0): { limiter: PluginRateLimiter; advance: (ms: number) => void } {
  let clock = startAt
  const limiter = new PluginRateLimiter(() => clock)
  return { limiter, advance: (ms: number) => (clock += ms) }
}

describe('PluginRateLimiter', () => {
  it('allows up to the per-minute budget, then denies on the minute window', () => {
    const { limiter } = makeLimiter()
    const spec = { perMinute: 3, perHour: 100 }
    for (let i = 0; i < 3; i++) {
      expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(true)
    }
    const denied = limiter.take(PLUGIN, CAP, spec)
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) {
      // One per-minute token refills after 60_000 / 3 = 20_000 ms.
      expect(denied.retryAfterMs).toBe(20_000)
    }
  })

  it('does not spend a minute token when the hour window denies (intra-pair refund)', () => {
    // Reviewer repro (R1-M1/R1-M6): perMinute:5, perHour:2. After two allowed
    // calls the hour bucket is empty; every further call must be denied by the
    // HOUR window, never over-charge the minute window. Pre-fix, the third call
    // spent a minute token and a later call got denied by *minute* (retryAfter
    // 12_000) after only two successes.
    const { limiter } = makeLimiter()
    const spec = { perMinute: 5, perHour: 2 }

    expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(true)
    expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(true)

    // ms for one per-hour token to refill (computed as the limiter does it).
    const hourRetry = Math.ceil(1 / (spec.perHour / 3_600_000))
    const minuteRetry = Math.ceil(1 / (spec.perMinute / 60_000)) // 12_000
    for (let i = 0; i < 4; i++) {
      const denied = limiter.take(PLUGIN, CAP, spec)
      expect(denied.allowed).toBe(false)
      if (!denied.allowed) {
        // Always the hour window — the minute window is never the limiter here,
        // proving no minute token was silently consumed on a denied call.
        expect(denied.retryAfterMs).toBe(hourRetry)
        expect(denied.retryAfterMs).not.toBe(minuteRetry)
      }
    }
  })

  it('refunds the capability tokens when the global window denies', () => {
    // Drive the plugin-global minute ceiling to empty using a cheap capability,
    // then a DIFFERENT capability (with its own fresh budget) must still be
    // denied by the global window — and get its capability tokens back, so once
    // the global window refills it is immediately usable again.
    const { limiter, advance } = makeLimiter()
    const cheap = { perMinute: PLUGIN_GLOBAL_LIMIT.perMinute + 10, perHour: 100_000 }
    for (let i = 0; i < PLUGIN_GLOBAL_LIMIT.perMinute; i++) {
      expect(limiter.take(PLUGIN, 'gfs.list', cheap).allowed).toBe(true)
    }

    const other = { perMinute: 5, perHour: 50 }
    const deniedByGlobal = limiter.take(PLUGIN, 'gfs.read', other)
    expect(deniedByGlobal.allowed).toBe(false)

    // Refill exactly one global-minute token; the capability pair was refunded,
    // so 'gfs.read' still has its full budget and the call now succeeds.
    advance(Math.ceil(60_000 / PLUGIN_GLOBAL_LIMIT.perMinute))
    expect(limiter.take(PLUGIN, 'gfs.read', other).allowed).toBe(true)
  })

  it('refills continuously over time', () => {
    const { limiter, advance } = makeLimiter()
    const spec = { perMinute: 2, perHour: 100 }
    expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(true)
    expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(true)
    expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(false)

    advance(30_000) // one per-minute token (60_000 / 2)
    expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(true)
    expect(limiter.take(PLUGIN, CAP, spec).allowed).toBe(false)
  })

  it('keeps separate budgets per plugin and clears them on reset', () => {
    const { limiter } = makeLimiter()
    const spec = { perMinute: 1, perHour: 100 }
    expect(limiter.take('ns/a', CAP, spec).allowed).toBe(true)
    expect(limiter.take('ns/a', CAP, spec).allowed).toBe(false)
    // A different plugin is unaffected.
    expect(limiter.take('ns/b', CAP, spec).allowed).toBe(true)
    // Reset restores plugin a's budget.
    limiter.reset('ns/a')
    expect(limiter.take('ns/a', CAP, spec).allowed).toBe(true)
  })
})
