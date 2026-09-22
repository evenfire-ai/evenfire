import type { AdministrativeEventSubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
import { type Logger, rootLogger } from '../../observability/logger.js'
import { governedTraceAdministrativeIntentDriftTotal } from '../../observability/metrics.js'
import {
  ADMINISTRATIVE_INTENT_ANNOTATION,
  ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION,
} from './adminOperationConstants.js'
import {
  type AdministrativeIntentLookup,
  administrativeIntentLookupKey,
} from './adminOperationService.js'
import type { AdministrativeEventInputV1, AdministrativeServerBindingV1 } from './contracts.js'
import {
  type AdministrativeOperationBindingResolver,
  type BindingRefusal,
  isBindingRefusal,
} from './routeSubmissionService.js'

export interface HostAdministrativeLookup {
  getResource(plural: 'hosts', name: string, namespace: string): Promise<unknown>
  listResource(plural: 'hosts', namespace: string): Promise<unknown[]>
}

type HostResource = {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    generation?: number
    uid?: string
    annotations?: Record<string, string>
  }
}

/**
 * `host:<ns>/<name>:generation=<n>:uid=<uuid>`. The uid is required: a Host
 * deleted and recreated under the same name restarts at generation 1, so
 * namespace/name/generation alone can name two different objects (#694). The
 * emitter is host-context-controller/src/administrativeOutcomeReporter.ts,
 * which builds this literal; the two live in different packages and cannot
 * import each other, so each side pins the same example string in its tests.
 *
 * The uid is matched in lowercase hex only, which is what the API server emits
 * and what the reporter copies verbatim. An uppercase spelling of the same uid
 * would parse and then fail the case-sensitive comparison below, so accepting
 * it would only move the refusal later; keeping the format exact says what the
 * one valid spelling is.
 */
