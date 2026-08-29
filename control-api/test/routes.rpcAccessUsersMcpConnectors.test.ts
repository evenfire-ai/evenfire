import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'

// HTTP-level wiring test for GET /rpc/access/users/:userId/mcp-connectors
// (spec 11 U1). The security-relevant invariant: `userId` comes from the
// token-bound route param (requireRpcTokenUserMatch), the agents come from
// getUserAgents, and the resolver is called with that session userId — never a
// client-supplied value. Middleware validity has its own suite; here it is a
// pass-through so the handler contract is isolated.

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
vi.mock('../src/middleware/rpcAccessAuth.js', () => ({
  requireValidRpcAccessToken: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireValidRpcAccessTokenAny: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRpcTokenUserMatch: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

function buildApp() {
  const gatewayStub = {} as unknown as K8sGateway
  const app = express()
  app.use(express.json())
  app.use(
    createRpcAccessUsersRouter(gatewayStub, {
      bindingService: { bind: vi.fn() },
    })
  )
  return app
}

beforeEach(() => {
  svc.getUserAgents.mockReset()
  resolvers.resolveConnectorsForAgents.mockReset()
})

describe('GET /rpc/access/users/:userId/mcp-connectors', () => {
  it('resolves connectors for the session user agents and returns {userId, agents}', async () => {
    svc.getUserAgents.mockResolvedValue({ userId: 'user-9', agentNames: ['agent-a'] })
    const agents = [
      {
        name: 'agent-a',
        namespace: 'mcp-host',
        contextRef: 'ctx-1',
        connectors: [
          { name: 'gdrive', authKind: 'oauth-user', grantScope: 'user', status: 'requires_setup' },
        ],
      },
    ]
    resolvers.resolveConnectorsForAgents.mockResolvedValue(agents)

    const res = await request(buildApp()).get('/rpc/access/users/user-9/mcp-connectors')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-9', agents })
    // getUserAgents is keyed by the route userId.
    expect(svc.getUserAgents).toHaveBeenCalledWith('user-9')
    // The resolver receives that same session userId + the derived agent names.
    const call = resolvers.resolveConnectorsForAgents.mock.calls[0]
    expect(call[1]).toMatchObject({ agentNames: ['agent-a'], userId: 'user-9' })
  })

  it('propagates resolver failure as 500', async () => {
    svc.getUserAgents.mockResolvedValue({ userId: 'user-9', agentNames: ['agent-a'] })
    resolvers.resolveConnectorsForAgents.mockRejectedValue(new Error('boom'))
    const app = buildApp()
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'x' })
      }
    )
    const res = await request(app).get('/rpc/access/users/user-9/mcp-connectors')
    expect(res.status).toBe(500)
  })
})
