import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createExternalRouter } from '../src/routes/external/index.js'
import { createRpcAccessRouter } from '../src/routes/rpc-access/index.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

const svc = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  acceptInvitationForEmail: vi.fn(),
  createInvitation: vi.fn(),
  createManagedInvitationForUser: vi.fn(),
  createTeamForUser: vi.fn(),
  findMemberRole: vi.fn(),
  findMembership: vi.fn(),
  externalManagedInvitationResponse: vi.fn((value: unknown) => value),
  getCurrentTeam: vi.fn(),
  getMe: vi.fn(),
  getTeamAgents: vi.fn(),
  getTeamContexts: vi.fn(),
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  googleLoginData: vi.fn(),
  listMembers: vi.fn(),
  listPendingInvitations: vi.fn(),
  listTeams: vi.fn(),
  renameTeam: vi.fn(),
  searchDirectory: vi.fn(),
  softDeleteMember: vi.fn(),
  updateMemberRole: vi.fn(),
  updateProfile: vi.fn(),
  verifyUserPassword: vi.fn(),
}))

const rpcMock = vi.hoisted(() => ({
  issueRpcAccessToken: vi.fn(),
}))

const googleAuthMock = vi.hoisted(() => ({
  verifyGoogleIdToken: vi.fn(),
}))

const sandboxUiScopeMock = vi.hoisted(() => ({
  userHasUiBearingRecipeAccess: vi.fn(),
}))

const invitationFlowRegistrationMock = vi.hoisted(() => ({
  storeDesktopAuthorizationToken: vi.fn(),
  validateInvitationFlowToken: vi.fn(),
}))

const rateLimitMock = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
}))

const liveTeamAuthorizationMock = vi.hoisted(() => ({
  getLiveTeamMembership: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => svc)
vi.mock('../src/services/rateLimiterService.js', () => rateLimitMock)
vi.mock(
  '../src/services/invitationFlowRegistrationService.js',
  () => invitationFlowRegistrationMock
)
vi.mock('../src/utils/auth/rpcAuthToken.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/auth/rpcAuthToken.js')>()
  return {
    ...actual,
    issueRpcAccessToken: rpcMock.issueRpcAccessToken,
  }
})
vi.mock('../src/utils/auth/googleAuth.js', () => googleAuthMock)
vi.mock('../src/utils/auth/sandboxUiScope.js', () => sandboxUiScopeMock)
vi.mock('../src/services/access/liveTeamAuthorization.js', () => liveTeamAuthorizationMock)
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return {
    ...actual,
    validateLegacyUserSession: vi.fn(async (_token, claims) => ({
      status: 'valid' as const,
      identity: {
        userId: claims.userId,
        email: claims.email,
        sid: '',
        jti: 'test-v1-fingerprint',
        sessionVersion: 0,
        expiresAt: new Date(claims.exp * 1000),
        absoluteExpiresAt: new Date(claims.exp * 1000),
        authenticationMethods: [],
      },
    })),
  }
})

