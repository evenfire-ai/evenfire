import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { RateLimitCheck } from '../src/services/rateLimiterService.js'

const checkAndIncrement = vi.hoisted(() => vi.fn())
const hits = vi.hoisted(() => ({ inc: vi.fn() }))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement,
  RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS: 2,
}))
vi.mock('../src/observability/metrics.js', () => ({ rateLimitHitsTotal: hits }))

const { rateLimitMiddleware } = await import('../src/middleware/rateLimitMiddleware.js')

const LIMIT = 5
const resetMs = Date.now() + 30_000

function available(count: number): RateLimitCheck {
  return {
    allowed: count <= LIMIT,
    remaining: Math.max(0, LIMIT - count),
    resetMs,
    windowStartMs: resetMs - 60_000,
    count,
    backendAvailable: true,
  }
}

/** What checkAndIncrement returns when it could not count the request. */
function unavailable(): RateLimitCheck {
  return {
    allowed: true,
    remaining: LIMIT,
    resetMs,
    windowStartMs: resetMs - 60_000,
    count: 0,
    backendAvailable: false,
  }
}

function appWith(onBackendUnavailable: 'open' | 'closed') {
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(204).end()
  })
  const app = express()
  app.get(
    '/limited',
    rateLimitMiddleware({
      bucketType: 'unit_bucket',
      maxPerMinute: LIMIT,
      getBucketKey: () => 'unit:key',
      onBackendUnavailable,
    }),
    handler
  )
  return { app, handler }
}

describe('rateLimitMiddleware backend-unavailable policy', () => {
  beforeEach(() => {
    checkAndIncrement.mockReset()
    hits.inc.mockReset()
  })

  it("'closed' answers 503 with Retry-After when the backend cannot count the request", async () => {
    checkAndIncrement.mockResolvedValueOnce(unavailable())
    const { app, handler } = appWith('closed')

    const response = await request(app).get('/limited')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'rate_limit_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
    // Liveness witness: the limiter was consulted with the caller's key.
    expect(checkAndIncrement).toHaveBeenCalledExactlyOnceWith('unit:key', LIMIT)
    expect(hits.inc).toHaveBeenCalledExactlyOnceWith(
      { bucket_type: 'unit_bucket', result: 'unavailable' },
      1
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it("'open' lets the uncounted request through, as before", async () => {
    checkAndIncrement.mockResolvedValueOnce(unavailable())
    const { app, handler } = appWith('open')

    const response = await request(app).get('/limited')

    expect(response.status).toBe(204)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(checkAndIncrement).toHaveBeenCalledExactlyOnceWith('unit:key', LIMIT)
    expect(hits.inc).toHaveBeenCalledExactlyOnceWith(
      { bucket_type: 'unit_bucket', result: 'allowed' },
      1
    )
  })

  it("'closed' still admits a counted request and still answers 429 over the limit", async () => {
    checkAndIncrement.mockResolvedValueOnce(available(1)).mockResolvedValueOnce(available(6))
    const { app, handler } = appWith('closed')

    const admitted = await request(app).get('/limited')
    const denied = await request(app).get('/limited')

    expect(admitted.status).toBe(204)
    expect(admitted.headers['x-ratelimit-remaining']).toBe('4')
    expect(denied.status).toBe(429)
    expect(denied.body).toMatchObject({ error: 'Too Many Requests' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(hits.inc.mock.calls).toEqual([
      [{ bucket_type: 'unit_bucket', result: 'allowed' }, 1],
      [{ bucket_type: 'unit_bucket', result: 'denied' }, 1],
    ])
  })
})
