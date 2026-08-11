import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import {
  attachAccessExecutionBudget,
  createExternalAccessRouter,
} from '../src/routes/external/access.js'

const mocks = vi.hoisted(() => ({
  verifyV1: vi.fn(),
  verifyV2: vi.fn(),
  validateV1: vi.fn(),
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: mocks.verifyV1,
}))
vi.mock('../src/utils/auth/userSessionV2Token.js', () => ({
  verifyUserSessionV2Token: mocks.verifyV2,
}))
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return { ...actual, validateLegacyUserSession: mocks.validateV1 }
})

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAccessRouter({} as never))
  return value
}

describe('external user-access contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyV2.mockReturnValue(null)
    mocks.verifyV1.mockReturnValue({
      userId: '10000000-0000-4000-8000-000000000001',
      email: 'user@example.test',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
      iat: 1_900_000_000,
      sessionContract: 'v1',
    })
    mocks.validateV1.mockResolvedValue({
      status: 'valid',
      identity: { jti: 'token-hash' },
    })
  })

  it('advertises only the effective reconstruction defaults', async () => {
    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'v1-session')

    expect(response.status).toBe(200)
    expect(response.body).toEqual(
      expect.objectContaining({
        currentSessionContract: 'v1',
        v1Accepted: true,
        v1Issued: true,
        v2Accepted: true,
        v2Issued: false,
        catalogShadow: false,
        catalogServed: false,
        actionContextV2: false,
        rpcDelegationV2: false,
        desktopAllTeamMode: false,
        profileV2Mode: false,
        minimumClientEnforced: false,
        catalogFamilies: [],
      })
    )
    expect(mocks.validateV1).toHaveBeenCalledWith(
      'v1-session',
      expect.any(Object),
      expect.objectContaining({ budget: expect.any(Object) })
    )
  })

  it('cancels and releases the shared request budget when the HTTP request aborts', () => {
    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      path: '/external/access/catalog',
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

  it.each([
    ['GET', '/external/access/catalog'],
    ['POST', '/external/access/resolve'],
  ] as const)('keeps %s %s disabled before rate-limited work', async (method, path) => {
    const response = await request(app())
      [method === 'GET' ? 'get' : 'post'](path)
      .set('x-user-session-token', 'v1-session')
      .send(method === 'POST' ? {} : undefined)

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('invalid_request')
  })

  it('requires an accepted live external session for the manifest', async () => {
    mocks.verifyV1.mockReturnValue(null)
    const response = await request(app())
      .get('/external/access/capabilities')
      .set('x-user-session-token', 'invalid')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('invalid_session')
  })
})
