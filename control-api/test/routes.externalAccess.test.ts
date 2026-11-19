import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import { attachAccessExecutionBudget } from '../src/middleware/accessExecutionBudget.js'
import { createExternalAccessRouter } from '../src/routes/external/access.js'

const mocks = vi.hoisted(() => ({
  verifyV1: vi.fn(),
  verifyV2: vi.fn(),
  validateV1: vi.fn(),
  validateV2: vi.fn(),
  resolvePolicy: vi.fn(),
}))

const rateLimiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: mocks.verifyV1,
}))
vi.mock('../src/utils/auth/userSessionV2Token.js', () => ({
  verifyUserSessionV2Token: mocks.verifyV2,
}))
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return {
    ...actual,
    validateLegacyUserSession: mocks.validateV1,
    validateUserSessionClaims: mocks.validateV2,
  }
})
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => ({
  resolveEffectiveUserAccessPolicy: mocks.resolvePolicy,
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimiter)

function effectivePolicy(overrides: Record<string, unknown> = {}) {
  return {
    policyVersion: '1',
    policyRevision: 'test-policy',
    acceptV1: true,
    issueV1: true,
    acceptV2: true,
    issueV2: false,
    renewV2: false,
    switchCompatibility: true,
    actionContextV2: false,
    rpcDelegationV2: false,
    minimumClientVersion: null,
    enforceMinimumClient: false,
    ...overrides,
  }
}

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAccessRouter())
  return value
}

describe('external user-access contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolvePolicy.mockResolvedValue(effectivePolicy())
    mocks.verifyV2.mockReturnValue(null)
    mocks.verifyV1.mockReturnValue({
      userId: '10000000-0000-4000-8000-000000000001',
      email: 'user@example.test',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      iat: 1_900_000_000,
      sessionContract: 'v1',
      authGeneration: 1,
    })
    mocks.validateV1.mockResolvedValue({
      status: 'valid',
      identity: { jti: 'token-hash' },
    })
    mocks.validateV2.mockResolvedValue({
      status: 'valid',
      identity: {
        userId: '10000000-0000-4000-8000-000000000001',
        email: 'user@example.test',
        sid: '20000000-0000-4000-8000-000000000002',
        jti: '30000000-0000-4000-8000-000000000003',
        sessionVersion: 1,
      },
    })
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
      backendAvailable: true,
    })
  })

  it('advertises only the effective reconstruction defaults', async () => {
    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'v1-session')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      contractVersion: '2',
      currentSessionContract: 'v1',
      policyVersion: '1',
      policyRevision: 'test-policy',
      v1Accepted: true,
      v1Issued: true,
      v2Accepted: true,
      v2Issued: false,
      v2Renewal: false,
      legacySwitch: true,
      actionContextV2: false,
      rpcDelegationV2: false,
      minimumClientVersion: null,
      minimumClientEnforced: false,
    })
    expect(mocks.validateV1).toHaveBeenCalledWith('v1-session', expect.any(Object), {
      onDatabaseFailure: expect.any(Function),
    })
  })

  it('answers V1 sessions without mounting a request budget on the route', async () => {
    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'v1-session')

    expect(response.status).toBe(200)
    expect(response.body.currentSessionContract).toBe('v1')
    // The session boundary and the route each read the policy once; neither
    // receives a request budget.
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(2)
    for (const call of mocks.resolvePolicy.mock.calls) expect(call).toEqual([])
  })

  it('cancels and releases the request budget when the HTTP request aborts', () => {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      path: '/external/rpc/delegations',
    })
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    const next = vi.fn()

    attachAccessExecutionBudget(req as never, res as never, next)

    const budget = (req as { accessExecutionBudget?: { signal: AbortSignal } })
      .accessExecutionBudget
    expect(next).toHaveBeenCalledOnce()
    expect(budget?.signal.aborted).toBe(false)
    req.emit('aborted')
    expect(budget?.signal.aborted).toBe(true)
    expect(budget?.signal.reason).toBe('cancelled')
    res.emit('close')
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('finish')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('requires an accepted live external session for the manifest', async () => {
    mocks.verifyV1.mockReturnValue(null)
    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'invalid')
    expect(mocks.verifyV1).toHaveBeenCalledWith('invalid')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
  })

  it('serves capabilities without a per-user PG budget (dev users-family parity)', async () => {
    // A denying PG limiter would surface as 429 if the capability read still charged one.
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 11,
      backendAvailable: true,
    })

    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'v1-session')

    expect(response.status).toBe(200)
    expect(response.body.currentSessionContract).toBe('v1')
    expect(mocks.resolvePolicy).toHaveBeenCalled()
    expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
  })
})
