import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { MemoryStore } from 'express-rate-limit'
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

function appWith(onBackendUnavailable: 'process-memory' | 'closed') {
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(204).end()
  })
  const warn = vi.fn()
  const app = express()
  app.get(
    '/limited',
    (req, _res, next) => {
      ;(req as unknown as { log: { warn: typeof warn } }).log = { warn }
      next()
    },
    rateLimitMiddleware({
      bucketType: 'unit_bucket',
      maxPerMinute: LIMIT,
      getBucketKey: () => 'unit:key',
      onBackendUnavailable,
    }),
    handler
  )
  return { app, handler, warn }
}

describe('rateLimitMiddleware backend-unavailable policy', () => {
  beforeEach(() => {
    checkAndIncrement.mockReset()
    hits.inc.mockReset()
  })

  it("'closed' answers 503 with Retry-After when the backend cannot count the request", async () => {
    checkAndIncrement.mockResolvedValueOnce(unavailable())
    const { app, handler, warn } = appWith('closed')

    const response = await request(app).get('/limited')

    expect(response.status).toBe(503)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { event: 'rate_limit_unavailable', bucketType: 'unit_bucket', suppressed: 0 },
      'rate limit backend unavailable'
    )
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

  it("'closed' writes one warn line per minute while the backend is down, and counts every 503", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_800_000_000_000)
      checkAndIncrement.mockResolvedValue(unavailable())
      const { app, handler, warn } = appWith('closed')

      const statuses: number[] = []
      for (let n = 0; n < 50; n += 1) statuses.push((await request(app).get('/limited')).status)

      // Witness: all 50 reached the limiter and were refused.
      expect(statuses.filter(status => status === 503)).toHaveLength(50)
      expect(checkAndIncrement).toHaveBeenCalledTimes(50)
      expect(hits.inc).toHaveBeenCalledTimes(50)
      expect(warn).toHaveBeenCalledTimes(1)

      vi.setSystemTime(1_800_000_060_000)
      expect((await request(app).get('/limited')).status).toBe(503)
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[1]![0]).toMatchObject({
        event: 'rate_limit_unavailable',
        suppressed: 49,
      })
      expect(handler).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("'process-memory' counts in memory while the backend cannot count, and answers 429 over the limit", async () => {
    checkAndIncrement.mockResolvedValue(unavailable())
    const { app, handler, warn } = appWith('process-memory')

    const responses: request.Response[] = []
    for (let n = 0; n <= LIMIT; n += 1) responses.push(await request(app).get('/limited'))

    // Witness: every request reached the Postgres limiter first.
    expect(checkAndIncrement).toHaveBeenCalledTimes(LIMIT + 1)
    expect(responses.slice(0, LIMIT).map(response => response.status)).toEqual(
      Array.from({ length: LIMIT }, () => 204)
    )
    expect(
      responses.slice(0, LIMIT).map(response => response.headers['x-ratelimit-remaining'])
    ).toEqual(['4', '3', '2', '1', '0'])
    expect(handler).toHaveBeenCalledTimes(LIMIT)

    const denied = responses[LIMIT]!
    expect(denied.status).toBe(429)
    const retryAfterSeconds = Number(denied.headers['retry-after'])
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(denied.body).toEqual({ error: 'Too Many Requests', retryAfterSeconds })
    expect(denied.headers['x-ratelimit-limit']).toBe(String(LIMIT))
    expect(denied.headers['x-ratelimit-remaining']).toBe('0')
    expect(Number(denied.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000)

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      {
        event: 'rate_limit_denied',
        bucketType: 'unit_bucket',
        hashedKey: createHash('sha256').update('unit:key').digest('hex'),
        count: LIMIT + 1,
        maxPerMinute: LIMIT,
        source: 'process-memory',
      },
      'rate limit exceeded'
    )
    expect(hits.inc.mock.calls).toEqual([
      ...Array.from({ length: LIMIT }, () => [
        { bucket_type: 'unit_bucket', result: 'fallback_allowed' },
        1,
      ]),
      [{ bucket_type: 'unit_bucket', result: 'fallback_denied' }, 1],
    ])
  })

  it("'process-memory' leaves the decision to Postgres again once the backend can count", async () => {
    const increment = vi.spyOn(MemoryStore.prototype, 'increment')
    try {
      for (let n = 0; n <= LIMIT; n += 1) checkAndIncrement.mockResolvedValueOnce(unavailable())
      checkAndIncrement.mockResolvedValueOnce(available(1))
      const { app, handler } = appWith('process-memory')

      const statuses: number[] = []
      for (let n = 0; n <= LIMIT + 1; n += 1)
        statuses.push((await request(app).get('/limited')).status)

      // The in-memory counter is exhausted, yet the counted request passes:
      // Postgres decided it, and the in-memory store was not consulted.
      expect(statuses).toEqual([...Array.from({ length: LIMIT }, () => 204), 429, 204])
      expect(increment).toHaveBeenCalledTimes(LIMIT + 1)
      // Liveness witness: the last request reached the Postgres limiter and the handler.
      expect(checkAndIncrement).toHaveBeenCalledTimes(LIMIT + 2)
      expect(handler).toHaveBeenCalledTimes(LIMIT + 1)
      expect(hits.inc.mock.calls.at(-1)).toEqual([
        { bucket_type: 'unit_bucket', result: 'allowed' },
        1,
      ])
    } finally {
      increment.mockRestore()
    }
  })

  it("'process-memory' answers 503 for a new key once 100 000 keys are tracked, and still counts tracked keys", async () => {
    checkAndIncrement.mockResolvedValue(unavailable())
    const middleware = rateLimitMiddleware({
      bucketType: 'unit_bucket',
      maxPerMinute: LIMIT,
      getBucketKey: req => req.headers['x-key'] as string,
      onBackendUnavailable: 'process-memory',
    })
    // Driven without HTTP: 100 001 supertest round trips would take minutes.
    type Outcome = {
      next: boolean
      status?: number
      body?: unknown
      headers: Record<string, string>
    }
    const call = (key: string) =>
      new Promise<Outcome>((resolve, reject) => {
        const headers: Record<string, string> = {}
        const res = {
          statusCode: 200,
          setHeader(name: string, value: string) {
            headers[name.toLowerCase()] = value
          },
          removeHeader(name: string) {
            delete headers[name.toLowerCase()]
          },
          status(code: number) {
            this.statusCode = code
            return this
          },
          json(body: unknown) {
            resolve({ next: false, status: this.statusCode, body, headers })
          },
        }
        const req = { headers: { 'x-key': key } }
        middleware(req as never, res as never, (err?: unknown) =>
          err ? reject(err) : resolve({ next: true, headers })
        )
      })

    for (let n = 0; n < 100_000; n += 1) {
      const outcome = await call(`key:${n}`)
      if (!outcome.next) throw new Error(`key:${n} was not admitted: ${JSON.stringify(outcome)}`)
    }
    const overCap = await call('key:100000')
    const tracked = await call('key:0')

    expect(overCap).toEqual({
      next: false,
      status: 503,
      body: { error: 'rate_limit_unavailable', retryAfterSeconds: 2 },
      headers: { 'retry-after': '2', 'cache-control': 'no-store' },
    })
    // Witness: a key already tracked is still counted in memory (its second hit).
    expect(tracked).toEqual({
      next: true,
      headers: expect.objectContaining({ 'x-ratelimit-remaining': String(LIMIT - 2) }),
    })
    expect(checkAndIncrement).toHaveBeenCalledTimes(100_002)
    expect(hits.inc.mock.calls.at(-2)).toEqual([
      { bucket_type: 'unit_bucket', result: 'unavailable' },
      1,
    ])
    expect(hits.inc.mock.calls.at(-1)).toEqual([
      { bucket_type: 'unit_bucket', result: 'fallback_allowed' },
      1,
    ])
  }, 60_000)

  it("'closed' 503 carries no X-RateLimit-* headers left by an earlier limiter on the route", async () => {
    // First limiter counts and admits; the second cannot reach its backend.
    checkAndIncrement.mockResolvedValueOnce(available(1)).mockResolvedValueOnce(unavailable())
    const handler = vi.fn((_req: express.Request, res: express.Response) => res.status(204).end())
    const app = express()
    app.get(
      '/limited',
      (req, _res, next) => {
        ;(req as unknown as { log: { warn: () => void } }).log = { warn: () => {} }
        next()
      },
      rateLimitMiddleware({
        bucketType: 'first_bucket',
        maxPerMinute: LIMIT,
        getBucketKey: () => 'first:key',
        onBackendUnavailable: 'closed',
      }),
      rateLimitMiddleware({
        bucketType: 'second_bucket',
        maxPerMinute: LIMIT,
        getBucketKey: () => 'second:key',
        onBackendUnavailable: 'closed',
      }),
      handler
    )

    const response = await request(app).get('/limited')

    expect(response.status).toBe(503)
    // Witness: both limiters ran, the first one admitting the request.
    expect(checkAndIncrement.mock.calls).toEqual([
      ['first:key', LIMIT],
      ['second:key', LIMIT],
    ])
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['x-ratelimit-limit']).toBeUndefined()
    expect(response.headers['x-ratelimit-remaining']).toBeUndefined()
    expect(response.headers['x-ratelimit-reset']).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('bounds an oversized bucket key before it reaches either backend, and keeps it stable', async () => {
    const huge = `unit:${'x'.repeat(10_000)}`
    checkAndIncrement.mockResolvedValue(unavailable())
    const middleware = rateLimitMiddleware({
      bucketType: 'unit_bucket',
      maxPerMinute: LIMIT,
      getBucketKey: () => huge,
      onBackendUnavailable: 'process-memory',
    })
    const increment = vi.spyOn(MemoryStore.prototype, 'increment')
    try {
      const app = express()
      app.get(
        '/limited',
        (req, _res, next) => {
          ;(req as unknown as { log: { warn: () => void } }).log = { warn: () => {} }
          next()
        },
        middleware,
        (_req, res) => res.status(204).end()
      )

      const first = await request(app).get('/limited')
      const second = await request(app).get('/limited')

      expect([first.status, second.status]).toEqual([204, 204])
      // Same key both times, so the in-memory count still accumulates.
      expect(second.headers['x-ratelimit-remaining']).toBe(String(LIMIT - 2))
      // Witness: the Postgres limiter and the in-memory store were both reached.
      expect(checkAndIncrement).toHaveBeenCalledTimes(2)
      expect(increment).toHaveBeenCalledTimes(2)
      const postgresKeys = checkAndIncrement.mock.calls.map(([key]) => key as string)
      const memoryKeys = increment.mock.calls.map(([key]) => key)
      const bounded = `sha256-long-key:${createHash('sha256').update(huge).digest('hex')}`
      expect(postgresKeys).toEqual([bounded, bounded])
      expect(memoryKeys).toEqual([bounded, bounded])
    } finally {
      increment.mockRestore()
    }
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
