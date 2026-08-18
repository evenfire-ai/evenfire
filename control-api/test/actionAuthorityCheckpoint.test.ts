import { describe, expect, it } from 'vitest'
import {
  hashActionTarget,
  validateActionAuthorityCheckpointResponse,
} from '@clerum/action-context-contracts'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { knownBehavior } from '../src/services/access/accessPath.js'
import {
  checkpointActionAuthority,
  parseActionAuthorityCheckpointRequest,
} from '../src/services/access/actionAuthorityCheckpoint.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: 'default/chatllm',
})
const target = Object.freeze({ hostRef: 'default/chatllm' })
const targetHash = hashActionTarget(target)
const caller = Object.freeze({
  service: 'rpc-proxy',
  trustPlane: 'internal_service_token',
} as const)

function request() {
  return {
    version: 2,
    principal: {
      sub: '10000000-0000-4000-8000-000000000001',
      sid: '20000000-0000-4000-8000-000000000002',
      sessionVersion: 1,
    },
    delegationJti: '30000000-0000-4000-8000-000000000003',
    resource,
    operationId: 'host.status.read',
    target,
    targetHash,
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    domain: { service: 'rpc-proxy', resource, targetHash },
  }
}

describe('action authority checkpoint wire parser', () => {
  it('accepts the exact canonical rpc-proxy binding', () => {
    expect(parseActionAuthorityCheckpointRequest(request(), caller)).toMatchObject({
      version: 2,
      operationId: 'host.status.read',
      accessPathId: `ap1_${'a'.repeat(43)}`,
      authorizationRevision: `ar1_${'b'.repeat(43)}`,
    })
  })

  it.each([
    ['service', value => ({ ...value, domain: { ...value.domain, service: 'mcp-host' } })],
    [
      'resource',
      value => ({
        ...value,
        domain: {
          ...value.domain,
          resource: { ...resource, logicalId: 'default/other', canonicalId: 'host:default/other' },
        },
      }),
    ],
    ['target', value => ({ ...value, target: { hostRef: 'default/other' } })],
    ['path', value => ({ ...value, accessPathId: `ap1_${'!'.repeat(43)}` })],
    ['revision', value => ({ ...value, authorizationRevision: `ar1_${'!'.repeat(43)}` })],
    ['unknown field', value => ({ ...value, role: 'admin' })],
  ] as const)('rejects %s substitution', (_label, mutate) => {
    expect(() => parseActionAuthorityCheckpointRequest(mutate(request()), caller)).toThrow(
      'invalid_binding'
    )
  })
})

describe('action authority checkpoint outcomes', () => {
  const parsed = parseActionAuthorityCheckpointRequest(request(), caller)
  const behavior = Object.freeze({
    capabilities: Object.freeze(['host.read'] as const),
    budget: knownBehavior(null),
    credentialPolicy: knownBehavior(null),
    approvalPolicy: knownBehavior(null),
    filesystemScope: knownBehavior(null),
    runtime: knownBehavior(null),
    providerModelPolicy: knownBehavior(null),
    audit: knownBehavior(`user:${parsed.principal.sub}`),
  })

  function allowedAuthorization() {
    return {
      status: 'allowed' as const,
      context: {
        version: 2 as const,
        principal: {
          userId: parsed.principal.sub,
          sid: parsed.principal.sid,
          sessionVersion: parsed.principal.sessionVersion,
        },
        operationId: parsed.operationId,
        resource,
        target,
        targetHash,
        accessPathId: parsed.accessPathId,
        authorizationRevision: parsed.authorizationRevision,
        behaviorBindingHash: parsed.behaviorBindingHash,
        pathKind: 'direct' as const,
        effectiveTeamId: null,
        selectedPathCapabilities: ['host.read'] as const,
        behavior,
        validUntil: null,
      },
      behaviorBindingHash: parsed.behaviorBindingHash,
      operation: {} as never,
      preparedTarget: { target, targetHash },
    }
  }

  async function checkpoint(
    authorize: () => Promise<unknown>,
    resolveDestination: () => Promise<unknown>
  ) {
    const budget = AccessExecutionBudget.create('action')
    try {
      return await checkpointActionAuthority(
        {
          request: parsed,
          gateway: {} as never,
          budget,
          now: new Date('2026-08-18T12:00:00.000Z'),
        },
        { authorize: authorize as never, resolveDestination: resolveDestination as never }
      )
    } finally {
      budget.close()
    }
  }

  it('emits a strict allowed response with the required server-derived destination', async () => {
    const result = await checkpoint(
      async () => allowedAuthorization(),
      async () => ({
        status: 'resolved',
        destination: {
          kind: 'host',
          ref: resource.logicalId,
          url: 'http://chatllm.default.svc.cluster.local:8080',
        },
      })
    )

    expect(() => validateActionAuthorityCheckpointResponse(result)).not.toThrow()
    expect(result).toMatchObject({
      version: 2,
      status: 'allowed',
      destination: { kind: 'host', ref: resource.logicalId },
    })
  })

  it('fails closed without emitting an allowed envelope when destination resolution is unavailable', async () => {
    const result = await checkpoint(
      async () => allowedAuthorization(),
      async () => ({ status: 'unavailable' })
    )

    expect(result).toEqual({
      version: 2,
      status: 'authority_unavailable',
      code: 'authority_unavailable',
      retryable: true,
    })
    expect(() => validateActionAuthorityCheckpointResponse(result)).not.toThrow()
    expect(result).not.toHaveProperty('destination')
  })

  it('keeps non-allowed outcomes minimal and free of trusted behavior or destination facts', async () => {
    const result = await checkpoint(
      async () => ({ status: 'denied', code: 'forbidden' }),
      async () => {
        throw new Error('destination must not run')
      }
    )

    expect(result).toEqual({ version: 2, status: 'denied', code: 'forbidden' })
    expect(() => validateActionAuthorityCheckpointResponse(result)).not.toThrow()
    expect(result).not.toHaveProperty('behavior')
    expect(result).not.toHaveProperty('destination')
  })
})
