import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { CONTROL_UI_ADMIN_SESSION_COOKIE } from '../src/utils/auth/sessionCookies.js'

const limiterState = vi.hoisted(() => ({
  calls: [] as Array<{ key: string; maxPerMinute: number }>,
  counts: new Map<string, number>(),
  unavailableAtCall: new Set<number>(),
}))
const auth = vi.hoisted(() => ({ authenticateAdminSession: vi.fn() }))
const stream = vi.hoisted(() => ({ streamEntityChanges: vi.fn() }))
const metrics = vi.hoisted(() => ({ rateLimitHitsTotal: { inc: vi.fn() } }))

vi.mock('../src/config.js', () => ({
  config: {
    approvalRlRequestPerMin: 120,
    adminPublicTokenRlPerMin: 1,
    adminPublicTokenIpRlPerMin: 20,
  },
}))
vi.mock('../src/services/adminSessionAuth.js', () => auth)
vi.mock('../src/routes/entityChangeStream.js', () => ({
  parseRequestedEntityChangeCursor: () => null,
  streamEntityChanges: stream.streamEntityChanges,
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS: 2,
  checkAndIncrement: vi.fn(async (key: string, maxPerMinute: number) => {
    const callNumber = limiterState.calls.length + 1
    limiterState.calls.push({ key, maxPerMinute })
    if (limiterState.unavailableAtCall.has(callNumber)) {
      return {
        allowed: true,
        remaining: maxPerMinute,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 0,
        backendAvailable: false,
      }
    }
    const count = (limiterState.counts.get(key) ?? 0) + 1
    limiterState.counts.set(key, count)
    return {
      allowed: count <= maxPerMinute,
      remaining: Math.max(0, maxPerMinute - count),
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count,
      backendAvailable: true,
    }
  }),
}))
vi.mock('../src/observability/metrics.js', () => metrics)

const { registerGfsEntityChangeRoutes } = await import('../src/routes/gfs/entityChanges.js')

function makeApp() {
  const app = express()
  const router = express.Router()
  app.set('trust proxy', 1)
  registerGfsEntityChangeRoutes(router)
  app.use(router)
  return app
}

function streamRequest(app: express.Express, operator: string) {
  return request(app)
    .get('/gfs/entity-changes/stream')
    .set('Cookie', `${CONTROL_UI_ADMIN_SESSION_COOKIE}=${operator}`)
}

describe('operator entity-change stream admission limits', () => {
  beforeEach(() => {
    limiterState.calls = []
    limiterState.counts.clear()
    limiterState.unavailableAtCall.clear()
    auth.authenticateAdminSession.mockReset().mockImplementation(async (token: string) => ({
      sub: token,
    }))
    stream.streamEntityChanges.mockReset().mockImplementation((_req, res) => {
      res.status(204).end()
    })
  })

  it('admits an operator, exhausts that operator bucket, and isolates another operator', async () => {
    const app = makeApp()

    const first = await streamRequest(app, 'operator-a')
    const exhausted = await streamRequest(app, 'operator-a')
    const isolated = await streamRequest(app, 'operator-b')

    expect([first.status, exhausted.status, isolated.status]).toEqual([204, 429, 204])
    expect(stream.streamEntityChanges).toHaveBeenCalledTimes(2)
    expect(limiterState.calls.map(call => call.maxPerMinute)).toEqual([20, 1, 20, 1, 20, 1])
    const operatorKeys = limiterState.calls.filter(call => call.maxPerMinute === 1).map(x => x.key)
    expect(operatorKeys[0]).not.toBe(operatorKeys[2])
    expect(operatorKeys).toEqual([
      expect.stringContaining('operator:operator-a'),
      expect.stringContaining('operator:operator-a'),
      expect.stringContaining('operator:operator-b'),
    ])
  })

  it('rejects admission with 503 when either shared limiter backend is unavailable', async () => {
    const app = makeApp()
    limiterState.unavailableAtCall.add(1)
    const ipBackendUnavailable = await streamRequest(app, 'operator-a')

    limiterState.calls = []
    limiterState.unavailableAtCall.clear()
    limiterState.unavailableAtCall.add(2)
    const operatorBackendUnavailable = await streamRequest(app, 'operator-a')

    expect([ipBackendUnavailable.status, operatorBackendUnavailable.status]).toEqual([503, 503])
    expect(ipBackendUnavailable.body.error).toBe('rate_limit_unavailable')
    expect(operatorBackendUnavailable.body.error).toBe('rate_limit_unavailable')
    expect(stream.streamEntityChanges).not.toHaveBeenCalled()
  })
})
