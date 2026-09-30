import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { config } from '../src/config.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { issueRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

// Session verification and signing are isolated boundaries. Normalization,
// scope filtering, mint classification, and token issuance retain their real code.
const boundary = vi.hoisted(() => ({
  sign: vi.fn(),
  verifySession: vi.fn(),
  currentSession: vi.fn(),
  sandboxAccess: vi.fn(),
  query: vi.fn(),
}))

const directory = vi.hoisted(() => ({
  getReachableAgentNames: vi.fn(),
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  googleLoginData: vi.fn(),
  passwordLoginData: vi.fn(),
  requestProfilePasswordReset: vi.fn(),
}))

vi.mock('jsonwebtoken', () => ({ default: { sign: boundary.sign } }))
vi.mock('../src/db.js', () => ({ pool: { query: boundary.query } }))
vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  isCurrentExternalSession: boundary.currentSession,
}))
vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  signExternalSessionToken: vi.fn(),
  verifyExternalSessionToken: boundary.verifySession,
}))
vi.mock('../src/utils/auth/googleAuth.js', () => ({ verifyGoogleIdToken: vi.fn() }))
vi.mock('../src/utils/auth/sandboxUiScope.js', () => ({
  userHasUiBearingRecipeAccess: boundary.sandboxAccess,
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS: 2,
  checkAndIncrement: vi.fn(),
}))
vi.mock('../src/utils/auth/rpcAuthToken.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/auth/rpcAuthToken.js')>()
  return {
    ...actual,
    // Observe calls without replacing the production issuance or scope decision.
    issueRpcAccessToken: vi.fn(actual.issueRpcAccessToken),
  }
})

const sessionClaims = {
  userId: 'u1',
  email: 'u1@example.test',
  teamId: 't1',
  role: 'member' as const,
  authGeneration: 1,
}

// Fixtures are generated only in this test process and never persisted.
const sessionFixture = randomUUID()

function buildApp() {
  const errors: unknown[] = []
  const app = express()
  app.use(express.json())
  app.use(createExternalAuthRouter({ listResource: vi.fn() } as never))
  const errorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
    errors.push(error)
    res.status(500).json({ error: 'internal_error' })
  }
  app.use(errorHandler)
  return { app, errors }
}

function mint(app: express.Express, hostRefs: unknown, scopes: unknown = ['host:message:invoke']) {
  return request(app)
    .post('/external/rpc/token')
    .send({ sessionToken: sessionFixture, hostRefs, scopes })
}

