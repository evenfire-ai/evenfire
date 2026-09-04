import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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
              ref: 'mcp-host/chatllm',
              url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
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
})
