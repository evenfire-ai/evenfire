import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createInternalRpcProxyLegacySessionAdmissionRouter } from '../src/routes/internal/rpcProxyLegacySessionAdmission.js'
import { signRpcAccessToken, verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

const mockState = vi.hoisted(() => ({
  calls: [] as Array<{ key: string; max: number }>,
  counts: new Map<string, number>(),
  checkAndIncrement: vi.fn(),
}))

vi.mock('../src/services/rateLimiterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/rateLimiterService.js')>()),
  checkAndIncrement: mockState.checkAndIncrement,
}))

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'

function userToken(subject: string, scopes: string[]): string {
  return signRpcAccessToken({
    sub: subject,
    typ: 'user',
    accessScope: 'team',
    teamId: 'team-1',
    scopes: scopes as never,
    hostRefs: ['chatllm'],
    jti: randomUUID(),
  })
}

function makeApp() {
  const app = express()
  app.use(requireInternalToken)
  app.use(createInternalRpcProxyLegacySessionAdmissionRouter())
  return app
}

function postAdmission(
  app: ReturnType<typeof makeApp>,
  token: string,
  serviceToken = RPC_PROXY_TOKEN
) {
  return request(app)
    .post('/internal/rpc-proxy/legacy-session-admission')
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('x-service-token', 'rpc-proxy')
    .set('x-rpc-access-token', token)
}

describe('POST /internal/rpc-proxy/legacy-session-admission', () => {
  beforeEach(() => {
    mockState.calls = []
    mockState.counts.clear()
    mockState.checkAndIncrement.mockReset().mockImplementation(async (key: string, max: number) => {
      mockState.calls.push({ key, max })
      const count = (mockState.counts.get(key) ?? 0) + 1
      mockState.counts.set(key, count)
      return {
        backendAvailable: true,
        allowed: count <= max,
        count,
        remaining: Math.max(0, max - count),
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
      }
    })
  })

  it('uses only the verified subject and enforces the shared 60-request budget', async () => {
    const app = makeApp()
    const token = userToken('subject-a', ['desktop:view', 'sandbox:ui:view'])
    expect(verifyRpcAccessToken(token)?.sub).toBe('subject-a')

    const results = []
    for (let index = 0; index < 61; index += 1) {
      results.push(await postAdmission(app, token))
    }

    expect(results.slice(0, 60).every(result => result.status === 204)).toBe(true)
    expect(results[60].status).toBe(429)
    expect(results[60].headers['retry-after']).toBeTruthy()
    expect(results[60].headers['x-ratelimit-limit']).toBe('60')
    expect(results[60].headers['x-ratelimit-remaining']).toBe('0')
    expect(mockState.calls).toHaveLength(61)
    expect(new Set(mockState.calls.map(call => call.key))).toEqual(
      new Set(['legacy-session:subject-a'])
    )
    expect(mockState.calls.every(call => call.max === 60)).toBe(true)

    const otherSubject = await postAdmission(app, userToken('subject-b', ['desktop:view']))
    expect(otherSubject.status).toBe(204)
    expect(mockState.calls.at(-1)?.key).toBe('legacy-session:subject-b')
  })

  it('rejects unauthenticated service/user requests before charging', async () => {
    const app = makeApp()
    await postAdmission(
      app,
      userToken('subject-a', ['desktop:view']),
      'wrong-service-token'
    ).expect(401)
    await postAdmission(app, 'not-a-user-token').expect(401)
    expect(mockState.calls).toHaveLength(0)
  })

  it('fails closed with a bounded typed 503 when PostgreSQL cannot count', async () => {
    mockState.checkAndIncrement.mockResolvedValueOnce({
      backendAvailable: false,
      allowed: true,
      count: 0,
      remaining: 60,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const response = await postAdmission(
      makeApp(),
      userToken('subject-sensitive-value', ['desktop:view'])
    ).expect(503)

    expect(response.body).toEqual({ error: 'rate_limit_unavailable', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['x-ratelimit-limit']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('subject-sensitive-value')
    expect(mockState.checkAndIncrement).toHaveBeenCalledOnce()
  })
})
