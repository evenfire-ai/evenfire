import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { actionAuthorityCacheKey, authorizeActionV2 } from './actionAuthorityV2.js'
import type { UserDelegationV2Claims } from './userDelegationV2.js'

const resource = canonicalResourceIdentity({
  environmentId: 'test',
  type: 'host',
  logicalId: 'mcp-host/chatllm',
  displayName: 'Chat LLM',
})
const target = validateActionOperationTarget({
  operationId: 'host.status.read',
  resource,
  operationTarget: { hostRef: 'mcp-host/chatllm' },
})
const bound = {
  operationId: 'host.status.read' as const,
  target,
  targetHash: hashActionTarget(target),
}
const sandboxResource = canonicalResourceIdentity({
  environmentId: 'test',
  type: 'sandbox_app',
  logicalId: 'sandbox-recipes/r1',
  displayName: 'r1',
})
const sandboxTarget = validateActionOperationTarget({
  operationId: 'sandbox.open',
  resource: sandboxResource,
  operationTarget: { recipeNamespace: 'sandbox-recipes', recipeName: 'r1' },
})
const sandboxBound = {
  operationId: 'sandbox.open' as const,
  target: sandboxTarget,
  targetHash: hashActionTarget(sandboxTarget),
}

function claims(
  pathKind: 'direct' | 'team',
  effectiveTeamId: string | null
): UserDelegationV2Claims {
  return {
    typ: 'user_delegation',
    ver: 2,
    sub: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    sv: 2,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 120,
    operationIds: ['host.status.read'],
    scopes: ['action:host.status.read'],
    resource,
    targets: { 'host.status.read': target },
    targetHashes: { 'host.status.read': bound.targetHash },
    accessPathId: `ap1_${pathKind === 'direct' ? 'A' : 'T'.repeat(43)}`.padEnd(47, 'A'),
    authorizationRevision: `ar1_${'B'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'C'.repeat(43)}`,
    pathKind,
    effectiveTeamId,
  }
}

const behavior = {
  budget: { state: 'known' as const, value: 'budget-1' },
  credentialPolicy: { state: 'unknown' as const },
  approvalPolicy: { state: 'unknown' as const },
  filesystemScope: { state: 'unknown' as const },
  runtime: { state: 'known' as const, value: 'runtime-1' },
  providerModelPolicy: { state: 'unknown' as const },
  audit: { state: 'known' as const, value: 'audit-1' },
}

function producerCheckpoint(delegation: UserDelegationV2Claims) {
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
          principal: { sub: delegation.sub, sid: delegation.sid, sessionVersion: delegation.sv },
          delegationJti: delegation.jti,
          resource,
          operationId: bound.operationId,
          target: bound.target,
          targetHash: bound.targetHash,
          accessPathId: delegation.accessPathId,
          authorizationRevision: delegation.authorizationRevision,
          behaviorBindingHash: delegation.behaviorBindingHash,
          domain: { service: 'rpc-proxy', resource, targetHash: bound.targetHash },
        },
        destination: {
          kind: 'host',
          ref: 'mcp-host/chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
        },
        checkedAt: new Date().toISOString(),
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  return JSON.parse(output)
}

const messageTarget = validateActionOperationTarget({
  operationId: 'chat.message.invoke',
  resource,
  operationTarget: {
    hostRef: 'mcp-host/chatllm',
    channelType: 'rpc',
    channelId: 'chatllm',
    messageId: '40000000-0000-4000-8000-000000000004',
  },
})
const messageBound = {
  operationId: 'chat.message.invoke' as const,
  target: messageTarget,
  targetHash: hashActionTarget(messageTarget),
}

function messageClaims(): UserDelegationV2Claims {
  return {
    ...claims('direct', null),
    operationIds: ['chat.message.invoke'],
    scopes: ['action:chat.message.invoke'],
    targets: { 'chat.message.invoke': messageTarget },
    targetHashes: { 'chat.message.invoke': messageBound.targetHash },
  }
}

