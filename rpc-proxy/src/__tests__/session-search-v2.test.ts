import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import {
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { createRpcRouter } from '../routes/rpc.js'
import type { UserDelegationV2Claims } from '../userDelegationV2.js'

const delegationMock = vi.hoisted(() => ({
  tokenDeclaresV2: vi.fn(),
  verifyUserDelegationV2: vi.fn(),
}))
const legacyAuthMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))

vi.mock('../userDelegationV2.js', () => delegationMock)
vi.mock('../authToken.js', () => legacyAuthMock)

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const resource = canonicalResourceIdentity({
  environmentId: 'cluster.local/evenfire',
  type: 'runtime_session',
  logicalId: 'mcp-host/chatllm',
  displayName: 'chatllm',
})
const target = validateActionOperationTarget({
  operationId: 'session.read',
  resource,
  operationTarget: { hostRef: 'mcp-host/chatllm' },
})
const targetHash = hashActionTarget(target)
const claims: UserDelegationV2Claims = {
  typ: 'user_delegation',
  ver: 2,
  sub: userId,
  sid,
  sv: 3,
  jti: '33333333-3333-4333-8333-333333333333',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 120,
  operationIds: ['session.read'],
  scopes: [actionOperationScope('session.read')],
  resource,
  targets: { 'session.read': target },
  targetHashes: { 'session.read': targetHash },
  accessPathId: `ap1_${'b'.repeat(43)}`,
  authorizationRevision: `ar1_${'c'.repeat(43)}`,
  behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
  pathKind: 'direct',
  effectiveTeamId: null,
}

function behavior() {
  return {
    budget: { state: 'known' as const, value: null },
    credentialPolicy: { state: 'known' as const, value: null },
    approvalPolicy: { state: 'known' as const, value: null },
    filesystemScope: { state: 'known' as const, value: null },
    runtime: { state: 'known' as const, value: null },
    providerModelPolicy: { state: 'known' as const, value: null },
    audit: { state: 'known' as const, value: userId },
  }
}

function checkpointAllowed() {
  return {
    version: 2,
    status: 'allowed',
    authorizationRevision: claims.authorizationRevision,
    behaviorBindingHash: claims.behaviorBindingHash,
    behavior: behavior(),
    checkedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    attribution: {
      userId,
      sid,
      sessionVersion: claims.sv,
      accessPathId: claims.accessPathId,
      pathKind: claims.pathKind,
      effectiveTeamId: claims.effectiveTeamId,
    },
    destination: {
      kind: 'host',
      ref: 'mcp-host/chatllm',
      url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
    },
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

describe('GET /rpc/hosts/:hostRef/sessions/search v2 transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delegationMock.tokenDeclaresV2.mockImplementation(token => token === 'v2-token')
    delegationMock.verifyUserDelegationV2.mockReturnValue(claims)
    legacyAuthMock.verifyRpcToken.mockReturnValue({
      sub: userId,
      typ: 'user',
      accessScope: 'user',
      teamId: null,
      scopes: ['host:session:read'],
      hostRefs: ['chatllm'],
      jti: randomUUID(),
      iat: 1,
      exp: 9_999_999_999,
    })
  })

  it('checkpoints session.read and forwards only trusted-edge identity to mcp-host', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(checkpointAllowed()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [], total: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    globalThis.fetch = fetchMock as typeof fetch

    const response = await request(makeApp())
      .get(
        '/rpc/hosts/chatllm/sessions/search?q=budget&scope=all_channels&channel=rpc&since=2026-08-01T00%3A00%3A00Z&limit=99&user=victim'
      )
      .set('authorization', 'Bearer v2-token')
      .expect(200)

    expect(response.body).toEqual({ results: [], total: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const checkpointRequest = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(checkpointRequest).toMatchObject({
      principal: { sub: userId, sid, sessionVersion: 3 },
      operationId: 'session.read',
      resource,
      target: { hostRef: 'mcp-host/chatllm' },
      accessPathId: claims.accessPathId,
    })

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[1]
    expect(String(upstreamUrl)).toBe(
      'http://chatllm.mcp-host.svc.cluster.local:8080/v1/runtime/sessions/search?q=budget&scope=all_channels&channel=rpc&since=2026-08-01T00%3A00%3A00Z&limit=50'
    )
    const headers = upstreamInit.headers as Record<string, string>
    expect(headers['x-clerum-edge-caller']).toBe('rpc-proxy')
    expect(headers['x-clerum-edge-host-ref']).toBe('chatllm')
    expect(headers['x-clerum-edge-action-context']).toBeTruthy()
    expect(headers['x-clerum-edge-user-id']).toBeUndefined()
    expect(headers['x-clerum-edge-team-id']).toBeUndefined()
  })

  it('does not restore session search authority to a legacy external-user RPC token', async () => {
    delegationMock.tokenDeclaresV2.mockReturnValue(false)
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as typeof fetch

    await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/search?q=budget')
      .set('authorization', 'Bearer legacy-user-token')
      .expect(403, { error: 'User delegation v2 required for session search' })

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
