import { describe, expect, it, vi } from 'vitest'
import { HccAdministrativeOutcomeBindingResolver } from '../src/services/tracing/adminOperationBindingResolver.js'
import { administrativeIntentLookupKey } from '../src/services/tracing/adminOperationService.js'

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
  requestId: 'request-1' as string | null,
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

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'

/**
 * Built with the implementation's own key function rather than a literal. A
 * hardcoded key that stopped matching would turn every `toBeNull()` row below
 * into a test that passes for the wrong reason, since a missing intent also
 * refuses the binding.
 */
function intentMap(attribution = intentAttribution, name = 'chatllm') {
  return new Map([
    [
      administrativeIntentLookupKey({
        operationId: OPERATION_ID,
        targetRef: `mcp-host/${name}`,
        namespace: 'mcp-host',
      }),
      attribution,
    ],
  ])
}

function host(
  operationId = OPERATION_ID,
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
    const findHostIntents = vi.fn().mockResolvedValue(intentMap())
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
            hasIntent ? intentMap({ ...intentAttribution, requestId: null }) : new Map()
          ),
      }
    )
    await expect(resolver.resolve(principal, event)).resolves.toBeNull()
  })

  it('refuses a sourceStatusRef without the uid suffix (#694)', async () => {
    const resolver = new HccAdministrativeOutcomeBindingResolver(
      { getResource: vi.fn(), listResource: vi.fn().mockResolvedValue([host()]) },
      { findHostIntent: vi.fn(), findHostIntents: vi.fn().mockResolvedValue(intentMap()) }
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

  /**
   * The test above cannot tell the format contract from the uid comparison: a
   * reference the regex rejected and one whose uid does not match the live
   * object both end as null. These rows separate them. Each malformed spelling
   * is paired with a live Host carrying that exact string as its uid, so the
   * comparison would accept it — only `STATUS_REF` refuses, and relaxing the
   * pattern makes the row bind.
   */
  it.each([
    ['a uid that is not a uuid', 'not-a-uuid'],
    ['an uppercase uid', HOST_UID.toUpperCase()],
    ['a uid with trailing text', `${HOST_UID}-extra`],
  ] as const)('refuses %s in the sourceStatusRef (#694)', async (_label, uid) => {
    // `chatllm` carries the malformed spelling as its real uid, so the
    // comparison would accept it; `chatllm-live` is the witness that binds
    // through the same call.
    const malformedHost = host(undefined, 7, 7, uid)
    const liveHost = host()
    liveHost.metadata.name = 'chatllm-live'
    const resolver = new HccAdministrativeOutcomeBindingResolver(
      {
        getResource: vi.fn(),
        listResource: vi.fn().mockResolvedValue([malformedHost, liveHost]),
      },
      {
        findHostIntent: vi.fn(),
        findHostIntents: vi
          .fn()
          .mockResolvedValue(new Map([...intentMap(), ...intentMap(undefined, 'chatllm-live')])),
      }
    )

    const [malformed, witness] = await resolver.resolveMany(principal, [
      {
        ...event,
        sourceEventId: 'outcome-malformed-uid',
        sourceStatusRef: `host:mcp-host/chatllm:generation=7:uid=${uid}`,
      },
      {
        ...event,
        sourceEventId: 'outcome-live',
        sourceStatusRef: `host:mcp-host/chatllm-live:generation=7:uid=${HOST_UID}`,
      },
    ])

    expect(malformed).toBeNull()
    expect(witness).toMatchObject({ targetRef: 'mcp-host/chatllm-live', outcome: 'succeeded' })
  })
})