function producerMessageCheckpoint(
  delegation: UserDelegationV2Claims,
  hostMessageAdmission: { sendNonce: string; delegationExpiresAt: number; receipt?: string }
) {
  const repositoryRoot = resolve(process.cwd(), '..')
  const targetHash = messageBound.targetHash
  const requestBody = {
    version: 2,
    principal: { sub: delegation.sub, sid: delegation.sid, sessionVersion: delegation.sv },
    delegationJti: delegation.jti,
    resource,
    operationId: messageBound.operationId,
    target: messageBound.target,
    targetHash,
    accessPathId: delegation.accessPathId,
    authorizationRevision: delegation.authorizationRevision,
    behaviorBindingHash: delegation.behaviorBindingHash,
    hostMessageAdmission,
    domain: { service: 'rpc-proxy', resource, targetHash },
  }
  const output = execFileSync(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    [
      resolve(
        repositoryRoot,
        'control-api/test/fixtures/emitActionAuthorityCheckpointV2Fixture.ts'
      ),
      JSON.stringify({
        request: requestBody,
        destination: {
          kind: 'host',
          ref: 'mcp-host/chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:3000',
        },
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  return JSON.parse(output)
}

describe('action authority checkpoint and cache isolation', () => {
  it('uses every authority-relevant path dimension in the cache key', () => {
    const direct = claims('direct', null)
    const team = {
      ...direct,
      pathKind: 'team' as const,
      effectiveTeamId: '33333333-3333-4333-8333-333333333333',
      accessPathId: `ap1_${'T'.repeat(43)}`,
    }
    expect(actionAuthorityCacheKey(direct, bound)).not.toBe(actionAuthorityCacheKey(team, bound))
  })

  it('posts the exact delegation binding and emits trusted server context', async () => {
    const delegation = claims('direct', null)
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(producerCheckpoint(delegation)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const authorized = await authorizeActionV2(delegation, bound, { fetchImpl })
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const requestBody = JSON.parse(String(call[1].body))
    expect(requestBody).toMatchObject({
      version: 2,
      principal: { sub: delegation.sub, sid: delegation.sid, sessionVersion: delegation.sv },
      operationId: bound.operationId,
      target: bound.target,
      targetHash: bound.targetHash,
      accessPathId: delegation.accessPathId,
    })
    expect(
      JSON.parse(Buffer.from(authorized.trustedEdgeHeader, 'base64url').toString('utf8'))
    ).toMatchObject({
      version: 2,
      userId: delegation.sub,
      accessPathId: delegation.accessPathId,
      operationId: bound.operationId,
    })
  })

  it('keeps the server nonce and Control API receipt request-local across live rechecks', async () => {
    const delegation = messageClaims()
    const sendContext = {
      sendNonce: randomBytes(32).toString('base64url'),
      delegationExpiresAt: delegation.exp,
    }
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify(producerMessageCheckpoint(delegation, requestBody.hostMessageAdmission)),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    let initialReceipt: string | undefined
    const initial = await authorizeActionV2(delegation, messageBound, {
      fetchImpl,
      hostMessageAdmission: sendContext,
      onHostMessageAdmissionReceipt: receipt => {
        initialReceipt = receipt
      },
    })
    const firstRequest = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(firstRequest.hostMessageAdmission).toEqual(sendContext)
    expect(initialReceipt).toMatch(/^eyJ/)
    expect(initial).not.toHaveProperty('hostMessageAdmission')
    expect(initial.checkpoint).not.toHaveProperty('hostMessageAdmissionReceipt')
    expect(initial.trustedEdgeContext).not.toHaveProperty('hostMessageAdmissionReceipt')
    expect(Buffer.from(initial.trustedEdgeHeader, 'base64url').toString('utf8')).not.toContain(
      initialReceipt!
    )

    const retryContext = { ...sendContext, receipt: initialReceipt! }
    let retryReceipt: string | undefined
    const rechecked = await authorizeActionV2(delegation, messageBound, {
      fetchImpl,
      hostMessageAdmission: retryContext,
      onHostMessageAdmissionReceipt: receipt => {
        retryReceipt = receipt
      },
    })
    const retryRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))
    expect(retryRequest.hostMessageAdmission).toEqual(retryContext)
    expect(retryReceipt).toBe(initialReceipt)
    expect(rechecked).not.toHaveProperty('hostMessageAdmission')
    expect(rechecked.checkpoint).not.toHaveProperty('hostMessageAdmissionReceipt')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('preserves canonical admission 429 metadata and typed unavailable 503', async () => {
    const delegation = messageClaims()
    const hostMessageAdmission = {
      sendNonce: randomBytes(32).toString('base64url'),
      delegationExpiresAt: delegation.exp,
    }
    const limited = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Too Many Requests', retryAfterSeconds: 8 }), {
          status: 429,
          headers: {
            'Retry-After': '8',
            'X-RateLimit-Limit': '60',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '1900000000',
          },
        })
    )
    await expect(
      authorizeActionV2(delegation, messageBound, { fetchImpl: limited, hostMessageAdmission })
    ).rejects.toMatchObject({
      status: 429,
      code: 'Too Many Requests',
      rateLimit: {
        retryAfterSeconds: 8,
        headers: { 'Retry-After': '8', 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0' },
      },
    })

    const unavailable = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'host_message_admission_unavailable' }), {
          status: 503,
        })
    )
    await expect(
      authorizeActionV2(delegation, messageBound, {
        fetchImpl: unavailable,
        hostMessageAdmission,
      })
    ).rejects.toMatchObject({ status: 503, code: 'host_message_admission_unavailable' })
  })

  it('validates the distinct Host-RPC unavailable contract for non-message checkpoints', async () => {
    const delegation = claims('direct', null)
    const unavailable = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'host_rpc_admission_unavailable' }), {
          status: 503,
        })
    )
    await expect(
      authorizeActionV2(delegation, bound, { fetchImpl: unavailable })
    ).rejects.toMatchObject({
      status: 503,
      code: 'host_rpc_admission_unavailable',
    })

    const wrongOperationError = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'host_message_admission_unavailable' }), {
          status: 503,
        })
    )
    await expect(
      authorizeActionV2(delegation, bound, { fetchImpl: wrongOperationError })
    ).rejects.toMatchObject({ status: 503, code: 'authority_unavailable' })
  })

  it('fails closed on response-status substitution', async () => {
    const delegation = claims('direct', null)
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: 2, status: 'denied', code: 'forbidden' }), {
          status: 200,
        })
    )
    await expect(authorizeActionV2(delegation, bound, { fetchImpl })).rejects.toMatchObject({
      status: 503,
      code: 'authority_unavailable',
    })
  })

  it('rejects a substituted checkpoint destination', async () => {
    const delegation = claims('direct', null)
    const now = new Date()
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 2,
            status: 'allowed',
            authorizationRevision: delegation.authorizationRevision,
            behaviorBindingHash: delegation.behaviorBindingHash,
            behavior,
            checkedAt: now.toISOString(),
            validUntil: new Date(now.getTime() + 30_000).toISOString(),
            attribution: {
              userId: delegation.sub,
              sid: delegation.sid,
              sessionVersion: delegation.sv,
              accessPathId: delegation.accessPathId,
              pathKind: delegation.pathKind,
              effectiveTeamId: delegation.effectiveTeamId,
            },
            destination: {
              kind: 'host',
              ref: 'mcp-host/other',
              url: 'http://other.mcp-host.svc.cluster.local:8080',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    await expect(authorizeActionV2(delegation, bound, { fetchImpl })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_binding',
    })
  })

  it('accepts the canonical null destination for an exact sandbox delegation', async () => {
    const delegation = {
      ...claims('direct', null),
      operationIds: ['sandbox.open'] as const,
      scopes: ['action:sandbox.open'] as const,
      resource: sandboxResource,
      targets: { 'sandbox.open': sandboxTarget },
      targetHashes: { 'sandbox.open': sandboxBound.targetHash },
    }
    const now = new Date()
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 2,
            status: 'allowed',
            authorizationRevision: delegation.authorizationRevision,
            behaviorBindingHash: delegation.behaviorBindingHash,
            behavior,
            checkedAt: now.toISOString(),
            validUntil: new Date(now.getTime() + 30_000).toISOString(),
            attribution: {
              userId: delegation.sub,
              sid: delegation.sid,
              sessionVersion: delegation.sv,
              accessPathId: delegation.accessPathId,
              pathKind: delegation.pathKind,
              effectiveTeamId: delegation.effectiveTeamId,
            },
            destination: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    await expect(authorizeActionV2(delegation, sandboxBound, { fetchImpl })).resolves.toMatchObject(
      {
        bound: sandboxBound,
      }
    )
  })

  it('rejects an expired delegation before a checkpoint can extend it', async () => {
    const delegation = { ...claims('direct', null), exp: Math.floor(Date.now() / 1000) - 1 }
    const fetchImpl = vi.fn()
    await expect(authorizeActionV2(delegation, bound, { fetchImpl })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
