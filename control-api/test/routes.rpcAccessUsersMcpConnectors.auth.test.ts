import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'

// H3 — the route documents that `userId` is authoritative because
// `requireRpcTokenUserMatch()` binds it to the RPC token subject, and never
// flows from a body/query. The sibling wiring test
// (routes.rpcAccessUsersMcpConnectors.test.ts) mocks that middleware to a
// pass-through, so it cannot catch a refactor that removes the guard or makes
// `userId` client-controlled. Here we keep `requireRpcTokenUserMatch` REAL and
// stub only token *validation*, injecting `req.rpcAuth` ourselves the way
// `requireValidRpcAccessToken` would. Deleting the guard from the route, or
// sourcing `userId` from the query, must turn one of these red.

const svc = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
}))
const resolvers = vi.hoisted(() => ({
  resolveConnectorsForAgents: vi.fn(),
  resolveInvocableMcpServersForContexts: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => svc)
vi.mock('../src/services/access/mcpInvocable.js', () => resolvers)

// Keep requireRpcTokenUserMatch REAL; stub only the token-validity gates.
vi.mock('../src/middleware/rpcAccessAuth.js', async importActual => {
  const actual = await importActual<typeof import('../src/middleware/rpcAccessAuth.js')>()
  return {
    ...actual,
    requireValidRpcAccessToken: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    requireValidRpcAccessTokenAny: () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
  }
})

function buildApp(tokenSubject: string) {
  const app = express()
  app.use(express.json())
  // Emulate requireValidRpcAccessToken: attach verified claims for `tokenSubject`.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    ;(req as Request & { rpcAuth?: unknown }).rpcAuth = {
      sub: tokenSubject,
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['mcp:servers:list'],
      hostRefs: [],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    }
    next()
  })
  app.use(
    createRpcAccessUsersRouter({} as unknown as K8sGateway, {
      bindingService: { bind: vi.fn() },
    })
  )
  return app
}

beforeEach(() => {
  svc.getUserAgents.mockReset()
  resolvers.resolveConnectorsForAgents.mockReset()
  svc.getUserAgents.mockResolvedValue({ userId: 'alice', agentNames: [] })
  resolvers.resolveConnectorsForAgents.mockResolvedValue([])
})

describe('GET /rpc/access/users/:userId/mcp-connectors — token-subject binding (H3)', () => {
  it('403s when the token subject does not match the path user', async () => {
    const res = await request(buildApp('alice')).get('/rpc/access/users/bob/mcp-connectors')
    expect(res.status).toBe(403)
    // The guard runs before the handler: no directory lookup for the other user.
    expect(svc.getUserAgents).not.toHaveBeenCalled()
  })

  it('200s when the token subject matches, keyed by the PATH user', async () => {
    const res = await request(buildApp('alice')).get('/rpc/access/users/alice/mcp-connectors')
    expect(res.status).toBe(200)
    expect(svc.getUserAgents).toHaveBeenCalledWith('alice')
  })

  it('a ?userId= override cannot change the effective subject (still 403 cross-user)', async () => {
    // A client tries to smuggle its own id via the query string. The route keys
    // off the PATH param — bound to the token by the middleware — so the query
    // is inert and the mismatch still 403s.
    const res = await request(buildApp('alice')).get(
      '/rpc/access/users/bob/mcp-connectors?userId=alice'
    )
    expect(res.status).toBe(403)
    expect(svc.getUserAgents).not.toHaveBeenCalled()
  })
})
