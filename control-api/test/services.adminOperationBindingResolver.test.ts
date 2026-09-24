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
 * this same literal in its own test.
 *
 * The duplication is a convention, not an enforced contract. The two packages
 * cannot import each other, so nothing mechanically ties this literal to the
 * template that produces it: if the emitter gained a segment, only its own
 * test would fail, and this one would keep parsing the string below and stay
 * green. Drift surfaces in production instead, as the `$`-anchored STATUS_REF
 * refusing the new suffix -- a 403 with no `code`, which HCC classifies as
 * retryable, so the outcome is re-enqueued rather than lost. Change one side
 * and you must change this literal by hand.
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
    // `host(undefined, 7, 6)` — the annotation pinned BEHIND the live
    // generation — used to belong here. It is now a refusal, not a null, and
    // has its own block below (#329).
    ['an intent annotation ahead of the live generation', host(undefined, 7, 8), true],
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

  /**
   * #329 — the annotation is an obligation nothing ever retires, so once the
   * Host passes the generation it names, no future report can bind. That is a
   * different answer from "not yet visible", and the two must not collapse
   * into the same null.
   */
  describe('administrative intent generation drift (#329)', () => {
    it('refuses an annotation pinned behind the live generation, and counts it', async () => {
      const metrics = { inc: vi.fn() }
      const warn = vi.fn()
      const listResource = vi.fn().mockResolvedValue([host(undefined, 7, 6)])
      const findHostIntents = vi.fn().mockResolvedValue(intentMap())

      const result = await new HccAdministrativeOutcomeBindingResolver(
        { getResource: vi.fn(), listResource },
        { findHostIntent: vi.fn(), findHostIntents },
        { warn } as never,
        metrics
      ).resolve(principal, event)

      expect(result).toEqual({ refusal: 'administrative_intent_generation_drift' })
      // Liveness witnesses: the refusal is not the resolver skipping the
      // candidate loop. It read the Hosts, it reached the decision, and it
      // reported the decision.
      expect(listResource).toHaveBeenCalledWith('hosts', 'mcp-host')
      expect(metrics.inc).toHaveBeenCalledWith({ namespace: 'mcp-host' })
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'administrative_intent_generation_drift',
          namespace: 'mcp-host',
          liveGeneration: 7,
          annotatedGeneration: 6,
        }),
        expect.any(String)
      )
    })

    /**
     * The asymmetry is the whole point. `annotated < live` can never bind
     * again; `annotated > live` is the window between control-api predicting a
     * generation and the corrective patch landing, and it resolves on its own.
     * Both rows run through the SAME call, so a resolver that answered one way
     * for everything would fail.
     */
    it('separates a superseded annotation from one that is merely ahead', async () => {
      const metrics = { inc: vi.fn() }
      const behind = host(undefined, 7, 6)
      const ahead = host(undefined, 7, 9)
      ahead.metadata.name = 'chatllm-ahead'

      const resolver = new HccAdministrativeOutcomeBindingResolver(
        { getResource: vi.fn(), listResource: vi.fn().mockResolvedValue([behind, ahead]) },
        {
          findHostIntent: vi.fn(),
          findHostIntents: vi
            .fn()
            .mockResolvedValue(new Map([...intentMap(), ...intentMap(undefined, 'chatllm-ahead')])),
        },
        { warn: vi.fn() } as never,
        metrics
      )

      const [superseded, notYet] = await resolver.resolveMany(principal, [
        event,
        {
          ...event,
          sourceEventId: 'outcome-ahead',
          sourceStatusRef: `host:mcp-host/chatllm-ahead:generation=7:uid=${HOST_UID}`,
        },
      ])

      expect(superseded).toEqual({ refusal: 'administrative_intent_generation_drift' })
      expect(notYet).toBeNull()
      // Exactly one of the two was counted: the metric names the terminal case
      // only, so a dashboard built on it is not inflated by the transient one.
      expect(metrics.inc).toHaveBeenCalledTimes(1)
      expect(metrics.inc).toHaveBeenCalledWith({ namespace: 'mcp-host' })
    })

    /**
     * Identity is checked before drift. A same-name Host with a different uid
     * is not the object the reporter observed, so its annotation says nothing
     * about this event — answering "terminal drift" there would turn a #694
     * recreation into a permanently dropped outcome.
     */
    it('does not report drift when the uid does not match', async () => {
      const metrics = { inc: vi.fn() }
      const other = host(undefined, 7, 6, '00000000-0000-4000-8000-000000000000')
      other.metadata.name = 'chatllm-recreated'
      // The witness rides in the same call: a Host with a MATCHING uid whose
      // annotation is equally behind. `listResource` alone is not enough —
      // deleting the drift branch entirely leaves that spy just as satisfied,
      // and so does a STATUS_REF that never parsed. Only a refusal produced
      // beside the null proves the branch was armed in this arrangement.
      const drifted = host(undefined, 7, 6)
      const listResource = vi.fn().mockResolvedValue([other, drifted])

      const [recreated, superseded] = await new HccAdministrativeOutcomeBindingResolver(
        { getResource: vi.fn(), listResource },
        {
          findHostIntent: vi.fn(),
          findHostIntents: vi
            .fn()
            .mockResolvedValue(
              new Map([...intentMap(), ...intentMap(undefined, 'chatllm-recreated')])
            ),
        },
        { warn: vi.fn() } as never,
        metrics
      ).resolveMany(principal, [
        {
          ...event,
          sourceEventId: 'outcome-recreated',
          sourceStatusRef: `host:mcp-host/chatllm-recreated:generation=7:uid=${HOST_UID}`,
        },
        event,
      ])

      expect(superseded).toEqual({ refusal: 'administrative_intent_generation_drift' })
      expect(recreated).toBeNull()
      expect(listResource).toHaveBeenCalledWith('hosts', 'mcp-host')
      // One refusal counted, not two: identity is checked before drift, so a
      // #694 recreation is never named as a superseded operator action.
      expect(metrics.inc).toHaveBeenCalledTimes(1)
    })

    /**
     * A malformed annotation is malformed input, not drift, and the difference
     * is terminal-vs-retryable.
     *
     * `Number()` alone cannot make it: `Number('')`, `Number(' ')` and
     * `Number('\n')` are all `0`, which passes `Number.isSafeInteger` and is
     * strictly below every live generation. Each of those rows would therefore
     * be read as `annotated < live`, refused TERMINALLY, and counted by the
     * very metric that exists to separate the two — an operator action named as
     * superseded on the strength of an empty string.
     *
     * The liveness witness is structural rather than a spy: the genuinely
     * drifted Host rides in the SAME `resolveMany` call as the malformed rows.
     * Its refusal proves the drift branch executed during this call, so every
     * `null` beside it is a decision the resolver reached, not a path it never
     * entered. A resolver that skipped the candidate loop would lose the
     * refusal too and fail on the first assertion.
     */
    it('answers a malformed generation annotation retryably, never as drift', async () => {
      const malformed = ['', ' ', '\n', '0', '-1', '0x3', ' 3 ', '3e0', '+3', '007']
      const metrics = { inc: vi.fn() }

      const hosts = malformed.map((raw, index) => {
        const entry = host(undefined, 7, 7)
        entry.metadata.name = `chatllm-${index}`
        entry.metadata.annotations['clerum.io/administrative-intent-generation'] = raw
        return entry
      })
      const drifted = host(undefined, 7, 6)

      const resolver = new HccAdministrativeOutcomeBindingResolver(
        {
          getResource: vi.fn(),
          listResource: vi.fn().mockResolvedValue([...hosts, drifted]),
        },
        {
          findHostIntent: vi.fn(),
          findHostIntents: vi
            .fn()
            .mockResolvedValue(
              new Map([
                ...intentMap(),
                ...malformed.flatMap((_, index) => [...intentMap(undefined, `chatllm-${index}`)]),
              ])
            ),
        },
        { warn: vi.fn() } as never,
        metrics
      )

      const results = await resolver.resolveMany(principal, [
        ...malformed.map((_, index) => ({
          ...event,
          sourceEventId: `outcome-${index}`,
          sourceStatusRef: `host:mcp-host/chatllm-${index}:generation=7:uid=${HOST_UID}`,
        })),
        { ...event, sourceEventId: 'outcome-drifted' },
      ])

      // The witness first: the drift path ran in this call.
      expect(results[malformed.length]).toEqual({
        refusal: 'administrative_intent_generation_drift',
      })
      expect(results.slice(0, malformed.length)).toEqual(malformed.map(() => null))
      // Exactly one refusal was counted — the real one. Every malformed row
      // stayed out of the metric, which is what makes the metric readable.
      expect(metrics.inc).toHaveBeenCalledTimes(1)
    })

    /**
     * The companion to the row above: a well-formed annotation equal to the
     * live generation still binds. Without this, tightening the parser until it
     * rejected everything would leave the suite green.
     */
    it('still binds a well-formed annotation that equals the live generation', async () => {
      const result = await new HccAdministrativeOutcomeBindingResolver(
        { getResource: vi.fn(), listResource: vi.fn().mockResolvedValue([host(undefined, 7, 7)]) },
        { findHostIntent: vi.fn(), findHostIntents: vi.fn().mockResolvedValue(intentMap()) },
        { warn: vi.fn() } as never,
        { inc: vi.fn() }
      ).resolve(principal, event)

      expect(result).toMatchObject({ action: 'host_mutation', operationId: OPERATION_ID })
    })

    /**
     * Ordering, not just classification. An event whose own payload cannot be
     * read is malformed INPUT; classifying the object's annotation first would
     * answer it with the drift code and count it, mis-naming a request the
     * caller built wrong as an operator action that was superseded.
     *
     * The Host here is genuinely drifted, so a resolver that classified the
     * object before the event would return the refusal and fail.
     */
    it('classifies an unreadable payload before it classifies the annotation', async () => {
      const metrics = { inc: vi.fn() }
      const listResource = vi.fn().mockResolvedValue([host(undefined, 7, 6)])

      const result = await new HccAdministrativeOutcomeBindingResolver(
        { getResource: vi.fn(), listResource },
        { findHostIntent: vi.fn(), findHostIntents: vi.fn().mockResolvedValue(intentMap()) },
        { warn: vi.fn() } as never,
        metrics
      ).resolve(principal, { ...event, payload: { resource_class: 'Host', status: 'pending' } })

      expect(result).toBeNull()
      expect(listResource).toHaveBeenCalledWith('hosts', 'mcp-host')
      expect(metrics.inc).not.toHaveBeenCalled()
    })
  })
})
