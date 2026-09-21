import { describe, expect, it, vi } from 'vitest'
import { HccAdministrativeOutcomeBindingResolver } from '../src/services/tracing/adminOperationBindingResolver.js'

const principal = {
  kind: 'hcc_internal_control',
  sourceService: 'host-context-controller',
  serviceSub: 'hcc-provisioner',
  credentialId: 'hcc-1',
  allowedKinds: ['linked_outcome'],
} as const

/**
 * Cross-service format contract (#694). `STATUS_REF_FROM_HCC` is the exact
 * string host-context-controller emits
 * (host-context-controller/src/administrativeOutcomeReporter.ts), which pins
 * this same literal in its own test. The two packages cannot import each
 * other, so change one side and the other side's test fails.
 */
const HOST_UID = '6f1c2f3a-2f4b-4d3a-9b2e-7c0d1a5e8b44'
const STATUS_REF_FROM_HCC = `host:mcp-host/chatllm:generation=7:uid=${HOST_UID}`

const event = {
  kind: 'linked_outcome' as const,
  sourceEventId: 'outcome-1',
  occurredAt: '2026-07-11T10:00:00.000Z',
  sourceStatusRef: STATUS_REF_FROM_HCC,
  payload: { resource_class: 'Host', status: 'succeeded' },
}

const intentAttribution = {
  operatorSub: 'admin-1',
  requestId: 'request-1',
  environment: 'test',
  tenantId: null,
  teamId: null,
  identityIssuer: 'control-api',
  operatorUserId: '22222222-2222-4222-8222-222222222222',
  resourceAud: 'control-ui',
  effectiveScopes: [],
  tokenExchangeId: null,
  authorizationDecision: 'allow' as const,
  decisionActorSub: 'control-api',
}

function host(
  operationId = '11111111-1111-4111-8111-111111111111',
  generation = 7,
  intentGeneration = generation,
  uid = HOST_UID
) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'Host',
    metadata: {
      name: 'chatllm',
      namespace: 'mcp-host',
      generation,
      uid,
      annotations: {
        'clerum.io/administrative-intent-id': operationId,
        'clerum.io/administrative-intent-generation': String(intentGeneration),
      },
    },
  }
}

describe('HccAdministrativeOutcomeBindingResolver', () => {
  it('binds a terminal outcome only after live Host and durable intent validation', async () => {
    const listResource = vi.fn().mockResolvedValue([host()])
    const intent = intentAttribution
    const findHostIntents = vi
      .fn()
      .mockResolvedValue(
        new Map([['11111111-1111-4111-8111-111111111111:mcp-host:mcp-host/chatllm', intent]])
      )
    const binding = await new HccAdministrativeOutcomeBindingResolver(
      { getResource: vi.fn(), listResource },
      { findHostIntent: vi.fn(), findHostIntents }
    ).resolve(principal, event)
    expect(binding).toMatchObject({
      operationId: '11111111-1111-4111-8111-111111111111',
      operatorSub: 'admin-1',
      requestId: 'request-1',
      targetRef: 'mcp-host/chatllm',
      outcome: 'succeeded',
      identityIssuer: 'control-api',
      operatorUserId: '22222222-2222-4222-8222-222222222222',
      resourceAud: 'control-ui',
      authorizationDecision: 'allow',
      decisionActorSub: 'control-api',
    })
    expect(findHostIntents).toHaveBeenCalledWith([
      expect.objectContaining({
        targetRef: 'mcp-host/chatllm',
        namespace: 'mcp-host',
      }),
    ])
  })

  it.each([
    ['stale generation', host(undefined, 8), true],
    ['stale intent annotation', host(undefined, 7, 6), true],
    ['invalid annotation', host('caller-value'), true],
    ['missing intent', host(), false],
    // A Host deleted and recreated under the same name reaches the same
    // generation and carries the same intent annotation; only the uid differs
    // (#694).
    ['a same-name Host with another uid', host(undefined, 7, 7, 'another-host-uid'), true],
  ] as const)('rejects %s', async (_label, resource, hasIntent) => {
    const resolver = new HccAdministrativeOutcomeBindingResolver(
      { getResource: vi.fn(), listResource: vi.fn().mockResolvedValue([resource]) },
      {
        findHostIntent: vi.fn(),
        findHostIntents: vi
          .fn()
          .mockResolvedValue(
            hasIntent
              ? new Map([
                  [
                    '11111111-1111-4111-8111-111111111111:mcp-host:mcp-host/chatllm',
                    { ...intentAttribution, requestId: null },
                  ],
                ])
              : new Map()
          ),
      }
    )
    await expect(resolver.resolve(principal, event)).resolves.toBeNull()
  })

  it('refuses a sourceStatusRef without the uid suffix (#694)', async () => {
    const resolver = new HccAdministrativeOutcomeBindingResolver(
      { getResource: vi.fn(), listResource: vi.fn().mockResolvedValue([host()]) },
      {
        findHostIntent: vi.fn(),
        findHostIntents: vi
          .fn()
          .mockResolvedValue(
            new Map([
              ['11111111-1111-4111-8111-111111111111:mcp-host:mcp-host/chatllm', intentAttribution],
            ])
          ),
      }
    )

    // Batched with the current format so the null below cannot come from a
    // resolver that refuses everything: the same call binds the other event.
    const [legacy, current] = await resolver.resolveMany(principal, [
      {
        ...event,
        sourceEventId: 'outcome-legacy',
        sourceStatusRef: 'host:mcp-host/chatllm:generation=7',
      },
      event,
    ])

    expect(legacy).toBeNull()
    expect(current).toMatchObject({ targetRef: 'mcp-host/chatllm', outcome: 'succeeded' })
  })
})