describe('routes/profile', () => {
  const token = 'dev-external-rest-api-token'
  const service = 'external-rest-api'
  const userSessionToken = signExternalSessionToken({
    userId: 'u1',
    email: 'u@example.com',
    teamId: 't1',
    role: 'member',
  })
  const rpcAccessToken = signRpcAccessToken({
    sub: 'u1',
    typ: 'user',
    teamId: 't1',
    role: 'member',
    scopes: ['mcp:servers:list', 'host:status:read'],
    hostRefs: ['agent-a'],
    jti: 'rpc-jti-1',
  })

  function withInternalServiceAuth(req: any) {
    return req.set('authorization', `Bearer ${token}`).set('x-service-token', service)
  }

  function withInternalServiceAuthAndUserSession(req: any) {
    return withInternalServiceAuth(req).set('x-user-session-token', userSessionToken)
  }

  function withInternalServiceAuthAndRpcToken(req: any) {
    return withInternalServiceAuth(req).set('x-rpc-access-token', rpcAccessToken)
  }

  beforeEach(() => {
    Object.values(svc).forEach(fn => fn.mockReset())
    Object.values(rpcMock).forEach(fn => fn.mockReset())
    Object.values(googleAuthMock).forEach(fn => fn.mockReset())
    Object.values(sandboxUiScopeMock).forEach(fn => fn.mockReset())
    Object.values(invitationFlowRegistrationMock).forEach(fn => fn.mockReset())
    liveTeamAuthorizationMock.getLiveTeamMembership.mockReset()
    liveTeamAuthorizationMock.getLiveTeamMembership.mockImplementation(
      async (_userId: string, teamId: string) =>
        teamId === 't1' ? { teamId: 't1', role: 'member' } : null
    )
    rateLimitMock.checkAndIncrement.mockReset()
    rateLimitMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
  })

  function mountInternalRoutes(app: express.Express, gateway: unknown) {
    app.use(requireInternalToken)
    app.use(createExternalRouter(gateway as never))
    app.use(createRpcAccessRouter(gateway as never, { bind: vi.fn() }))
  }

  function accessCatalogGateway() {
    const hosts = [
      { metadata: { name: 'agent-a', namespace: 'mcp-host' }, spec: { enabled: true } },
      { metadata: { name: 'agent-b', namespace: 'mcp-host' }, spec: { enabled: true } },
    ]
    return {
      listResource: vi.fn(async (plural: string) => {
        if (plural === 'contexts') {
          return [
            { metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a', mcpServers: [] } },
            { metadata: { name: 'ctx-b' }, spec: { contextId: 'ctx-b', mcpServers: [] } },
          ]
        }
        if (plural === 'hosts') {
          return hosts
        }
        return []
      }),
      getResource: vi.fn(async (plural: string, name: string) => {
        if (plural !== 'hosts') {
          throw Object.assign(new Error('not-found'), { statusCode: 404 })
        }
        const host = hosts.find(candidate => candidate.metadata.name === name)
        if (!host) throw Object.assign(new Error('not-found'), { statusCode: 404 })
        return host
      }),
    }
  }

  it('returns unauthorized without internal token and supports positive context access flow', async () => {
    const gateway = {
      listResource: vi.fn(async (plural: string) => {
        if (plural === 'contexts') {
          return [{ spec: { contextId: 'ctx-a', mcpServers: ['mcp-a'] } }]
        }
        if (plural === 'hosts') {
          return [{ metadata: { name: 'agent-a' }, spec: { enabled: true } }]
        }
        return [
          {
            metadata: { name: 'mcp-a' },
            spec: { enabled: true, auth: { type: 'none' }, transport: { url: 'http://mcp-a' } },
          },
        ]
      }),
    }

    svc.getUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-a'] })
    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-a'] })
    svc.getTeamContexts.mockResolvedValue({ teamId: 't1', contextIds: ['ctx-a'] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-a'] })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, gateway)

    await request(app).get('/rpc/access/users/u1/contexts').expect(401)

    await withInternalServiceAuth(request(app).get('/external/users/u1/teams')).expect(401)

    await withInternalServiceAuth(request(app).get('/rpc/access/users/u1/agents')).expect(401)

    await withInternalServiceAuthAndRpcToken(
      request(app).get('/rpc/access/users/u1/agents')
    ).expect(200)
    await withInternalServiceAuthAndRpcToken(
      request(app).get('/rpc/access/teams/t1/contexts')
    ).expect(200)
    await withInternalServiceAuthAndRpcToken(
      request(app).get('/rpc/access/teams/t1/agents')
    ).expect(200)

    const mcpRes = await withInternalServiceAuthAndRpcToken(
      request(app).get('/rpc/access/users/u1/mcp-servers')
    ).expect(200)
    expect(mcpRes.body.servers).toEqual([{ name: 'mcp-a', url: 'http://mcp-a' }])

    await withInternalServiceAuthAndRpcToken(
      request(app).get('/rpc/access/users/u1/mcp-hosts/agent-a')
    )
      .expect(200)
      .expect({
        userId: 'u1',
        hostRef: 'agent-a',
        url: 'http://agent-a.mcp-host.svc.cluster.local:8080',
      })

    await withInternalServiceAuthAndRpcToken(
      request(app).get('/rpc/access/users/u1/mcp-hosts/not-allowed')
    ).expect(403)

    expect(gateway.listResource).toHaveBeenCalledWith('contexts', 'mcp-server')
    expect(gateway.listResource).toHaveBeenCalledWith('mcpservers', 'mcp-server')
    expect(gateway.listResource).toHaveBeenCalledWith('hosts', 'mcp-host')
  })

  it('accepts a host:model:write-only token on the mcp-hosts access endpoint (per-session model selector, R2)', async () => {
    // Regression lock for the R2 per-session model-selector authz bug: the
    // desktop mints an rpc token scoped to ONLY `host:model:write` for the
    // model-write flow (rpc-proxy POST /rpc/hosts/:hostRef/model resolves host
    // access via THIS endpoint). Before the fix this scope was missing from the
    // requireValidRpcAccessTokenAny allow-list, so control-api returned 403 and
    // the model write was silently dropped. Uses the REAL middleware + a REAL
    // signed token so the scope gate is genuinely exercised (not mocked).
    const modelWriteToken = signRpcAccessToken({
      sub: 'u1',
      typ: 'user',
      teamId: 't1',
      role: 'member',
      scopes: ['host:model:write'],
      hostRefs: ['agent-a'],
      jti: 'rpc-jti-model-write',
    })

    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-a'] })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuth(
      request(app)
        .get('/rpc/access/users/u1/mcp-hosts/agent-a')
        .set('x-rpc-access-token', modelWriteToken)
    )
      .expect(200)
      .expect({
        userId: 'u1',
        hostRef: 'agent-a',
        url: 'http://agent-a.mcp-host.svc.cluster.local:8080',
      })
  })

  it('rejects a token whose scopes are all outside the mcp-hosts allow-list (gate still closed)', async () => {
    // Negative half of the allow-list contract: `mcp:servers:list` is NOT an
    // accepted scope for the host-access endpoint, so a token carrying only it
    // must still be forbidden. Guards against the fix accidentally widening the
    // gate to any valid user token.
    const catalogOnlyToken = signRpcAccessToken({
      sub: 'u1',
      typ: 'user',
      teamId: 't1',
      role: 'member',
      scopes: ['mcp:servers:list'],
      hostRefs: ['agent-a'],
      jti: 'rpc-jti-catalog-only',
    })

    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-a'] })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuth(
      request(app)
        .get('/rpc/access/users/u1/mcp-hosts/agent-a')
        .set('x-rpc-access-token', catalogOnlyToken)
    ).expect(403)
  })

  it('returns validation errors for bad payloads and role checks', async () => {
    rpcMock.issueRpcAccessToken.mockReturnValue(null)

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuth(request(app).post('/external/auth/session-token'))
      .send({ userId: 'u1', email: 'u@example.com', teamId: 't1', role: 'invalid' })
      .expect(400)

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({ userId: 'u1', teamId: 't1', role: 'member' })
      .expect(401)

    const teamlessSessionToken = signExternalSessionToken({
      userId: 'u-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })

    await withInternalServiceAuth(request(app).post('/external/auth/verify'))
      .send({ token: teamlessSessionToken })
      .expect(200)
      .expect(({ body }) => {
        expect(body.claims.teamId).toBeNull()
      })

    svc.getUserAgents.mockResolvedValue({ userId: 'u-teamless', agentNames: [] })
    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken: teamlessSessionToken,
        scopes: ['mcp:servers:list'],
        hostRefs: ['host-a'],
      })
      .expect(403)

    // GET /external/directory/search now runs `requireExternalTeamParamMatch()`
    // (added by PR #203 "fix(control-api): team members bypass") BEFORE the
    // handler's own teamId presence check. With no `?teamId=...` query param
    // the middleware cannot verify a match against the user's claim and
    // returns 403 — stricter than the previous 400-for-missing-field. Team
    // membership is now enforced as a gate, not just a payload requirement.
    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/directory/search')
    ).expect(403)

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/users/u2/teams')
    ).expect(403)

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/users/u2/team-directory')
    ).expect(403)

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/teams/t2/members')
    ).expect(403)

    await withInternalServiceAuth(request(app).post('/external/invitations/accept'))
      .send({ email: '', token: 'inv-token' })
      .expect(400)

    await withInternalServiceAuthAndUserSession(request(app).post('/external/teams'))
      .send({ userId: 'u2', name: 'team-x' })
      .expect(403)

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/users/u2/contexts')
    ).expect(403)

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/users/u2/agents')
    ).expect(403)

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/teams/t2/contexts')
    ).expect(403)

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/teams/t2/agents')
    ).expect(403)
  })

  it('does not allow an ordinary team member to rename a team', async () => {
    svc.renameTeam.mockResolvedValue({ id: 't1', name: 'Renamed' })
    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuthAndUserSession(
      request(app).put('/external/teams/t1/name').send({ name: 'Renamed' })
    ).expect(403)

    expect(svc.renameTeam).not.toHaveBeenCalled()
  })

  it('does not expose the member directory to an ordinary member', async () => {
    svc.listMembers.mockResolvedValue([{ id: 'u2', email: 'peer@example.com', role: 'member' }])
    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/teams/t1/members')
    ).expect(403)

    expect(svc.listMembers).not.toHaveBeenCalled()
  })

  it('does not allow an inviter to create an admin invitation', async () => {
    const inviterToken = signExternalSessionToken({
      userId: 'u1',
      email: 'u@example.com',
      teamId: 't1',
      role: 'inviter',
    })
    liveTeamAuthorizationMock.getLiveTeamMembership.mockResolvedValue({
      teamId: 't1',
      role: 'inviter',
    })
    svc.createManagedInvitationForUser.mockResolvedValue({ error: 'forbidden' })
    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuth(request(app).post('/external/teams/t1/invitations'))
      .set('x-user-session-token', inviterToken)
      .send({ email: 'target@example.com', role: 'admin' })
      .expect(403)

    expect(svc.createManagedInvitationForUser).toHaveBeenCalledWith(
      'u1',
      'target@example.com',
      [{ teamId: 't1', role: 'admin' }],
      'target'
    )
  })

  it('allows membership lookup for another team when user claim matches', async () => {
    svc.findMembership.mockResolvedValue({
      team_id: 't2',
      role: 'member',
      team_name: 'best team',
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuthAndUserSession(
      request(app).get('/external/users/u1/memberships/t2')
    ).expect(200)
  })

  it('returns initial team directory for all user memberships without switching team claims', async () => {
    svc.listTeams.mockResolvedValue({
      currentTeamId: 't1',
      items: [
        { id: 't1', name: 'Alpha', role: 'member' },
        { id: 't2', name: 'Beta', role: 'admin' },
      ],
    })
    svc.listMembers.mockImplementation(async (teamId: string) =>
      teamId === 't1'
        ? [
            {
              id: 'u1',
              email: 'u@example.com',
              name: 'User',
              role: 'member',
              status: 'active',
              display_name: 'Hidden display name',
              channels: { emails: ['hidden@example.com'] },
            },
          ]
        : [
            {
              id: 'u2',
              email: 'admin@example.com',
              name: 'Admin',
              role: 'admin',
              status: 'active',
              display_name: 'Hidden admin',
              channels: { slackUserNames: ['hidden-admin'] },
            },
          ]
    )
    svc.getTeamContexts.mockImplementation(async (teamId: string) => ({
      teamId,
      contextIds: teamId === 't1' ? ['ctx-a'] : ['ctx-b', 'ctx-b'],
    }))
    svc.getTeamAgents.mockImplementation(async (teamId: string) => ({
      teamId,
      agentNames: teamId === 't1' ? ['agent-a'] : ['agent-b', 'agent-b'],
    }))

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    const res = await withInternalServiceAuthAndUserSession(
      request(app).get('/external/users/u1/team-directory')
    ).expect(200)

    expect(res.body).toEqual({
      currentTeamId: 't1',
      truncated: false,
      complete: true,
      partialErrors: [],
      items: [
        {
          team: { id: 't1', name: 'Alpha', role: 'member' },
          members: [],
          contextIds: ['ctx-a'],
          agentNames: ['agent-a'],
        },
        {
          team: { id: 't2', name: 'Beta', role: 'admin' },
          members: [
            {
              id: 'u2',
              email: 'admin@example.com',
              name: 'Admin',
              role: 'admin',
              status: 'active',
            },
          ],
          contextIds: ['ctx-b'],
          agentNames: ['agent-b'],
        },
      ],
    })
    expect(svc.getTeamContexts).toHaveBeenCalledWith('t2')
    expect(svc.getTeamAgents).toHaveBeenCalledWith('t2')
    expect(svc.listMembers).toHaveBeenCalledWith('t2')
    expect(svc.listMembers).not.toHaveBeenCalledWith('t1')
  })

  it('caps initial team directory fan-out and reports truncation', async () => {
    const teams = Array.from({ length: 51 }, (_, index) => ({
      id: `t${index + 1}`,
      name: `Team ${index + 1}`,
      role: 'member',
    }))
    svc.listTeams.mockResolvedValue({ currentTeamId: 't1', items: teams })
    svc.listMembers.mockResolvedValue([])
    svc.getTeamContexts.mockResolvedValue({ teamId: 'team', contextIds: [] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 'team', agentNames: [] })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    const res = await withInternalServiceAuthAndUserSession(
      request(app).get('/external/users/u1/team-directory')
    ).expect(200)

    expect(res.body.truncated).toBe(true)
    expect(res.body.complete).toBe(false)
    expect(res.body.partialErrors).toEqual([])
    expect(res.body.items).toHaveLength(50)
    expect(res.body.items.at(-1)?.team.id).toBe('t50')
    expect(svc.listMembers).not.toHaveBeenCalled()
    expect(svc.getTeamContexts).toHaveBeenCalledTimes(50)
    expect(svc.getTeamAgents).toHaveBeenCalledTimes(50)
  })

  it('returns user/team access data for matching claim-bound routes', async () => {
    svc.getUserContexts.mockResolvedValue({
      userId: 'u1',
      contextIds: ['ctx-a', 'ctx-b', 'ctx-old'],
    })
    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-a', 'agent-old'] })
    svc.getTeamContexts.mockResolvedValue({ teamId: 't1', contextIds: ['ctx-a', 'ctx-old'] })
    svc.getTeamAgents.mockResolvedValue({
      teamId: 't1',
      agentNames: ['agent-a', 'agent-b', 'agent-old'],
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, accessCatalogGateway())

    await withInternalServiceAuthAndUserSession(request(app).get('/external/users/u1/contexts'))
      .expect(200)
      .expect({ userId: 'u1', contextIds: ['ctx-a', 'ctx-b'] })

    await withInternalServiceAuthAndUserSession(request(app).get('/external/users/u1/agents'))
      .expect(200)
      .expect({
        userId: 'u1',
        agentNames: ['agent-a'],
        agents: [
          {
            name: 'agent-a',
            namespace: 'mcp-host',
            displayName: 'agent-a',
            active: true,
            gfsSubject: { type: 'host', id: '1st:mcp-host/agent-a' },
            contextRef: null,
            mcpServers: [],
          },
        ],
      })

    await withInternalServiceAuthAndUserSession(request(app).get('/external/teams/t1/contexts'))
      .expect(200)
      .expect({ teamId: 't1', contextIds: ['ctx-a'] })

    await withInternalServiceAuthAndUserSession(request(app).get('/external/teams/t1/agents'))
      .expect(200)
      .expect({
        teamId: 't1',
        agentNames: ['agent-a', 'agent-b'],
        agents: [
          {
            name: 'agent-a',
            namespace: 'mcp-host',
            displayName: 'agent-a',
            active: true,
            gfsSubject: { type: 'host', id: '1st:mcp-host/agent-a' },
            contextRef: null,
            mcpServers: [],
          },
          {
            name: 'agent-b',
            namespace: 'mcp-host',
            displayName: 'agent-b',
            active: true,
            gfsSubject: { type: 'host', id: '1st:mcp-host/agent-b' },
            contextRef: null,
            mcpServers: [],
          },
        ],
      })
  })

  it('preserves user and team names-only access when Host enrichment has a transient failure', async () => {
    svc.getUserAgents.mockResolvedValue({
      userId: 'u1',
      agentNames: ['agent-a', 'agent-stale'],
    })
    svc.getTeamAgents.mockResolvedValue({
      teamId: 't1',
      agentNames: ['agent-b'],
    })
    const transientError = Object.assign(new Error('Kubernetes API unavailable'), {
      statusCode: 503,
    })
    const gateway = accessCatalogGateway()
    gateway.getResource.mockRejectedValue(transientError)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, gateway)

    await withInternalServiceAuthAndUserSession(request(app).get('/external/users/u1/agents'))
      .expect(200)
      .expect({
        userId: 'u1',
        agentNames: ['agent-a', 'agent-stale'],
        agents: [],
      })

    await withInternalServiceAuthAndUserSession(request(app).get('/external/teams/t1/agents'))
      .expect(200)
      .expect({ teamId: 't1', agentNames: ['agent-b'], agents: [] })

    expect(gateway.listResource).not.toHaveBeenCalledWith('hosts', 'mcp-host')
    expect(gateway.getResource.mock.calls.map(call => call[1])).toEqual([
      'agent-a',
      'agent-stale',
      'agent-b',
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('verifies session token server-side for rpc token issuance', async () => {
    liveTeamAuthorizationMock.getLiveTeamMembership.mockResolvedValue({
      teamId: 'team-from-claims',
      role: 'member',
    })
    rpcMock.issueRpcAccessToken.mockReturnValue({
      token: 'rpc-token',
      accessScope: 'team',
      teamId: 'team-from-claims',
      scopes: ['mcp:servers:list'],
      hostRefs: ['host-a'],
      expiresInSeconds: 300,
    })

    const sessionToken = signExternalSessionToken({
      userId: 'user-from-claims',
      email: 'user@example.com',
      teamId: 'team-from-claims',
      role: 'member',
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })
    svc.getUserAgents.mockResolvedValue({ userId: 'user-from-claims', agentNames: [] })
    svc.getTeamAgents.mockResolvedValue({
      teamId: 'team-from-claims',
      agentNames: ['host-a'],
    })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        userId: 'malicious-user',
        teamId: 'malicious-team',
        role: 'admin',
        scopes: ['mcp:servers:list'],
        hostRefs: ['host-a'],
      })
      .expect(200)

    expect(rpcMock.issueRpcAccessToken).toHaveBeenCalledWith(
      {
        userId: 'user-from-claims',
        teamId: 'team-from-claims',
        role: 'member',
      },
      ['mcp:servers:list'],
      ['host-a'],
      [] // extraGrantedScopes — no UI-bearing recipe in this mock
    )
  })

  it('issues the existing RPC token as user-scoped for a directly granted teamless agent', async () => {
    const sessionToken = signExternalSessionToken({
      userId: 'user-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })
    svc.getUserAgents.mockResolvedValue({
      userId: 'user-teamless',
      agentNames: ['pro-agent'],
    })
    rpcMock.issueRpcAccessToken.mockReturnValue({
      token: 'user-rpc-token',
      accessScope: 'user',
      teamId: null,
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent'],
      expiresInSeconds: 300,
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['host:message:invoke'],
        hostRefs: ['pro-agent'],
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.accessScope).toBe('user')
        expect(body.teamId).toBeNull()
      })

    expect(svc.getTeamAgents).not.toHaveBeenCalled()
    expect(rpcMock.issueRpcAccessToken).toHaveBeenCalledWith(
      { userId: 'user-teamless', teamId: null, role: 'member' },
      ['host:message:invoke'],
      ['pro-agent'],
      []
    )
  })

  it('returns desktop_requires_team when a teamless session is denied a desktop:view token', async () => {
    const sessionToken = signExternalSessionToken({
      userId: 'user-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })
    svc.getUserAgents.mockResolvedValue({
      userId: 'user-teamless',
      agentNames: ['pro-agent'],
    })
    // desktop:view is team-only; issuance strips it for a user-scoped (teamless)
    // caller and returns null. The route must explain *why* rather than emit a
    // blanket 403, so the desktop app can prompt the user to join/switch a team.
    rpcMock.issueRpcAccessToken.mockReturnValue(null)

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['desktop:view'],
        hostRefs: ['pro-agent'],
      })
      .expect(403)
      .expect({ error: 'desktop_requires_team' })
  })

  it('issues user-scoped sandbox UI tokens for teamless members with direct UI grants', async () => {
    const sessionToken = signExternalSessionToken({
      userId: 'user-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })
    sandboxUiScopeMock.userHasUiBearingRecipeAccess.mockResolvedValue(true)
    rpcMock.issueRpcAccessToken.mockReturnValue({
      token: 'user-sandbox-ui-token',
      accessScope: 'user',
      teamId: null,
      scopes: ['sandbox:ui:view'],
      hostRefs: ['sandbox-ui'],
      expiresInSeconds: 300,
    })

    const gateway = { listResource: vi.fn() }
    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, gateway)

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['sandbox:ui:view'],
        hostRefs: ['sandbox-ui'],
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.accessScope).toBe('user')
        expect(body.teamId).toBeNull()
        expect(body.scopes).toEqual(['sandbox:ui:view'])
      })

    expect(svc.getUserAgents).not.toHaveBeenCalled()
    expect(svc.getTeamAgents).not.toHaveBeenCalled()
    expect(sandboxUiScopeMock.userHasUiBearingRecipeAccess).toHaveBeenCalledWith(
      'user-teamless',
      gateway,
      expect.anything(),
      null
    )
    expect(rpcMock.issueRpcAccessToken).toHaveBeenCalledWith(
      { userId: 'user-teamless', teamId: null, role: 'member' },
      ['sandbox:ui:view'],
      ['sandbox-ui'],
      ['sandbox:ui:view']
    )
  })

  it('rejects sandbox UI sentinel hostRefs unless the sandbox UI scope is requested', async () => {
    const sessionToken = signExternalSessionToken({
      userId: 'user-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['host:message:invoke'],
        hostRefs: ['sandbox-ui'],
      })
      .expect(403)
      .expect({ error: 'sandbox_ui_scope_required' })

    expect(sandboxUiScopeMock.userHasUiBearingRecipeAccess).not.toHaveBeenCalled()
    expect(rpcMock.issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('rejects sandbox UI scope requests unless the sandbox UI sentinel hostRef is present', async () => {
    const sessionToken = signExternalSessionToken({
      userId: 'user-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['sandbox:ui:view'],
        hostRefs: ['pro-agent'],
      })
      .expect(403)
      .expect({ error: 'sandbox_ui_host_ref_required' })

    expect(sandboxUiScopeMock.userHasUiBearingRecipeAccess).not.toHaveBeenCalled()
    expect(rpcMock.issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('rejects tokens that mix sandbox UI and agent hostRefs', async () => {
    const sessionToken = signExternalSessionToken({
      userId: 'user-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['sandbox:ui:view', 'host:message:invoke'],
        hostRefs: ['sandbox-ui', 'pro-agent'],
      })
      .expect(403)
      .expect({ error: 'sandbox_ui_host_ref_exclusive' })

    expect(sandboxUiScopeMock.userHasUiBearingRecipeAccess).not.toHaveBeenCalled()
    expect(rpcMock.issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('rejects mixed, missing, and wildcard direct host grants for teamless sessions', async () => {
    const sessionToken = signExternalSessionToken({
      userId: 'user-teamless',
      email: 'teamless@example.com',
      teamId: null,
      role: 'member',
    })
    svc.getUserAgents.mockResolvedValue({
      userId: 'user-teamless',
      agentNames: ['pro-agent'],
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['host:message:invoke'],
        hostRefs: ['pro-agent', 'not-granted'],
      })
      .expect(403)
      .expect({ error: 'direct_host_access_required' })

    await withInternalServiceAuth(request(app).post('/external/rpc/token'))
      .send({
        sessionToken,
        scopes: ['host:message:invoke'],
        hostRefs: ['pro-agent', '*'],
      })
      .expect(403)
      .expect({ error: 'invalid_host_refs' })

    expect(rpcMock.issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('verifies Google idToken inside control-api', async () => {
    googleAuthMock.verifyGoogleIdToken.mockResolvedValue({
      email: 'user@example.com',
      name: 'User',
      picture: 'https://example.com/avatar.png',
    })
    svc.googleLoginData.mockResolvedValue({
      isNewUser: false,
      user: {
        id: 'u1',
        email: 'user@example.com',
        name: 'User',
        picture: 'https://example.com/avatar.png',
      },
      membership: { team_id: 't1', team_name: 'team', role: 'member' },
    })

    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    await withInternalServiceAuth(request(app).post('/external/auth/google-login'))
      .send({})
      .expect(400)

    await withInternalServiceAuth(request(app).post('/external/auth/google-login'))
      .send({ idToken: 'google-id-token' })
      .expect(200)

    expect(googleAuthMock.verifyGoogleIdToken).toHaveBeenCalledWith('google-id-token')
    expect(svc.googleLoginData).toHaveBeenCalledWith({
      email: 'user@example.com',
      name: 'User',
      picture: 'https://example.com/avatar.png',
    })
  })

  it('rate limits external credential attempts before authentication work', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 6,
    })
    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    const response = await withInternalServiceAuth(
      request(app).post('/external/auth/google-login')
    ).send({ idToken: 'google-id-token' })

    expect(response.status).toBe(429)
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      expect.stringMatching(/^external_authentication_attempt:ip:/),
      5
    )
    expect(googleAuthMock.verifyGoogleIdToken).not.toHaveBeenCalled()
  })

  it('rate limits session verification before session authority work', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 11,
    })
    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    const response = await withInternalServiceAuth(request(app).post('/external/auth/verify')).send(
      { token: userSessionToken }
    )

    expect(response.status).toBe(429)
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      expect.stringMatching(/^external_session_verify:ip:/),
      10
    )
  })

  it('rate limits RPC token issuance by trusted authenticated user before minting', async () => {
    rateLimitMock.checkAndIncrement
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 9,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 1,
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: 11,
      })
    const app = express()
    app.use(express.json())
    mountInternalRoutes(app, { listResource: vi.fn() })

    const response = await withInternalServiceAuth(request(app).post('/external/rpc/token')).send({
      sessionToken: userSessionToken,
      scopes: ['mcp:servers:list'],
      hostRefs: ['agent-a'],
    })

    expect(response.status).toBe(429)
    expect(rateLimitMock.checkAndIncrement).toHaveBeenNthCalledWith(
      2,
      'external_rpc_token:user:u1',
      10
    )
    expect(rpcMock.issueRpcAccessToken).not.toHaveBeenCalled()
  })
})