describe('RPC token mint revocation', () => {
  beforeEach(() => {
    Object.values(directory).forEach(mock => mock.mockReset())
    Object.values(boundary).forEach(mock => mock.mockReset())
    vi.mocked(issueRpcAccessToken).mockClear()
    boundary.sign.mockImplementation(() => randomUUID())
    boundary.verifySession.mockReturnValue(sessionClaims)
    boundary.currentSession.mockResolvedValue(true)
    boundary.sandboxAccess.mockResolvedValue(false)
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: [] })
    directory.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: [] })
    directory.getReachableAgentNames.mockResolvedValue({ userId: 'u1', agentNames: [] })
  })

  it('C1: names a denied and unreachable Host for a team session without issuing a token', async () => {
    const { app } = buildApp()
    const response = await mint(app, ['host-a'])

    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: ['host-a'],
    })
    expect(directory.getUserAgents).toHaveBeenCalledWith('u1')
    expect(directory.getTeamAgents).toHaveBeenCalledWith('t1')
    expect(directory.getReachableAgentNames).toHaveBeenCalledTimes(1)
    expect(directory.getReachableAgentNames).toHaveBeenCalledWith('u1')
    expect(issueRpcAccessToken).not.toHaveBeenCalled()
    expect(boundary.sign.mock.calls.length).toBe(0)
  })

  it('C2: retains the original denial when another active team makes the Host reachable', async () => {
    directory.getReachableAgentNames.mockResolvedValue({ userId: 'u1', agentNames: ['host-a'] })
    const { app } = buildApp()
    const response = await mint(app, ['host-a'])

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'host_access_denied' })
    expect(directory.getTeamAgents).toHaveBeenCalledWith('t1')
    expect(directory.getReachableAgentNames).toHaveBeenCalledTimes(1)
    expect(directory.getReachableAgentNames).toHaveBeenCalledWith('u1')
    expect(issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('C3: retains the original partial-grant denial without querying reachability', async () => {
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['host-a'] })
    directory.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['host-team-decoy'] })
    directory.getReachableAgentNames.mockResolvedValue({ userId: 'u1', agentNames: ['host-a'] })
    const { app } = buildApp()
    const response = await mint(app, ['host-a', 'host-b'])

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'host_access_denied' })
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
    expect(directory.getUserAgents).toHaveBeenCalledWith('u1')
    expect(directory.getTeamAgents).toHaveBeenCalledTimes(1)
    expect(directory.getTeamAgents).toHaveBeenCalledWith('t1')
    expect(directory.getReachableAgentNames).not.toHaveBeenCalled()
    expect(issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('C4: retains the original denial when one of two denied Hosts is reachable', async () => {
    directory.getReachableAgentNames.mockResolvedValue({ userId: 'u1', agentNames: ['host-a'] })
    const { app } = buildApp()
    const response = await mint(app, ['host-a', 'host-b'])

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'host_access_denied' })
    expect(directory.getReachableAgentNames).toHaveBeenCalledTimes(1)
    expect(directory.getReachableAgentNames).toHaveBeenCalledWith('u1')
    expect(issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'C5-unreachable: names an unreachable Host for a teamless session',
      reachable: [],
      expected: {
        error: 'direct_host_access_required',
        code: 'host_access_revoked',
        revokedHostRefs: ['host-a'],
      },
    },
    {
      name: 'C5-team-reachable: retains the original teamless denial for a team-reachable Host',
      reachable: ['host-a'],
      expected: { error: 'direct_host_access_required' },
    },
  ])('$name', async ({ reachable, expected }) => {
    boundary.verifySession.mockReturnValue({ ...sessionClaims, teamId: null })
    directory.getReachableAgentNames.mockResolvedValue({ userId: 'u1', agentNames: reachable })
    const { app } = buildApp()
    const response = await mint(app, ['host-a'])

    expect(response.status).toBe(403)
    expect(response.body).toEqual(expected)
    expect(directory.getUserAgents).toHaveBeenCalledWith('u1')
    expect(directory.getTeamAgents).not.toHaveBeenCalled()
    expect(directory.getReachableAgentNames).toHaveBeenCalledTimes(1)
    expect(directory.getReachableAgentNames).toHaveBeenCalledWith('u1')
    expect(issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('C6-success: issues the requested grants without querying reachability', async () => {
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['host-a'] })
    directory.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['host-b'] })
    directory.getReachableAgentNames.mockResolvedValue({
      userId: 'u1',
      agentNames: ['host-a', 'host-b'],
    })
    const { app } = buildApp()
    const response = await mint(app, ['host-a', 'host-b'])

    expect(response.status).toBe(200)
    const { token, ...issuedDetails } = response.body
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
    expect(issuedDetails).toEqual({
      accessScope: 'team',
      teamId: 't1',
      scopes: ['host:message:invoke'],
      hostRefs: ['host-a', 'host-b'],
      expiresInSeconds: config.rpcTokenTtlSeconds,
    })
    expect(directory.getUserAgents).toHaveBeenCalledWith('u1')
    expect(directory.getTeamAgents).toHaveBeenCalledWith('t1')
    expect(issueRpcAccessToken).toHaveBeenCalledTimes(1)
    expect(issueRpcAccessToken).toHaveBeenCalledWith(
      { userId: 'u1', teamId: 't1', role: 'member' },
      ['host:message:invoke'],
      ['host-a', 'host-b'],
      []
    )
    expect(boundary.sign.mock.calls.length).toBe(1)
    expect(directory.getReachableAgentNames).not.toHaveBeenCalled()
    expect(response.body).not.toHaveProperty('code')
    expect(response.body).not.toHaveProperty('revokedHostRefs')
  })

  it('C6-I5: returns only sorted canonical requested Hosts despite unrelated granted and reachable data', async () => {
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['host-decoy'] })
    directory.getReachableAgentNames.mockResolvedValue({
      userId: 'u1',
      agentNames: ['host-decoy'],
    })
    const { app } = buildApp()
    const response = await mint(app, [' host-b ', 'host-a', 'host-b', ' host-a '])

    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: ['host-a', 'host-b'],
    })
    expect(directory.getUserAgents).toHaveBeenCalledWith('u1')
    expect(directory.getTeamAgents).toHaveBeenCalledWith('t1')
    expect(directory.getReachableAgentNames).toHaveBeenCalledTimes(1)
    expect(directory.getReachableAgentNames).toHaveBeenCalledWith('u1')
    expect(issueRpcAccessToken).not.toHaveBeenCalled()
  })

  it('C-query-error: propagates reachability rejection as an ordinary server failure', async () => {
    const failure = new Error('directory reachability unavailable')
    directory.getReachableAgentNames.mockRejectedValueOnce(failure)
    const { app, errors } = buildApp()
    const failed = await mint(app, ['host-a'])

    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'internal_error' })
    expect(errors).toEqual([failure])
    expect(directory.getReachableAgentNames).toHaveBeenCalledTimes(1)
    expect(directory.getReachableAgentNames).toHaveBeenCalledWith('u1')
    expect(issueRpcAccessToken).not.toHaveBeenCalled()

    const recovered = await mint(app, ['host-a'])
    expect(recovered.status).toBe(403)
    expect(recovered.body).toEqual({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: ['host-a'],
    })
    expect(directory.getReachableAgentNames).toHaveBeenCalledTimes(2)
    expect(directory.getReachableAgentNames).toHaveBeenLastCalledWith('u1')
  })

  it.each([
    { name: 'missing', hostRefs: undefined },
    { name: 'empty', hostRefs: [] },
    { name: 'blank', hostRefs: [' '] },
    { name: 'wildcard', hostRefs: ['host-a', '*'] },
    { name: 'non-string', hostRefs: ['host-a', 42] },
  ])(
    'C-guard-invalid: rejects $name Host refs without reachability or revocation extras',
    async ({ hostRefs }) => {
      directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['host-a'] })
      const { app } = buildApp()
      const valid = await mint(app, ['host-a'])
      expect(valid.status).toBe(200)
      expect(valid.body.hostRefs).toEqual(['host-a'])
      expect(issueRpcAccessToken).toHaveBeenCalledTimes(1)

      vi.mocked(issueRpcAccessToken).mockClear()
      directory.getUserAgents.mockClear()
      directory.getTeamAgents.mockClear()
      const invalid = await mint(app, hostRefs)
      expect(invalid.status).toBe(403)
      expect(invalid.body).toEqual({ error: 'invalid_host_refs' })
      expect(boundary.verifySession).toHaveBeenCalledTimes(2)
      expect(boundary.currentSession).toHaveBeenCalledTimes(2)
      expect(directory.getUserAgents).not.toHaveBeenCalled()
      expect(directory.getTeamAgents).not.toHaveBeenCalled()
      expect(directory.getReachableAgentNames).not.toHaveBeenCalled()
      expect(issueRpcAccessToken).not.toHaveBeenCalled()
    }
  )

  it('C-guard-desktop-scope: preserves the real teamless scope denial without revocation extras', async () => {
    boundary.verifySession.mockReturnValue({ ...sessionClaims, teamId: null })
    directory.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['host-a'] })
    const { app } = buildApp()
    const allowed = await mint(app, ['host-a'])
    expect(allowed.status).toBe(200)
    expect(allowed.body.scopes).toEqual(['host:message:invoke'])
    expect(boundary.sign.mock.calls.length).toBe(1)

    vi.mocked(issueRpcAccessToken).mockClear()
    boundary.sign.mockClear()
    const denied = await mint(app, ['host-a'], ['desktop:view'])
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'desktop_requires_team' })
    expect(directory.getUserAgents).toHaveBeenCalledWith('u1')
    expect(directory.getReachableAgentNames).not.toHaveBeenCalled()
    expect(issueRpcAccessToken).toHaveBeenCalledWith(
      { userId: 'u1', teamId: null, role: 'member' },
      ['desktop:view'],
      ['host-a'],
      []
    )
    expect(boundary.sign.mock.calls.length).toBe(0)
  })

  it('C-guard-sandbox-scope: preserves the real missing-permitted-scope denial without revocation extras', async () => {
    boundary.sandboxAccess.mockResolvedValue(true)
    const { app } = buildApp()
    const allowed = await mint(app, ['sandbox-ui'], ['sandbox:ui:view'])
    expect(allowed.status).toBe(200)
    expect(allowed.body.scopes).toEqual(['sandbox:ui:view'])
    expect(boundary.sandboxAccess).toHaveBeenCalledWith(
      'u1',
      expect.anything(),
      expect.anything(),
      't1'
    )
    expect(boundary.sign.mock.calls.length).toBe(1)

    vi.mocked(issueRpcAccessToken).mockClear()
    boundary.sign.mockClear()
    boundary.sandboxAccess.mockResolvedValue(false)
    const denied = await mint(app, ['sandbox-ui'], ['sandbox:ui:view'])
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'no_permitted_scopes' })
    expect(boundary.sandboxAccess).toHaveBeenCalledTimes(2)
    expect(directory.getUserAgents).not.toHaveBeenCalled()
    expect(directory.getTeamAgents).not.toHaveBeenCalled()
    expect(directory.getReachableAgentNames).not.toHaveBeenCalled()
    expect(issueRpcAccessToken).toHaveBeenCalledWith(
      { userId: 'u1', teamId: 't1', role: 'member' },
      ['sandbox:ui:view'],
      ['sandbox-ui'],
      []
    )
    expect(boundary.sign.mock.calls.length).toBe(0)
  })
})
