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
      const expectedGeneration = Number(
        metadata.annotations?.[ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION]
      )
      const targetRef = `${reference.namespace}/${reference.name}`
      if (!operationId || !UUID.test(operationId) || !Number.isSafeInteger(expectedGeneration))
        return null
      if (expectedGeneration < reference.generation) {
        // Every identity field above already matched, so the live object IS the
        // one the reporter observed, and its generation has moved past the one
        // the annotation pins. Generations only grow and nothing ever retires
        // the annotation, so this pair can never bind again: terminal, not
        // "unavailable right now".
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
      const outcome = safeOutcome(events[index]!.payload?.status)
      if (!outcome) return null
      return { reference, operationId, targetRef, outcome }
    })
    const intentInputs = candidates
      .filter(candidate => candidate !== null && !isBindingRefusal(candidate))
      .map(candidate => ({
        operationId: (candidate as Candidate).operationId,
        targetRef: (candidate as Candidate).targetRef,
        namespace: (candidate as Candidate).reference.namespace,
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

function safeOutcome(value: unknown): 'succeeded' | 'failed' | null {
  return value === 'succeeded' || value === 'failed' ? value : null
}
