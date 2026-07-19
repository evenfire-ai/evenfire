import type { InfrastructureTelemetrySubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
import type {
  InfrastructureTelemetryEventInputV1,
  InfrastructureTelemetryServerBindingV1,
} from './contracts.js'
import { canonicalTracingClusterName, canonicalTracingEnvironment } from './environment.js'
import type { InfrastructureWorkloadBindingResolver } from './routeSubmissionService.js'

export const HCC_HEALTH_TRANSITION_BINDING_BLOCKER =
  'hcc_telemetry_requires_server_verifiable_host_reference'

const HCC_HOST_TELEMETRY_TYPES = [
  'health_transition',
  'lifecycle_transition',
  'reconcile_outcome',
  'controller_error',
] as const

export interface AuthoritativeHostLookup {
  getResource(plural: 'hosts', name: string, namespace: string): Promise<unknown>
}

type AuthoritativeHost = {
  apiVersion?: string
  kind?: string
  metadata?: { name?: string; namespace?: string; uid?: string; generation?: number }
}

/**
 * HCC's InternalControl credential authenticates the controller, while the
 * authoritative Host read below binds each accepted report to a real resource
 * and exact observed generation. Capacity and usage remain fail-closed because
 * they require a separate inventory or metrics authority.
 */
export class HccHealthTransitionBindingUnavailableError extends Error {
  readonly code = HCC_HEALTH_TRANSITION_BINDING_BLOCKER
  readonly status = 403
  readonly statusCode = 403

  constructor() {
    super('HCC telemetry rejected: no server-verifiable Host reference exists.')
    this.name = 'HccHealthTransitionBindingUnavailableError'
  }
}

export class HccHealthTransitionBindingResolver implements InfrastructureWorkloadBindingResolver {
  constructor(
    private readonly hostLookup: AuthoritativeHostLookup,
    private readonly environment = canonicalTracingEnvironment(),
    private readonly clusterName = canonicalTracingClusterName()
  ) {}

  async resolve(
    principal: InfrastructureTelemetrySubmitterPrincipalV1,
    event: InfrastructureTelemetryEventInputV1
  ): Promise<InfrastructureTelemetryServerBindingV1 | null> {
    if (
      principal.kind !== 'hcc_internal_control' ||
      !HCC_HOST_TELEMETRY_TYPES.includes(
        event.telemetryType as (typeof HCC_HOST_TELEMETRY_TYPES)[number]
      )
    ) {
      return null
    }

    const reference = event.hostLookupReference
    if (
      !reference ||
      !isDnsLabel(reference.name) ||
      !isDnsLabel(reference.namespace) ||
      (reference.generation !== undefined &&
        (!Number.isSafeInteger(reference.generation) || reference.generation < 1))
    ) {
      throw new HccHealthTransitionBindingUnavailableError()
    }

    let host: AuthoritativeHost
    try {
      host = (await this.hostLookup.getResource(
        'hosts',
        reference.name,
        reference.namespace
      )) as AuthoritativeHost
    } catch {
      return null
    }
    const metadata = host.metadata
    if (
      host.apiVersion !== 'clerum.io/v1alpha1' ||
      host.kind !== 'Host' ||
      metadata?.name !== reference.name ||
      metadata.namespace !== reference.namespace ||
      (reference.generation !== undefined && metadata.generation !== reference.generation)
    ) {
      return null
    }

    const outcome = hccOutcome(event)
    if (outcome === null) return null

    return {
      triggerKind: 'controller_reconcile',
      outcome,
      reasonCode: event.payload?.reason_code ?? null,
      environment: this.environment,
      clusterName: this.clusterName,
      namespace: metadata.namespace,
      workloadKind: 'Host',
      workloadRef: `${metadata.namespace}/${metadata.name}`,
      kubernetesKind: 'Host',
      kubernetesName: metadata.name,
      kubernetesUid: metadata.uid ?? null,
      metadataGeneration: metadata.generation ?? null,
      relatedOperationId: null,
      relatedRunId: null,
    }
  }
}

function hccOutcome(event: InfrastructureTelemetryEventInputV1): string | null {
  const reportedStatus = event.payload?.status
  if (event.telemetryType === 'controller_error') {
    return reportedStatus === undefined || reportedStatus === 'failed' ? 'failed' : null
  }
  if (event.telemetryType === 'reconcile_outcome') {
    return reportedStatus === 'succeeded' || reportedStatus === 'failed' ? reportedStatus : null
  }
  return 'unknown'
}

function isDnsLabel(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) && value.length <= 63
}
