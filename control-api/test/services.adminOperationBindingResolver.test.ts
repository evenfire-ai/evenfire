import { describe, expect, it, vi } from 'vitest'
import { HccAdministrativeOutcomeBindingResolver } from '../src/services/tracing/adminOperationBindingResolver.js'

const principal = {
  kind: 'hcc_internal_control',
  sourceService: 'host-context-controller',
  serviceSub: 'hcc-provisioner',
  credentialId: 'hcc-1',
  allowedKinds: ['linked_outcome'],
} as const

const event = {
  kind: 'linked_outcome' as const,
  sourceEventId: 'outcome-1',
  occurredAt: '2026-07-11T10:00:00.000Z',
  sourceStatusRef: 'host:mcp-host/chatllm:generation=7',
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
  intentGeneration = generation
) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'Host',
    metadata: {
      name: 'chatllm',
      namespace: 'mcp-host',
      generation,
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
})
