import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'

const state = vi.hoisted(() => ({
  claims: null as { sub: string; hostRefs: string[] } | null,
  authorization: vi.fn(),
  checkAndIncrement: vi.fn(),
}))

vi.mock('../src/middleware/rpcAccessAuth.js', () => ({
  requireValidRpcAccessTokenAny:
    () => (req: { rpcAuth?: unknown }, _res: unknown, next: () => void) => {
      req.rpcAuth = state.claims ?? undefined
      next()
    },
  requireRpcTokenUserMatch: () => (_req: unknown, _res: unknown, next: () => void) => {
    next()
  },
  requireRpcTokenHostMatch: () => (_req: unknown, _res: unknown, next: () => void) => {
    next()
  },
  requireValidRpcAccessToken: () => (_req: unknown, _res: unknown, next: () => void) => {
    next()
  },
}))

vi.mock('../src/services/access/rpcHostAccessAuthorizer.js', () => ({
  authorizeRpcHostAccess: (...args: unknown[]) => state.authorization(...args),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => state.checkAndIncrement(...args),
}))

function buildApp() {
  const gateway = {
    listResource: vi.fn(async () => []),
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
  return app
}

describe('Host artifact limiter defensive attribution', () => {
  beforeEach(() => {
    state.claims = null
    state.authorization.mockReset()
    state.checkAndIncrement.mockReset()
    state.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
  })

  it('counts a missing subject under the pre-admission sentinel', async () => {
    await request(buildApp())
      .get('/rpc/access/users/user-a/mcp-hosts/host-a/artifact-read')
      .expect(403)

    expect(state.checkAndIncrement).toHaveBeenCalledWith(
      'host-artifact-pre-admission:unauthenticated',
      expect.any(Number)
    )
  })

  it('counts an unresolved post-authorization key under a separate sentinel', async () => {
    state.claims = { sub: 'user-a', hostRefs: ['host-a'] }
    state.authorization.mockResolvedValue({
      authorized: true,
      connection: { url: 'http://host-a.example', hostRef: undefined },
    })

    await request(buildApp())
      .get('/rpc/access/users/user-a/mcp-hosts/host-a/artifact-read')
      .expect(200)

    expect(state.checkAndIncrement.mock.calls.map(call => call[0])).toEqual([
      'host-artifact-pre-admission:user-a',
      'host-artifact-read:unresolved',
    ])
  })
})
