import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_CLAIM_TYPE,
  HOST_EDGE_ASSERTION_JWT_TYPE,
  HOST_EDGE_ASSERTION_V1_CLAIM_KEYS,
  validateHostEdgeAssertionClaims,
} from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { DirectRunBindingConflictError } from '../src/services/tracing/directRunAttributionBindingService.js'
import { signRpcAccessToken, verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

/**
 * Host edge assertion issuance on the V1 Host access route. Every request goes through the
 * real RPC token middleware with a token from the production signer, and every assertion is
 * decoded the way the Host verifies it: the RPC public key, RS256 only, the edge audience and
 * the RPC issuer, plus the JWS header type, then the shared claim validator.
 */

const directory = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => directory)

type SigningClaims = Parameters<typeof signRpcAccessToken>[0]

const USER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000009'
const TEAM_ID = '00000000-0000-4000-8000-000000000002'
const HOST_REF = 'host-a'
const DIRECT_BINDING_BODY = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'session-a',
  origin: 'direct_chat',
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function token(claims: Partial<SigningClaims> = {}, ttlSeconds?: number): string {
  return signRpcAccessToken(
    {
      sub: USER_ID,
      typ: 'user',
      accessScope: 'team',
      teamId: TEAM_ID,
      scopes: ['host:status:read', 'host:message:invoke'],
      hostRefs: [HOST_REF],
      jti: 'rpc-token-jti',
      ...claims,
    },
    ttlSeconds === undefined ? undefined : { ttlSeconds }
  )
}

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
      runId: input.runId,
      status: 'created' as const,
      createdAt: new Date().toISOString(),
    })),
  }
  const app = express()
  app.use(createRpcAccessUsersRouter(gateway as unknown as K8sGateway, { bindingService }))
  return { app, gateway, bindingService }
}

function hostPath(userId = USER_ID, hostRef = HOST_REF) {
  return `/rpc/access/users/${userId}/mcp-hosts/${hostRef}`
}

/** Decodes an assertion exactly as the Host verifies it. */
function verifyAsHost(assertion: string): jwt.JwtPayload {
  const decoded = jwt.decode(assertion, { complete: true })
  expect(decoded?.header).toEqual({ alg: 'RS256', typ: HOST_EDGE_ASSERTION_JWT_TYPE })
  return jwt.verify(assertion, config.rpcJwtPublicKey, {
    algorithms: ['RS256'],
    audience: HOST_EDGE_ASSERTION_AUDIENCE,
    issuer: config.rpcJwtIssuer,
  }) as jwt.JwtPayload
}