const STATUS_REF =
  /^host:([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/([a-z0-9]([-a-z0-9]*[a-z0-9])?):generation=([1-9][0-9]*):uid=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * A generation annotation is a decimal integer >= 1, spelled the way the
 * apiserver spells `metadata.generation` — the same shape `STATUS_REF` above
 * requires of the wire value it is compared against.
 *
 * `Number()` is not usable here. `Number('')`, `Number(' ')` and `Number('\n')`
 * are all `0`, which passes `Number.isSafeInteger` and is strictly below every
 * live generation, so an empty or whitespace-only annotation would be
 * classified as DRIFT and refused TERMINALLY: an operator action named as
 * superseded when the annotation is merely malformed, counted by the very
 * metric that exists to tell those two apart. `'0'` and any negative spelling
 * are rejected for the same reason — generations start at 1, so neither can be
 * a generation control-api ever wrote. `'0x3'`, `' 3 '` and `'3e0'` are
 * rejected because a value this key's sole writer never produces is evidence of
 * tampering, not of drift.
 *
 * Unparseable therefore means "no usable annotation", which is the retryable
 * `null`, never a terminal refusal.
 */
const GENERATION_ANNOTATION = /^[1-9][0-9]*$/

const DRIFT_REFUSAL: BindingRefusal = { refusal: 'administrative_intent_generation_drift' }

type Candidate = {
  reference: { namespace: string; name: string; generation: number; uid: string }
  operationId: string
  targetRef: string
  outcome: 'succeeded' | 'failed'
}

/** The one counter method this resolver uses, so a test can pass a fake. */
export type DriftCounter = { inc(labels: { namespace: string }): void }

export class HccAdministrativeOutcomeBindingResolver implements AdministrativeOperationBindingResolver {
  private readonly logger: Logger
  private readonly metrics: DriftCounter

  constructor(
    private readonly hostLookup: HostAdministrativeLookup,
    private readonly intentLookup: AdministrativeIntentLookup,
    logger: Logger = rootLogger,
    metrics: DriftCounter = governedTraceAdministrativeIntentDriftTotal
  ) {
    this.logger = logger
    this.metrics = metrics
  }

  async resolve(
    principal: AdministrativeEventSubmitterPrincipalV1,
    event: AdministrativeEventInputV1
  ): Promise<AdministrativeServerBindingV1 | BindingRefusal | null> {
    return (await this.resolveMany(principal, [event]))[0] ?? null
  }

  async resolveMany(
    principal: AdministrativeEventSubmitterPrincipalV1,
    events: readonly AdministrativeEventInputV1[]
  ): Promise<readonly (AdministrativeServerBindingV1 | BindingRefusal | null)[]> {
    if (principal.kind !== 'hcc_internal_control') {
      return events.map(() => null)
    }
    const parsed = events.map(event =>
      event.kind === 'linked_outcome' ? parseHostStatusRef(event.sourceStatusRef) : null
    )
    const namespaces = [...new Set(parsed.filter(Boolean).map(item => item!.namespace))]
    const listed = await Promise.all(
      namespaces.map(async namespace => {
        try {
          return [namespace, await this.hostLookup.listResource('hosts', namespace)] as const
        } catch {
          return [namespace, []] as const
        }
      })
    )
    const hosts = new Map<string, HostResource>()
    for (const [namespace, resources] of listed) {
      for (const resource of resources as HostResource[]) {
        const name = resource.metadata?.name
        if (name) hosts.set(`${namespace}/${name}`, resource)
      }
    }
    const candidates = parsed.map((reference, index) => {
      if (!reference) return null
      const host = hosts.get(`${reference.namespace}/${reference.name}`)
      const metadata = host?.metadata
      if (
        host?.apiVersion !== 'clerum.io/v1alpha1' ||
        host.kind !== 'Host' ||
        metadata?.name !== reference.name ||
        metadata.namespace !== reference.namespace ||
        metadata.generation !== reference.generation ||
        // The live object must be the one the reporter observed, not a
        // same-name successor that reached the same generation (#694).
        metadata.uid !== reference.uid
      )
        return null
      const operationId = metadata.annotations?.[ADMINISTRATIVE_INTENT_ANNOTATION]
      const expectedGeneration = parseGenerationAnnotation(
        metadata.annotations?.[ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION]
      )
      const targetRef = `${reference.namespace}/${reference.name}`
      if (!operationId || !UUID.test(operationId) || expectedGeneration === null) return null
      // Classify the event by its own defect BEFORE classifying the object's.
      // An event whose payload cannot be read is malformed input, not evidence
      // that the annotation drifted, and answering it with the drift code would
      // both mis-name it and count it in the drift metric. This keeps the
      // pre-#329 answer (retryable) for a payload the caller built wrong.
      const outcome = safeOutcome(events[index]!.payload?.status)
      if (!outcome) return null
      if (expectedGeneration < reference.generation) {
        // Every identity field above already matched, so the live object IS the
        // one the reporter observed, and its generation has moved past the one
        // the annotation pins. The pair can never bind again: the live
        // generation only grows, and NOTHING EVER RAISES THE ANNOTATION to
        // catch up with it. `reconcileAdministrativeIntentGeneration` only ever
        // lowers a prediction to the generation the write actually produced —
        // every replace carries a `resourceVersion` precondition
        // (`resourceService.ts:404`, `:795`), so the persisted generation can
        // never exceed the predicted one — and no other writer owns this key.
        // Terminal, not "unavailable right now".
        this.metrics.inc({ namespace: reference.namespace })
        // The Host name goes to the log, never to the metric label: names are
        // unbounded and a label carrying one grows the series count with the
        // cluster. The operationId is omitted from both.
        this.logger.warn(
          {
            event: 'administrative_intent_generation_drift',
            namespace: reference.namespace,
            name: reference.name,
            liveGeneration: reference.generation,
            annotatedGeneration: expectedGeneration,
          },
          'administrative intent annotation is pinned to a superseded generation'
        )
        return DRIFT_REFUSAL
      }
      // `expectedGeneration > reference.generation` stays retryable: that is the
      // window between control-api predicting a generation and the corrective
      // annotation patch landing, and it resolves on its own.
      if (expectedGeneration !== reference.generation) return null
      return { reference, operationId, targetRef, outcome }
    })
    const intentInputs = candidates
      .filter(
        (candidate): candidate is Candidate => candidate !== null && !isBindingRefusal(candidate)
      )
      .map(candidate => ({
        operationId: candidate.operationId,
        targetRef: candidate.targetRef,
        namespace: candidate.reference.namespace,
      }))
    const intents = await this.intentLookup.findHostIntents(intentInputs)
    return candidates.map(candidate => {
      if (!candidate) return null
      if (isBindingRefusal(candidate)) return candidate
      const intentInput = {
        operationId: candidate.operationId,
        targetRef: candidate.targetRef,
        namespace: candidate.reference.namespace,
      }
      const intent = intents.get(administrativeIntentLookupKey(intentInput))
      if (!intent) return null
      return {
        action: 'host_mutation',
        outcome: candidate.outcome,
        operatorSub: intent.operatorSub,
        operationId: candidate.operationId,
        relatedRunId: null,
        requestId: intent.requestId,
        targetType: 'host',
        targetRef: candidate.targetRef,
        environment: intent.environment,
        tenantId: intent.tenantId,
        teamId: intent.teamId,
        namespace: candidate.reference.namespace,
        sourceAuditRef: null,
        identityIssuer: intent.identityIssuer,
        operatorUserId: intent.operatorUserId,
        resourceAud: intent.resourceAud,
        effectiveScopes: intent.effectiveScopes,
        tokenExchangeId: intent.tokenExchangeId,
        authorizationDecision: intent.authorizationDecision,
        decisionActorSub: intent.decisionActorSub,
      }
    })
  }
}

function parseHostStatusRef(value: string | undefined): {
  namespace: string
  name: string
  generation: number
  uid: string
} | null {
  if (!value) return null
  const match = STATUS_REF.exec(value)
  if (!match) return null
  return {
    namespace: match[1]!,
    name: match[3]!,
    generation: Number(match[5]),
    uid: match[6]!,
  }
}

/** See `GENERATION_ANNOTATION` for why `Number()` alone is not usable here. */
function parseGenerationAnnotation(raw: string | undefined): number | null {
  if (raw === undefined || !GENERATION_ANNOTATION.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function safeOutcome(value: unknown): 'succeeded' | 'failed' | null {
  return value === 'succeeded' || value === 'failed' ? value : null
}
