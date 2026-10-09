import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'

// HTTP-level wiring test for GET /rpc/access/users/:userId/mcp-connectors
// (spec 11 U1). The security-relevant invariant: `userId` comes from the
// token-bound route param (requireRpcTokenUserMatch), the agents come from
// getUserAgents (plus the session team's team_agents, PR #1004), and the
// resolver is called with that session userId — never a client-supplied value.
// Middleware validity has its own suite; here it is a pass-through that only
// attaches the claims the test sets, so the handler contract is isolated.

const svc = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
}))
const auth = vi.hoisted(() => ({ claims: undefined as Record<string, unknown> | undefined }))
const resolvers = vi.hoisted(() => ({
  resolveConnectorsForAgents: vi.fn(),
  resolveInvocableMcpServersForContexts: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => svc)
vi.mock('../src/services/access/mcpInvocable.js', () => resolvers)
vi.mock('../src/middleware/rpcAccessAuth.js', () => ({
  requireValidRpcAccessToken:
    () => (req: { rpcAuth?: unknown }, _res: unknown, next: () => void) => {
      if (auth.claims) req.rpcAuth = auth.claims
      next()
    },
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
  auth.claims = undefined
  svc.getUserAgents.mockReset()
  svc.getCurrentTeam.mockReset()
  svc.getTeamAgents.mockReset()
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

  // PR #1004: the panel offers what the user can actually chat with — agents
  // granted directly AND those granted to the session's team — mirroring
  // `authorizeRpcHostAccess`. Consent admission already counts team agents, so
  // a team-only agent's connectors must not be invisible here.
  it("unions the active session team's agents when the token carries a teamId", async () => {
    auth.claims = { sub: 'user-9', teamId: 'team-1' }
    svc.getUserAgents.mockResolvedValue({ userId: 'user-9', agentNames: ['agent-a', 'shared'] })
    svc.getCurrentTeam.mockResolvedValue({ id: 'team-1', name: 'Team', role: 'member' })
    svc.getTeamAgents.mockResolvedValue({ teamId: 'team-1', agentNames: ['shared', 'team-b'] })
    resolvers.resolveConnectorsForAgents.mockResolvedValue([])

    const res = await request(buildApp()).get('/rpc/access/users/user-9/mcp-connectors')

    expect(res.status).toBe(200)
    expect(svc.getCurrentTeam).toHaveBeenCalledWith('user-9', 'team-1')
    expect(svc.getTeamAgents).toHaveBeenCalledWith('team-1')
    const call = resolvers.resolveConnectorsForAgents.mock.calls[0]
    expect(call[1]).toMatchObject({ agentNames: ['agent-a', 'shared', 'team-b'], userId: 'user-9' })
  })

  it('ignores the teamId when the user is no longer an active member of that team', async () => {
    auth.claims = { sub: 'user-9', teamId: 'team-1' }
    svc.getUserAgents.mockResolvedValue({ userId: 'user-9', agentNames: ['agent-a'] })
    svc.getCurrentTeam.mockResolvedValue(null)
    resolvers.resolveConnectorsForAgents.mockResolvedValue([])

    const res = await request(buildApp()).get('/rpc/access/users/user-9/mcp-connectors')

    expect(res.status).toBe(200)
    expect(svc.getTeamAgents).not.toHaveBeenCalled()
    expect(resolvers.resolveConnectorsForAgents.mock.calls[0][1]).toMatchObject({
      agentNames: ['agent-a'],
    })
  })

  it('reads no team agents when the token carries no teamId', async () => {
    auth.claims = { sub: 'user-9' }
    svc.getUserAgents.mockResolvedValue({ userId: 'user-9', agentNames: ['agent-a'] })
    resolvers.resolveConnectorsForAgents.mockResolvedValue([])

    const res = await request(buildApp()).get('/rpc/access/users/user-9/mcp-connectors')

    expect(res.status).toBe(200)
    expect(svc.getCurrentTeam).not.toHaveBeenCalled()
    expect(svc.getTeamAgents).not.toHaveBeenCalled()
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