beforeEach(() => {
  vi.clearAllMocks()
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

afterEach(() => {
  vi.useRealTimers()
})

describe('V1 Host access route issues a Host edge assertion', () => {
  it('returns the connection and an assertion whose claims come from the verified token and the authorized Host', async () => {
    const { app, gateway } = buildApp()
    const rpcToken = token()
    const verified = verifyRpcAccessToken(rpcToken)!

    const response = await request(app)
      .get(hostPath())
      .set('x-rpc-access-token', rpcToken)
      .expect(200)

    expect(Object.keys(response.body).sort()).toEqual(['edgeAssertion', 'hostRef', 'url', 'userId'])
    expect(response.body).toMatchObject({
      userId: USER_ID,
      hostRef: HOST_REF,
      url: `http://${HOST_REF}.${config.hostsNamespace}.svc.cluster.local:8080`,
    })
    const payload = verifyAsHost(response.body.edgeAssertion)
    expect(Object.keys(payload).sort()).toEqual([...HOST_EDGE_ASSERTION_V1_CLAIM_KEYS].sort())
    expect(payload).toEqual({
      typ: HOST_EDGE_ASSERTION_CLAIM_TYPE,
      v: 1,
      iss: config.rpcJwtIssuer,
      aud: HOST_EDGE_ASSERTION_AUDIENCE,
      sub: USER_ID,
      host: `${config.hostsNamespace}/${HOST_REF}`,
      jti: expect.stringMatching(UUID_V4),
      iat: expect.any(Number),
      exp: Math.min(payload.iat! + 300, verified.exp),
      teamId: TEAM_ID,
      scopes: verified.scopes,
    })
    // Witness: the route authorized the request once.
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
    expect(gateway.listResource).toHaveBeenCalledTimes(1)
  })

  it('round-trips a route-issued assertion through the Host verifier and the shared validator', async () => {
    const { app } = buildApp()
    const response = await request(app)
      .get(hostPath())
      .set('x-rpc-access-token', token())
      .expect(200)

    const payload = verifyAsHost(response.body.edgeAssertion)
    expect(
      validateHostEdgeAssertionClaims(
        payload,
        {
          v: 1,
          iss: config.rpcJwtIssuer,
          host: `${config.hostsNamespace}/${HOST_REF}`,
          sub: USER_ID,
          teamId: TEAM_ID,
          requiredScope: 'host:status:read',
        },
        Math.floor(Date.now() / 1000)
      )
    ).toEqual({ ok: true })
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
  })

  it('refuses a route-issued assertion on a Host clock more than 5 seconds behind the issuer', async () => {
    const { app } = buildApp()
    const response = await request(app)
      .get(hostPath())
      .set('x-rpc-access-token', token())
      .expect(200)

    const payload = verifyAsHost(response.body.edgeAssertion)
    const expected = {
      v: 1 as const,
      iss: config.rpcJwtIssuer,
      host: `${config.hostsNamespace}/${HOST_REF}`,
      sub: USER_ID,
      teamId: TEAM_ID,
      requiredScope: 'host:status:read',
    }
    // Liveness witness: the same payload passes on a Host clock equal to the issuer clock.
    expect(validateHostEdgeAssertionClaims(payload, expected, payload.iat!)).toEqual({ ok: true })
    expect(validateHostEdgeAssertionClaims(payload, expected, payload.iat! - 6)).toEqual({
      ok: false,
      error: 'iat is in the future',
    })
  })

  it('bounds the lifetime by the RPC token expiry and otherwise by 300 seconds', async () => {
    const { app } = buildApp()
    const shortToken = token({}, 60)
    const short = await request(app)
      .get(hostPath())
      .set('x-rpc-access-token', shortToken)
      .expect(200)
    const shortPayload = verifyAsHost(short.body.edgeAssertion)
    expect(shortPayload.exp).toBe(verifyRpcAccessToken(shortToken)!.exp)
    expect(shortPayload.exp! - shortPayload.iat!).toBeLessThanOrEqual(60)

    const long = await request(app)
      .get(hostPath())
      .set('x-rpc-access-token', token({}, 3_600))
      .expect(200)
    const longPayload = verifyAsHost(long.body.edgeAssertion)
    expect(longPayload.exp! - longPayload.iat!).toBe(300)
    expect(directory.getUserAgents).toHaveBeenCalledTimes(2)
  })

  it('carries a null team for a user-scoped token', async () => {
    const { app } = buildApp()
    const response = await request(app)
      .get(hostPath())
      .set('x-rpc-access-token', token({ accessScope: 'user', teamId: null }))
      .expect(200)
    expect(verifyAsHost(response.body.edgeAssertion).teamId).toBeNull()
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
  })

  it('copies only the verified token scopes, in token order', async () => {
    const { app } = buildApp()
    const rpcToken = token({
      scopes: ['host:session:read', 'not-a-scope', 'host:status:read'] as never,
    })
    const response = await request(app)
      .get(hostPath())
      .set('x-rpc-access-token', rpcToken)
      .expect(200)
    expect(verifyAsHost(response.body.edgeAssertion).scopes).toEqual([
      'host:session:read',
      'host:status:read',
    ])
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
  })

  it('takes no claim from request input that authorization did not check', async () => {
    const { app } = buildApp()
    const response = await request(app)
      .get(`${hostPath()}?sub=${OTHER_USER_ID}&teamId=other-team&scopes=host:model:write`)
      .set('x-rpc-access-token', token({ scopes: ['host:status:read'] }))
      .set('x-clerum-edge-user-id', OTHER_USER_ID)
      .set('x-clerum-edge-team-id', 'other-team')
      .expect(200)
    const payload = verifyAsHost(response.body.edgeAssertion)
    expect(payload).toMatchObject({
      sub: USER_ID,
      teamId: TEAM_ID,
      scopes: ['host:status:read'],
      host: `${config.hostsNamespace}/${HOST_REF}`,
    })
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'another user in the path',
      path: hostPath(OTHER_USER_ID),
      reason: 'subject_mismatch',
    },
    {
      name: 'a Host the token does not name',
      path: hostPath(USER_ID, 'host-b'),
      reason: 'host_claim_missing',
    },
  ])('issues no assertion for $name', async ({ path, reason }) => {
    const { app } = buildApp()
    const denied = await request(app).get(path).set('x-rpc-access-token', token()).expect(403)
    expect(denied.body).toEqual({ error: 'Forbidden' })
    // Witness: the route ran and named its denial.
    expect(denied.headers['x-host-access-denial-reason']).toBe(reason)
    expect(denied.body).not.toHaveProperty('edgeAssertion')
  })

  it('issues no assertion when the directory grant is missing', async () => {
    directory.getUserAgents.mockResolvedValue({ userId: USER_ID, agentNames: [] })
    directory.getTeamAgents.mockResolvedValue({ teamId: TEAM_ID, agentNames: [] })
    const { app } = buildApp()
    const denied = await request(app).get(hostPath()).set('x-rpc-access-token', token()).expect(403)
    expect(denied.body).toEqual({ error: 'Forbidden' })
    expect(denied.body).not.toHaveProperty('edgeAssertion')
    expect(denied.headers['x-host-access-denial-reason']).toBe('directory_grant_missing')
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
  })
})

describe('V1 Host access route (POST, direct-run binding) issues a Host edge assertion', () => {
  it('adds the assertion to a recorded binding response', async () => {
    const { app, bindingService } = buildApp()
    const response = await request(app)
      .post(hostPath())
      .set('x-rpc-access-token', token())
      .send(DIRECT_BINDING_BODY)
      .expect(200)
    expect(Object.keys(response.body).sort()).toEqual([
      'bindingStatus',
      'edgeAssertion',
      'hostRef',
      'url',
      'userId',
    ])
    expect(response.body.bindingStatus).toBe('recorded')
    expect(verifyAsHost(response.body.edgeAssertion)).toMatchObject({
      v: 1,
      sub: USER_ID,
      host: `${config.hostsNamespace}/${HOST_REF}`,
      teamId: TEAM_ID,
    })
    expect(bindingService.bind).toHaveBeenCalledTimes(1)
  })

  it('adds the assertion to an unavailable binding response', async () => {
    const { app, bindingService } = buildApp()
    bindingService.bind.mockRejectedValue(new Error('storage unavailable'))
    const response = await request(app)
      .post(hostPath())
      .set('x-rpc-access-token', token())
      .send(DIRECT_BINDING_BODY)
      .expect(200)
    expect(response.body.bindingStatus).toBe('unavailable')
    expect(verifyAsHost(response.body.edgeAssertion)).toMatchObject({ v: 1, sub: USER_ID })
    expect(bindingService.bind).toHaveBeenCalledTimes(1)
  })

  it('keeps the conflict response without a connection or an assertion', async () => {
    const { app, bindingService } = buildApp()
    bindingService.bind.mockRejectedValue(new DirectRunBindingConflictError())
    await request(app)
      .post(hostPath())
      .set('x-rpc-access-token', token())
      .send(DIRECT_BINDING_BODY)
      .expect(409)
      .expect({ error: 'direct_run_binding_conflict' })
    expect(bindingService.bind).toHaveBeenCalledTimes(1)
  })
})

describe('V1 Host access route refuses to sign when the RPC token ends in the second of issue', () => {
  // The middleware verifies the token while it is still valid; the clock then reaches its
  // expiry during authorization, so no lifetime remains for the assertion.
  function expireDuringAuthorization(rpcToken: string) {
    const exp = verifyRpcAccessToken(rpcToken)!.exp
    directory.getUserAgents.mockImplementation(async (userId: string) => {
      vi.setSystemTime(exp * 1000)
      return { userId, agentNames: [HOST_REF] }
    })
  }

  it('answers GET with 401 Unauthorized', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 21, 12, 0, 0, 0))
    const { app, gateway } = buildApp()
    const rpcToken = token({}, 1)
    expireDuringAuthorization(rpcToken)

    const response = await request(app).get(hostPath()).set('x-rpc-access-token', rpcToken)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    // Witness: authorization ran to the end before the refusal.
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
    expect(gateway.listResource).toHaveBeenCalledTimes(1)
  })

  it('answers POST with 401 Unauthorized and records no binding', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 21, 12, 0, 0, 0))
    const { app, gateway, bindingService } = buildApp()
    const rpcToken = token({}, 1)
    expireDuringAuthorization(rpcToken)

    const response = await request(app)
      .post(hostPath())
      .set('x-rpc-access-token', rpcToken)
      .send(DIRECT_BINDING_BODY)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(directory.getUserAgents).toHaveBeenCalledTimes(1)
    expect(gateway.listResource).toHaveBeenCalledTimes(1)
    expect(bindingService.bind).not.toHaveBeenCalled()
  })
})
