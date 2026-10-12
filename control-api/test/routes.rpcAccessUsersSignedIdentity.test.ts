import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { signRpcAccessToken, verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

const directory = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
}))
const db = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }))

vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/db.js', () => ({ pool: db }))

type SigningClaims = Parameters<typeof signRpcAccessToken>[0]
const HOST_REF = 'host-a'
const BASE_CLAIMS: SigningClaims = {
  sub: 'user-1',
  typ: 'user',
  accessScope: 'user',
  teamId: null,
  scopes: ['host:message:invoke'],
  hostRefs: [HOST_REF],
  jti: 'opaque-request/id',
}
const DIRECT_BINDING_BODY = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'session-a',
  origin: 'direct_chat',
}
const CLAIM_VARIANTS = [
  { name: 'user', claims: { accessScope: 'user', teamId: null } },
  { name: 'team', claims: { accessScope: 'team', teamId: 'team-1' } },
  { name: 'legacy team', claims: { accessScope: undefined, teamId: 'team-1' } },
  {
    name: 'service',
    claims: { typ: 'service', accessScope: 'service', teamId: 'system', service: 'workflow' },
  },
] satisfies Array<{ name: string; claims: Partial<SigningClaims> }>
const BLANK_IDENTITIES = [
  { name: 'empty sub', claims: { sub: '' }, userId: '  ' },
  { name: 'whitespace sub', claims: { sub: ' \t\r\n\u00a0' }, userId: ' \t\r\n\u00a0' },
  { name: 'empty jti', claims: { jti: '' }, userId: 'user-1' },
  { name: 'whitespace jti', claims: { jti: ' \t\r\n\u00a0' }, userId: 'user-1' },
]

beforeEach(() => {
  vi.clearAllMocks()
  // Deliberately grant the host at the external directory boundary, including
  // for an empty user id: invalid identity rejection must come from real auth.
  directory.getUserAgents.mockImplementation(async (userId: string) => ({
    userId,
    agentNames: [HOST_REF],
  }))
  directory.getCurrentTeam.mockImplementation(async (_userId: string, teamId: string) => ({
    id: teamId,
    name: 'Team',
    role: 'member',
  }))
  directory.getTeamAgents.mockImplementation(async (teamId: string) => ({
    teamId,
    agentNames: [HOST_REF],
  }))
})

function buildApp() {
  const gateway = {
    listResource: vi.fn(async () => [{ metadata: { name: HOST_REF }, spec: { enabled: true } }]),
    getResource: vi.fn(),
    createResource: vi.fn(),
    updateResource: vi.fn(),
    deleteResource: vi.fn(),
  }
  const bindingService = {
    bind: vi.fn(async (input: { runId: string }) => ({
      runId: input.runId.toLowerCase(),
      status: 'created' as const,
      createdAt: new Date().toISOString(),
    })),
  }
  const app = express()
  app.use(createRpcAccessUsersRouter(gateway as unknown as K8sGateway, { bindingService }))
  return { app, gateway, bindingService }
}

function expectNoSideEffects({ gateway, bindingService }: ReturnType<typeof buildApp>) {
  for (const call of [
    ...Object.values(directory),
    ...Object.values(db),
    ...Object.values(gateway),
  ]) {
    expect(call).not.toHaveBeenCalled()
  }
  expect(bindingService.bind).not.toHaveBeenCalled()
}

async function hostRequest(
  app: express.Express,
  method: 'GET' | 'POST',
  userId: string,
  claims: Partial<SigningClaims> = {}
) {
  const path = `/rpc/access/users/${encodeURIComponent(userId)}/mcp-hosts/${HOST_REF}`
  const operation = method === 'GET' ? request(app).get(path) : request(app).post(path)
  // Use the production RS256 signer and existing non-production test config.
  // A malformed signed claim requires signing authority; it is not remote minting.
  operation.set('x-rpc-access-token', signRpcAccessToken({ ...BASE_CLAIMS, ...claims }))
  if (method === 'POST') operation.send(DIRECT_BINDING_BODY)
  return operation
}

