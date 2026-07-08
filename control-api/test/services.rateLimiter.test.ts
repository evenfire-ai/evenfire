import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkAndIncrement,
  cleanupExpiredBuckets,
  currentWindowStartMs,
  startRateLimiterCleanup,
  stopRateLimiterCleanup,
} from '../src/services/rateLimiterService.js'

// In-memory simulation of (bucket_key, window_start_ms) → count, matching the
// real rate_limit_buckets unique index semantics.
const buckets = new Map<string, number>()

const mockPoolQuery = vi.fn(async (sql: unknown, params?: unknown[]) => {
  const text = typeof sql === 'string' ? sql : ''
  if (/INSERT INTO rate_limit_buckets/i.test(text)) {
    const bucketKey = String(params?.[0] ?? '')
    const windowStart = Number(params?.[1] ?? 0)
    const mapKey = `${bucketKey}|${windowStart}`
    const next = (buckets.get(mapKey) ?? 0) + 1
    buckets.set(mapKey, next)
    return { rows: [{ count: next }], rowCount: 1 }
  }
  if (/DELETE FROM rate_limit_buckets/i.test(text)) {
    const cutoff = Number(params?.[0] ?? 0)
    let removed = 0
    for (const key of Array.from(buckets.keys())) {
      const windowStart = Number(key.split('|')[1])
      if (windowStart < cutoff) {
        buckets.delete(key)
        removed++
      }
    }
    return { rows: [], rowCount: removed }
  }
  return { rows: [], rowCount: 0 }
})

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(args[0], args[1] as unknown[] | undefined),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

describe('rateLimiterService', () => {
  beforeEach(() => {
    buckets.clear()
    mockPoolQuery.mockClear()
  })

  it('allows requests up to the limit and denies the (limit+1)-th in the same window', async () => {
    const key = 'test:bucket:1'
    const limit = 5
    for (let i = 0; i < limit; i++) {
      const r = await checkAndIncrement(key, limit)
      expect(r.allowed).toBe(true)
      expect(r.count).toBe(i + 1)
      expect(r.remaining).toBe(limit - (i + 1))
    }
    const over = await checkAndIncrement(key, limit)
    expect(over.allowed).toBe(false)
    expect(over.count).toBe(limit + 1)
    expect(over.remaining).toBe(0)
  })

  it('exposes resetMs aligned to the next 60s window boundary', async () => {
    const nowMs = 1_700_000_000_000
    const r = await checkAndIncrement('test:bucket:reset', 10, nowMs)
    expect(r.windowStartMs).toBe(Math.floor(nowMs / 60_000) * 60_000)
    expect(r.resetMs).toBe(r.windowStartMs + 60_000)
    expect(r.resetMs - nowMs).toBeLessThanOrEqual(60_000)
  })

  it('rolls over to a fresh slot when the 60s window advances', async () => {
    const key = 'test:bucket:roll'
    const limit = 2
    const t0 = 1_700_000_000_000 // aligned to minute start
    // Fill the window at t0.
    await checkAndIncrement(key, limit, t0)
    await checkAndIncrement(key, limit, t0)
    const denied = await checkAndIncrement(key, limit, t0)
    expect(denied.allowed).toBe(false)

    // New window (+60_001 ms) — fresh counter.
    const fresh = await checkAndIncrement(key, limit, t0 + 60_001)
    expect(fresh.allowed).toBe(true)
    expect(fresh.count).toBe(1)
  })

  it('concurrent increments observe distinct counter values (no race)', async () => {
    const key = 'test:bucket:concurrent'
    const limit = 100
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkAndIncrement(key, limit))
    )
    const counts = results.map(r => r.count).sort((a, b) => a - b)
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(results.every(r => r.allowed)).toBe(true)
  })

  it('fails open when pool.query throws (DB error)', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('connection refused'))
    const r = await checkAndIncrement('test:bucket:failopen', 5)
    expect(r.allowed).toBe(true)
    expect(r.count).toBe(0)
    expect(r.remaining).toBe(5)
  })

  it('fails open when pool.query returns empty rows', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const r = await checkAndIncrement('test:bucket:emptyrows', 5)
    expect(r.allowed).toBe(true)
    expect(r.count).toBe(0)
  })

  it('cleanupExpiredBuckets removes rows older than 5 minutes', async () => {
    const now = 1_700_000_000_000
    // Seed two buckets: one old (>5 min ago), one fresh.
    const oldKey = `old-bucket|${now - 10 * 60_000}` // 10 min ago
    const freshKey = `fresh-bucket|${now - 60_000}` // 1 min ago
    buckets.set(oldKey, 1)
    buckets.set(freshKey, 1)

    const removed = await cleanupExpiredBuckets(now)
    expect(removed).toBe(1)
    expect(buckets.has(oldKey)).toBe(false)
    expect(buckets.has(freshKey)).toBe(true)
  })

  it('currentWindowStartMs floors now to the minute boundary', () => {
    const minuteStart = 1_700_000_040_000 // divisible by 60_000
    expect(minuteStart % 60_000).toBe(0)
    const t = minuteStart + 37_000 // 37s past a minute
    expect(currentWindowStartMs(t)).toBe(minuteStart)
    expect(currentWindowStartMs(minuteStart)).toBe(minuteStart)
  })

  it('startRateLimiterCleanup + stopRateLimiterCleanup are idempotent', () => {
    // No assertion beyond "does not throw" — this is a lifecycle smoke test.
    startRateLimiterCleanup(60_000)
    startRateLimiterCleanup(60_000) // second call is no-op
    stopRateLimiterCleanup()
    stopRateLimiterCleanup() // double stop is safe
  })
})
