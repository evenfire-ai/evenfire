import type { AdministrativeEventSubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
import {
  ADMINISTRATIVE_INTENT_ANNOTATION,
  ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION,
} from './adminOperationConstants.js'
import {
  type AdministrativeIntentLookup,
  administrativeIntentLookupKey,
} from './adminOperationService.js'
import type { AdministrativeEventInputV1, AdministrativeServerBindingV1 } from './contracts.js'
import type { AdministrativeOperationBindingResolver } from './routeSubmissionService.js'

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
    annotations?: Record<string, string>
  }
}

const STATUS_REF =
  /^host:([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/([a-z0-9]([-a-z0-9]*[a-z0-9])?):generation=([1-9][0-9]*)$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class HccAdministrativeOutcomeBindingResolver implements AdministrativeOperationBindingResolver {
  constructor(
    private readonly hostLookup: HostAdministrativeLookup,
    private readonly intentLookup: AdministrativeIntentLookup
  ) {}

  async resolve(
    principal: AdministrativeEventSubmitterPrincipalV1,
    event: AdministrativeEventInputV1
  ): Promise<AdministrativeServerBindingV1 | null> {
    return (await this.resolveMany(principal, [event]))[0] ?? null
  }

  async resolveMany(
    principal: AdministrativeEventSubmitterPrincipalV1,
    events: readonly AdministrativeEventInputV1[]
  ): Promise<readonly (AdministrativeServerBindingV1 | null)[]> {
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
        metadata.generation !== reference.generation
      )
        return null
      const operationId = metadata.annotations?.[ADMINISTRATIVE_INTENT_ANNOTATION]
      const expectedGeneration = Number(
        metadata.annotations?.[ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION]
      )
      const targetRef = `${reference.namespace}/${reference.name}`
      if (
        !operationId ||
        !UUID.test(operationId) ||
        !Number.isSafeInteger(expectedGeneration) ||
        expectedGeneration !== reference.generation
      )
        return null
      const outcome = safeOutcome(events[index]!.payload?.status)
      if (!outcome) return null
      return { reference, operationId, targetRef, outcome }
    })
    const intentInputs = candidates.filter(Boolean).map(candidate => ({
      operationId: candidate!.operationId,
      targetRef: candidate!.targetRef,
      namespace: candidate!.reference.namespace,
    }))
    const intents = await this.intentLookup.findHostIntents(intentInputs)
    return candidates.map(candidate => {
      if (!candidate) return null
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
} | null {
  if (!value) return null
  const match = STATUS_REF.exec(value)
  if (!match) return null
  return {
    namespace: match[1]!,
    name: match[3]!,
    generation: Number(match[5]),
  }
}

function safeOutcome(value: unknown): 'succeeded' | 'failed' | null {
  return value === 'succeeded' || value === 'failed' ? value : null
}
