import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

const directory = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => directory)

const rateLimiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/services/rateLimiterService.js', () => rateLimiter)

const userId = 'user-1'
const hostRef = 'host-a'

function token(overrides: Partial<Parameters<typeof signRpcAccessToken>[0]> = {}) {
  return signRpcAccessToken({
    sub: userId,
    typ: 'user',
    teamId: 'team-1',
    role: 'member',
    scopes: ['host:task:read'],
    hostRefs: [hostRef],
    jti: `artifact-admission-${randomUUID()}`,
    ...overrides,
  })
}

function buildApp() {
  const gateway = {
    listResource: vi.fn(async () => [{ metadata: { name: hostRef }, spec: { enabled: true } }]),
    getResource: vi.fn(async () => ({}) as never),
    createResource: vi.fn(async () => ({})),
    updateResource: vi.fn(async () => ({})),
    deleteResource: vi.fn(async () => ({ ok: true })),
  }
  const app = express()
  app.use(
    createRpcAccessUsersRouter(gateway as unknown as K8sGateway, {
      bindingService: { bind: vi.fn() },
    })
  )
  return { app, gateway }
}

describe('artifact-read admission with real RPC auth and claim-match middleware', () => {
  beforeEach(() => {
    Object.values(directory).forEach(mock => mock.mockReset())
    rateLimiter.checkAndIncrement.mockReset()
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
  })

  it.each([
    ['missing token', undefined, 401],
    ['invalid token', 'not-a-jwt', 401],
    ['missing host:task:read scope', token({ scopes: ['host:status:read'] }), 403],
    ['subject mismatch', token({ sub: 'another-user' }), 403],
    ['Host absent from signed hostRefs', token({ hostRefs: ['another-host'] }), 403],
  ])('%s fails before charging pre-admission', async (_case, accessToken, status) => {
    const { app } = buildApp()
    let req = request(app).get(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}/artifact-read`)
    if (accessToken) req = req.set('x-rpc-access-token', accessToken)

    await req.expect(status)

    expect(rateLimiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(directory.getUserAgents).not.toHaveBeenCalled()
  })
})
