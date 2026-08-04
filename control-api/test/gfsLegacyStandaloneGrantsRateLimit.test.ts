import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// Route-level regression guard for the rate limiter on the legacy-standalone
// grant report (CodeQL #795 fix). The limiter service itself is covered
// elsewhere; what was untested is the WIRING — that this specific route still
// runs the limiter, keyed per-admin on its own bucket, before doing any
// database work. Dropping `legacyGrantReportRateLimit` from the route would
// leave every assertion here failing rather than silently un-limiting an
// authenticated endpoint.
const ADMIN_SUB = vi.hoisted(() => 'admin-42')
const mockQuery = vi.hoisted(() => vi.fn())
const mockCheckAndIncrement = vi.hoisted(() => vi.fn())

vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))

// Mirrors the real middleware's contract: it authenticates and publishes the
// admin claims on the request. The limiter keys on `adminAuth.sub`, so the
// stub must populate it exactly like `requireAuthForControlUI` does.
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.header('x-test-auth') !== 'operator') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    ;(req as express.Request & { adminAuth?: { sub: string } }).adminAuth = { sub: ADMIN_SUB }
    next()
  },
}))

const RESOURCE_ID = '20000000-0000-4000-8000-000000000001'

function allowed(remaining = 29) {
  return {
    allowed: true,
    remaining,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 30 - remaining,
  }
}

function denied() {
  return {
    allowed: false,
    remaining: 0,
    resetMs: Date.now() + 30_000,
    windowStartMs: Date.now(),
    count: 31,
  }
}

async function buildApp() {
  const { registerLegacyStandaloneGrantReportRoute } =
    await import('../src/routes/gfs/legacyStandaloneGrants.js')
  const router = express.Router()
  registerLegacyStandaloneGrantReportRoute(router)
  const app = express()
  app.use(express.json())
  app.use(router)
  return app
}

describe('GET /gfs/grants/legacy-standalone rate limiting', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockCheckAndIncrement.mockReset()
  })

  it('serves the report and consumes its own per-admin bucket when under the limit', async () => {
    mockCheckAndIncrement.mockResolvedValue(allowed())
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          drive: 'main',
          resource_id: RESOURCE_ID,
          permissions: ['read'],
          inherit: true,
        },
      ],
    })

    const response = await request(await buildApp())
      .get('/gfs/grants/legacy-standalone')
      .set('x-test-auth', 'operator')

    // Operability: the limiter must not stand between an operator and a
    // legitimate report — the normal path still returns the inventory.
    expect(response.status).toBe(200)
    expect(response.body.grants).toHaveLength(1)
    // Wiring proof: the route consumed the DEDICATED bucket key at the
    // documented 30/min ceiling, not the grant-mutation bucket and not some
    // shared/unkeyed budget.
    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(1)
    expect(mockCheckAndIncrement).toHaveBeenCalledWith(`gfsgrants-legacy:${ADMIN_SUB}`, 30)
  })

  it('returns 429 with Retry-After and never reaches the database once the bucket is exhausted', async () => {
    mockCheckAndIncrement.mockResolvedValue(denied())

    const response = await request(await buildApp())
      .get('/gfs/grants/legacy-standalone')
      .set('x-test-auth', 'operator')

    expect(response.status).toBe(429)
    expect(response.body).toMatchObject({ error: 'Too Many Requests' })
    expect(response.body.retryAfterSeconds).toBeGreaterThan(0)
    expect(response.headers['retry-after']).toBeDefined()
    expect(response.headers['x-ratelimit-limit']).toBe('30')
    expect(response.headers['x-ratelimit-remaining']).toBe('0')
    // The property that makes this a DoS control rather than a cosmetic header:
    // the request is rejected BEFORE the handler runs its Postgres query.
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated callers before the limiter spends a token', async () => {
    const response = await request(await buildApp()).get('/gfs/grants/legacy-standalone')

    expect(response.status).toBe(401)
    // Auth precedes the limiter, so an anonymous flood cannot drain a real
    // admin's bucket (and the limiter's key is never null in practice).
    expect(mockCheckAndIncrement).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
