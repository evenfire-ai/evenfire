import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Options } from 'express-rate-limit'
import { CalendarMinuteRateLimitStore } from '../src/middleware/calendarMinuteRateLimitStore.js'

describe('CalendarMinuteRateLimitStore', () => {
  let store: CalendarMinuteRateLimitStore

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T12:00:17.500Z'))
    store = new CalendarMinuteRateLimitStore()
    store.init({ windowMs: 60_000 } as Options)
  })

  afterEach(() => {
    store.shutdown()
    vi.useRealTimers()
  })

  it('reports the calendar boundary and restores a verified principal at that boundary after an offset first hit', async () => {
    const key = 'plugin_workload_sdk_internal_edge:wrc:wrc-provisioner'
    await expect(store.increment(key)).resolves.toEqual({
      totalHits: 1,
      resetTime: new Date('2026-10-02T12:01:00.000Z'),
    })
    await store.increment(key)
    await expect(store.get(key)).resolves.toEqual({
      totalHits: 2,
      resetTime: new Date('2026-10-02T12:01:00.000Z'),
    })
    await vi.advanceTimersByTimeAsync(42_500)
    await expect(store.get(key)).resolves.toBeUndefined()
    await expect(store.increment(key)).resolves.toEqual({
      totalHits: 1,
      resetTime: new Date('2026-10-02T12:02:00.000Z'),
    })
  })

  it('retains the anonymous source-IP first-hit window across a calendar boundary', async () => {
    const key = 'plugin_workload_sdk_internal_edge:ip:198.51.100.9'
    await expect(store.increment(key)).resolves.toEqual({
      totalHits: 1,
      resetTime: new Date('2026-10-02T12:01:17.500Z'),
    })
    await vi.advanceTimersByTimeAsync(42_500)
    await expect(store.increment(key)).resolves.toEqual({
      totalHits: 2,
      resetTime: new Date('2026-10-02T12:01:17.500Z'),
    })
    await vi.advanceTimersByTimeAsync(17_500)
    await expect(store.increment(key)).resolves.toEqual({
      totalHits: 1,
      resetTime: new Date('2026-10-02T12:02:17.500Z'),
    })
  })

  it('uses the same scoped key for decrement and reset without affecting another principal', async () => {
    const first = 'plugin_workload_sdk_preauth:recipe-one'
    const second = 'plugin_workload_sdk_preauth:recipe-two'
    await store.increment(first)
    await store.increment(first)
    await store.increment(second)
    await store.decrement(first)
    await expect(store.get(first)).resolves.toMatchObject({ totalHits: 1 })
    await store.resetKey(first)
    await expect(store.get(first)).resolves.toBeUndefined()
    await expect(store.get(second)).resolves.toMatchObject({ totalHits: 1 })
  })
})
