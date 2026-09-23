import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
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

describe('rateLimitMiddleware denial log', () => {
  beforeEach(() => {
    checkAndIncrement.mockReset()
    hits.inc.mockReset()
  })

  it('logs the SHA-256 of the bucket key, never the key or the user id it carries', async () => {
    const desktopUserId = '5f0c2d1e-7a4b-4c3d-9e8f-0a1b2c3d4e5f'
    const bucketKey = `gfsgrants-ext-read:user:${desktopUserId}`
    const warn = vi.fn()
    checkAndIncrement.mockResolvedValueOnce(available(LIMIT + 1))
    const app = express()
    app.get(
      '/limited',
      (req, _res, next) => {
        ;(req as unknown as { log: { warn: typeof warn } }).log = { warn }
        next()
      },
      rateLimitMiddleware({
        bucketType: 'gfs_grants_external_read',
        maxPerMinute: LIMIT,
        getBucketKey: () => bucketKey,
        onBackendUnavailable: 'closed',
      }),
      (_req, res) => res.status(204).end()
    )

    const response = await request(app).get('/limited')

    expect(response.status).toBe(429)
    // Witness: the denial wrote exactly one line, and it is the denial event.
    expect(warn).toHaveBeenCalledTimes(1)
    const [payload] = warn.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toEqual({
      event: 'rate_limit_denied',
      bucketType: 'gfs_grants_external_read',
      hashedKey: createHash('sha256').update(bucketKey).digest('hex'),
      count: LIMIT + 1,
      maxPerMinute: LIMIT,
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(desktopUserId)
  })
})
