import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import request from 'supertest'
import {
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { createApp } from '../app.js'
import { createRpcRouter } from '../routes/rpc.js'
import type { UserDelegationV2Claims } from '../userDelegationV2.js'

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const delegationMock = vi.hoisted(() => ({
  tokenDeclaresV2: vi.fn(),
  verifyUserDelegationV2: vi.fn(),
}))
const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../userDelegationV2.js', () => delegationMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

const V2_USER_ID = '11111111-1111-4111-8111-111111111111'
const V2_SID = '22222222-2222-4222-8222-222222222222'
const V2_RESOURCE = canonicalResourceIdentity({
  environmentId: 'cluster.local/evenfire',
  type: 'runtime_session',
  logicalId: 'mcp-host/chatllm',
  displayName: 'chatllm',
})
const V2_TARGET = validateActionOperationTarget({
  operationId: 'session.manage',
  resource: V2_RESOURCE,
  operationTarget: {
    hostRef: 'mcp-host/chatllm',
    agent: 'chatllm',
    chatId: 'c1',
    action: 'rename',
  },
})
const V2_TARGET_HASH = hashActionTarget(V2_TARGET)
const V2_CLAIMS: UserDelegationV2Claims = {
  typ: 'user_delegation',
  ver: 2,
  sub: V2_USER_ID,
  sid: V2_SID,
  sv: 3,
  jti: '33333333-3333-4333-8333-333333333333',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 120,
  operationIds: ['session.manage'],
  scopes: [actionOperationScope('session.manage')],
  resource: V2_RESOURCE,
  targets: { 'session.manage': V2_TARGET },
  targetHashes: { 'session.manage': V2_TARGET_HASH },
  accessPathId: `ap1_${'b'.repeat(43)}`,
  authorizationRevision: `ar1_${'c'.repeat(43)}`,
  behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
  pathKind: 'direct',
  effectiveTeamId: null,
}

function checkpointAllowed() {
  const repositoryRoot = resolve(process.cwd(), '..')
  const output = execFileSync(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    [
      resolve(
        repositoryRoot,
        'control-api/test/fixtures/emitActionAuthorityCheckpointV2Fixture.ts'
      ),
      JSON.stringify({
        request: {
          version: 2,
          principal: { sub: V2_USER_ID, sid: V2_SID, sessionVersion: V2_CLAIMS.sv },
          delegationJti: V2_CLAIMS.jti,
          resource: V2_RESOURCE,
          operationId: 'session.manage',
          target: V2_TARGET,
          targetHash: V2_TARGET_HASH,
          accessPathId: V2_CLAIMS.accessPathId,
          authorizationRevision: V2_CLAIMS.authorizationRevision,
          behaviorBindingHash: V2_CLAIMS.behaviorBindingHash,
          domain: { service: 'rpc-proxy', resource: V2_RESOURCE, targetHash: V2_TARGET_HASH },
        },
        destination: {
          kind: 'host',
          ref: 'mcp-host/chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
        },
        checkedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  return JSON.parse(output)
}

// Spec 15 Fase B / BP1 — PATCH rename passthrough. The rename write path is a
// distinct scope (host:session:write) from the session reads and is NOT
// wake-eligible, so the token carries only host:session:write.
const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:session:write'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

// Edge identity headers are the trust boundary: mcp-host's runtimeEdgeGuard
// trusts x-clerum-edge-user-id (set by the proxy) and rejects any client
// Authorization. resolveHostConnectionForUser is what injects these; the route
// forwards ONLY host.headers, never the inbound Authorization.
const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-123',
  },
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

const originalFetch = globalThis.fetch

describe('PATCH /rpc/hosts/:hostRef/sessions/:agent/:chatId/name — rename passthrough', () => {
  beforeEach(() => {
    delegationMock.tokenDeclaresV2.mockReturnValue(false)
    delegationMock.verifyUserDelegationV2.mockReturnValue(V2_CLAIMS)
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('forwards PATCH to mcp-host with :agent and :chatId in the path and body verbatim', async () => {
    const upstream = { ok: true }
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(upstream),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'Quarterly planning' })
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions/chatllm/c1/name')
    expect((init as RequestInit).method).toBe('PATCH')
    // Only the edge headers are forwarded; the client Authorization is not.
    expect((init as RequestInit).headers).toMatchObject(HOST_CONNECTION.headers)
    expect((init as RequestInit).headers).not.toHaveProperty('authorization')
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization')
    // Body reaches the upstream verbatim (re-serialized from the parsed JSON).
    expect((init as RequestInit).body).toBe(JSON.stringify({ title: 'Quarterly planning' }))
    // Bounded upstream timeout (copied from the session reads, unlike /model).
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('checkpoints a producer-backed session.manage target before forwarding v2 rename', async () => {
    delegationMock.tokenDeclaresV2.mockImplementation(token => token === 'v2-token')
    serviceMock.resolveHostConnectionForUser.mockImplementation(
      async (_userId, _hostRef, _token, edgeContext) => ({
        name: 'chatllm',
        url: edgeContext.destination.url,
        headers: {
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-action-context': edgeContext.actionContextV2,
        },
      })
    )
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(checkpointAllowed()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, title: 'Quarterly planning' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    globalThis.fetch = fetchMock as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer v2-token')
      .send({ title: 'Quarterly planning' })
      .expect(200)

    const checkpointRequest = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(checkpointRequest).toMatchObject({
      operationId: 'session.manage',
      resource: V2_RESOURCE,
      target: V2_TARGET,
    })
    expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
      V2_USER_ID,
      'chatllm',
      'v2-token',
      expect.objectContaining({
        actionContextV2: expect.any(String),
        destination: expect.objectContaining({ kind: 'host', ref: 'mcp-host/chatllm' }),
      })
    )
    const upstreamHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>
    expect(upstreamHeaders['x-clerum-edge-action-context']).toEqual(expect.any(String))
    expect(upstreamHeaders['x-clerum-edge-user-id']).toBeUndefined()
  })

  it('returns 401 when no auth token is presented', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .send({ title: 'x' })
      .expect(401)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 403 when the token lacks host:session:write (read scope is not enough)', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: ['host:session:read'] })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(403)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 403 when the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/other-host/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(403)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    '/rpc/hosts/chatllm/sessions/agent%3Aother/c1/name',
    '/rpc/hosts/chatllm/sessions/agent%0Aother/c1/name',
    '/rpc/hosts/chatllm/sessions/agent/chat%0Aother/name',
    '/rpc/hosts/chat%2Fllm/sessions/chatllm/c1/name',
  ])('rejects unsafe route segments before forwarding upstream: %s', async path => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch(path)
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(400)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    { status: 400, body: { error: 'invalid title' } },
    { status: 403, body: { error: 'forbidden' } },
    { status: 404, body: { error: 'session not found' } },
  ])('propagates the upstream $status verbatim', async ({ status, body }) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(status)

    expect(res.body).toEqual(body)
  })

  it('maps a host-down fetch failure to a sanitized 502', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
  })

  it('maps an upstream timeout to a sanitized 504', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const fetchMock = vi.fn().mockRejectedValue(timeout)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(createApp())
      .patch('/api/v1/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: 'x' })
      .expect(504)

    expect(res.body).toEqual({ error: 'Gateway Timeout' })
  })

  it('does not log the raw title value', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const secret = 'synthetic-secret-title-value'
    await request(makeApp())
      .patch('/rpc/hosts/chatllm/sessions/chatllm/c1/name')
      .set('authorization', 'Bearer user-token')
      .send({ title: secret })
      .expect(200)

    for (const call of infoSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secret)
    }
  })
})