describe('RPC signed identity validation', () => {
  it.each(
    CLAIM_VARIANTS.flatMap(variant =>
      BLANK_IDENTITIES.map(identity => ({
        name: `${variant.name}: ${identity.name}`,
        claims: { ...variant.claims, ...identity.claims },
      }))
    )
  )('rejects $name in the canonical verifier', ({ claims }) => {
    expect(verifyRpcAccessToken(signRpcAccessToken({ ...BASE_CLAIMS, ...claims }))).toBeNull()
  })

  it.each(CLAIM_VARIANTS)(
    'preserves nonblank signed sub and jti for $name tokens',
    ({ claims }) => {
      const identity = { sub: ' \topaque/user identity\u00a0', jti: ' \topaque-request/id\u00a0' }
      expect(
        verifyRpcAccessToken(signRpcAccessToken({ ...BASE_CLAIMS, ...claims, ...identity }))
      ).toMatchObject(identity)
    }
  )

  it.each(
    BLANK_IDENTITIES.flatMap(identity =>
      (['GET', 'POST'] as const).map(method => ({ ...identity, method }))
    )
  )('$method rejects $name with 401 before external work', async ({ method, claims, userId }) => {
    const fixture = buildApp()
    const response = await hostRequest(fixture.app, method, userId, claims)
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(response.headers['x-host-access-denial-reason']).toBeUndefined()
    expectNoSideEffects(fixture)
  })

  it.each(['GET', 'POST'] as const)(
    '%s denies a nonblank padded signed subject without normalizing it to the URL user',
    async method => {
      const fixture = buildApp()
      const response = await hostRequest(fixture.app, method, ' user-1 ', { sub: ' user-1 ' })
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: 'Forbidden' })
      expect(response.headers['x-host-access-denial-reason']).toBe('subject_mismatch')
      expectNoSideEffects(fixture)
    }
  )

  it.each(CLAIM_VARIANTS.filter(variant => variant.name !== 'service'))(
    'authorizes $name tokens after trimming the route user parameter',
    async ({ name, claims }) => {
      if (name !== 'user') {
        directory.getUserAgents.mockResolvedValue({ userId: 'user-1', agentNames: [] })
      }
      const fixture = buildApp()
      const read = await hostRequest(fixture.app, 'GET', ' user-1 ', claims)
      expect(read.status).toBe(200)
      expect(read.body).toMatchObject({ userId: 'user-1', hostRef: HOST_REF })
      const bind = await hostRequest(fixture.app, 'POST', ' user-1 ', claims)
      expect(bind.status).toBe(200)
      expect(bind.body).toMatchObject({
        userId: 'user-1',
        hostRef: HOST_REF,
        bindingStatus: 'recorded',
      })
      expect(directory.getUserAgents).toHaveBeenNthCalledWith(1, 'user-1')
      expect(directory.getUserAgents).toHaveBeenNthCalledWith(2, 'user-1')
      expect(fixture.gateway.listResource).toHaveBeenCalledTimes(2)
      expect(fixture.bindingService.bind).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ...DIRECT_BINDING_BODY,
          hostRef: HOST_REF,
          actorHumanSub: 'user-1',
          userId: 'user-1',
          teamId: claims.teamId,
        })
      )
      expect(directory.getCurrentTeam).toHaveBeenCalledTimes(name === 'user' ? 0 : 2)
      expect(directory.getTeamAgents).toHaveBeenCalledTimes(name === 'user' ? 0 : 2)
    }
  )

  it.each(['GET', 'POST'] as const)('%s keeps service tokens outside user routes', async method => {
    const fixture = buildApp()
    const response = await hostRequest(
      fixture.app,
      method,
      'user-1',
      CLAIM_VARIANTS.find(variant => variant.name === 'service')!.claims
    )
    expect(response.status).toBe(401)
    expectNoSideEffects(fixture)
  })

  it.each([
    { method: 'GET' as const, scopes: ['mcp:servers:list'] as const },
    { method: 'POST' as const, scopes: ['host:status:read'] as const },
  ])(
    '$method still rejects a valid identity with insufficient scopes',
    async ({ method, scopes }) => {
      const fixture = buildApp()
      const response = await hostRequest(fixture.app, method, 'user-1', { scopes: [...scopes] })
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: 'Forbidden' })
      expect(response.headers['x-host-access-denial-reason']).toBeUndefined()
      expectNoSideEffects(fixture)
    }
  )
})
