import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockCheckAndIncrement = vi.hoisted(() => vi.fn())
const mockWithTransaction = vi.hoisted(() => vi.fn())

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))

vi.mock('../src/observability/metrics.js', () => ({
  rateLimitHitsTotal: { inc: vi.fn() },
}))

vi.mock('../src/db.js', () => ({
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}))

vi.mock('../src/middleware/internalControlJwt.js', () => ({
  requireInternalControlJwt: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.header('x-test-auth') !== 'hcc') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.internalControl = {
      iss: 'hcc',
      aud: 'control-api',
      sub: 'host-context-controller',
      iat: 1,
      exp: 2,
      jti: 'rotating-token-id',
    }
    next()
  },
}))

function allowed() {
  return {
    allowed: true,
    remaining: 29,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
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
  const { registerGfsSeedRoute } = await import('../src/routes/gfs/seed.js')
  const router = express.Router()
  registerGfsSeedRoute(router)
  const app = express()
  app.use(express.json())
  app.use(router)
  return app
}

describe('POST /gfs/seed rate limiting', () => {
  beforeEach(() => {
    mockCheckAndIncrement.mockReset()
    mockWithTransaction.mockReset()
    mockWithTransaction.mockImplementation(
      async (work: (db: Record<string, never>) => Promise<unknown>) => work({})
    )
  })

  it('uses a stable per-provisioner bucket after authentication', async () => {
    mockCheckAndIncrement.mockResolvedValue(allowed())

    const response = await request(await buildApp())
      .post('/gfs/seed')
      .set('x-test-auth', 'hcc')
      .send({})

    expect(response.status).toBe(400)
    expect(mockCheckAndIncrement).toHaveBeenCalledWith('gfsseed:hcc:host-context-controller', 30)
    expect(mockWithTransaction).toHaveBeenCalledTimes(1)
  })

  it('returns 429 without starting a seed transaction when the bucket is exhausted', async () => {
    mockCheckAndIncrement.mockResolvedValue(denied())

    const response = await request(await buildApp())
      .post('/gfs/seed')
      .set('x-test-auth', 'hcc')
      .send({ drive: 'main', rootDirectories: [] })

    expect(response.status).toBe(429)
    expect(response.body).toMatchObject({ error: 'Too Many Requests' })
    expect(response.headers['retry-after']).toBeDefined()
    expect(mockWithTransaction).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated callers before consuming rate-limit budget', async () => {
    const response = await request(await buildApp())
      .post('/gfs/seed')
      .send({})

    expect(response.status).toBe(401)
    expect(mockCheckAndIncrement).not.toHaveBeenCalled()
    expect(mockWithTransaction).not.toHaveBeenCalled()
  })
})
