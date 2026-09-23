import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROCESS_MEMORY_MAX_TRACKED_KEYS,
  ProcessMemoryRateLimiter,
} from '../src/middleware/processMemoryRateLimiter.js'

const START_MS = 1_800_000_000_000

describe('ProcessMemoryRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows maxPerMinute hits per key in a 60 s window that starts at the first hit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START_MS)
    const limiter = new ProcessMemoryRateLimiter(2)

    const first = await limiter.hit('a')
    vi.setSystemTime(START_MS + 10_000)
    const second = await limiter.hit('a')
    const third = await limiter.hit('a')
    const otherKey = await limiter.hit('b')
    vi.setSystemTime(START_MS + 60_000)
    const nextWindow = await limiter.hit('a')

    expect(first).toEqual({ outcome: 'allowed', totalHits: 1, resetMs: START_MS + 60_000 })
    expect(second).toEqual({ outcome: 'allowed', totalHits: 2, resetMs: START_MS + 60_000 })
    expect(third).toEqual({ outcome: 'denied', totalHits: 3, resetMs: START_MS + 60_000 })
    expect(otherKey).toEqual({ outcome: 'allowed', totalHits: 1, resetMs: START_MS + 70_000 })
    expect(nextWindow).toEqual({ outcome: 'allowed', totalHits: 1, resetMs: START_MS + 120_000 })
  })

  it('refuses a new key once maxTrackedKeys keys are tracked in the window, and accepts new keys in the next window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START_MS)
    const limiter = new ProcessMemoryRateLimiter(5, 2)

    expect((await limiter.hit('a')).outcome).toBe('allowed')
    expect((await limiter.hit('b')).outcome).toBe('allowed')
    expect(await limiter.hit('c')).toEqual({ outcome: 'key_cap_reached' })
    // Witness: a tracked key is still counted while the cap refuses new ones.
    expect(await limiter.hit('a')).toMatchObject({ outcome: 'allowed', totalHits: 2 })

    vi.setSystemTime(START_MS + 60_000)
    expect(await limiter.hit('c')).toMatchObject({ outcome: 'allowed', totalHits: 1 })
  })

  it('tracks at most 100 000 keys by default', async () => {
    expect(PROCESS_MEMORY_MAX_TRACKED_KEYS).toBe(100_000)
    const limiter = new ProcessMemoryRateLimiter(1)
    for (let n = 0; n < 100_000; n += 1) {
      const decision = await limiter.hit(`key:${n}`)
      if (decision.outcome !== 'allowed') throw new Error(`key:${n}: ${decision.outcome}`)
    }
    expect(await limiter.hit('key:100000')).toEqual({ outcome: 'key_cap_reached' })
    // Witness: the counter was live for the keys under the cap.
    expect(await limiter.hit('key:0')).toMatchObject({ outcome: 'denied', totalHits: 2 })
  })
})
