import type { DbClient } from '../../db.js'
import type { InfrastructureTelemetrySubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
import {
  type PendingGovernedEvent,
  appendGovernedEventBatchInTransaction,
  appendGovernedEventInTransaction,
  assertNoClientAuthority,
  assertSafeEventPayload,
  canonicalPayloadSha256,
  normalizeIsoTimestamp,
  resolveServiceDependencies,
} from './append.js'
import type {
  GovernedAppendResult,
  InfrastructureTelemetryEventInputV1,
  InfrastructureTelemetryServerBindingV1,
  PendingInfrastructureTelemetryEventEnvelopeV1,
  TracingServiceDependencies,
} from './contracts.js'

const INTERVAL_TYPES = new Set(['capacity_sample', 'usage_sample'])
const HCC_MANAGED_RESOURCE_KINDS = new Set(['Host', 'Context', 'McpServer'])

export type TraceMaintenanceInfrastructurePrincipal = {
  kind: 'trace_maintenance'
  sourceService: 'control-api'
  serviceSub: 'trace-maintenance-worker'
  credentialId: 'in-process'
  resourceAuthority: 'control_plane_inventory'
  allowedTelemetryTypes: readonly ['capacity_sample']
}

type InfrastructurePrincipal =
  | InfrastructureTelemetrySubmitterPrincipalV1
  | TraceMaintenanceInfrastructurePrincipal

export class InfrastructurePrincipalBindingInvariantError extends Error {
  readonly code = 'infrastructure_principal_binding_invariant'

  constructor(message: string) {
    super(message)
    this.name = 'InfrastructurePrincipalBindingInvariantError'
  }
}

function assertPrincipalBinding(
  principal: InfrastructurePrincipal,
  binding: InfrastructureTelemetryServerBindingV1
): void {
  if (principal.kind === 'hcc_internal_control') {
    if (
      principal.resourceAuthority !== 'hcc_managed' ||
      !HCC_MANAGED_RESOURCE_KINDS.has(binding.kubernetesKind)
    ) {
      throw new InfrastructurePrincipalBindingInvariantError(
        'hcc_internal_control telemetry must bind an HCC-managed resource kind'
      )
    }
    return
  }

  if (principal.kind === 'trace_maintenance') {
    if (
      principal.resourceAuthority !== 'control_plane_inventory' ||
      binding.kubernetesKind !== 'Deployment'
    ) {
      throw new InfrastructurePrincipalBindingInvariantError(
        'trace maintenance telemetry must bind an allowlisted control-plane Deployment'
      )
    }
    return
  }

  if (
    principal.resourceAuthority !== 'wrc_managed' ||
    binding.kubernetesKind !== 'WorkflowRecipe'
  ) {
    throw new InfrastructurePrincipalBindingInvariantError(
      'wrc_internal_control telemetry must bind the WRC-managed WorkflowRecipe kind'
    )
  }
}

export class InfrastructureTelemetryEventService {
  private readonly dependencies: Required<TracingServiceDependencies>

  constructor(dependencies: TracingServiceDependencies) {
    this.dependencies = resolveServiceDependencies(dependencies)
  }

  async append(
    principal: InfrastructurePrincipal,
    binding: InfrastructureTelemetryServerBindingV1,
    input: InfrastructureTelemetryEventInputV1
  ): Promise<GovernedAppendResult> {
    const event = this.normalize(principal, binding, input)
    return this.dependencies.transaction(db => appendGovernedEventInTransaction(db, event))
  }

  async appendInTransaction(
    db: DbClient,
    principal: InfrastructurePrincipal,
    binding: InfrastructureTelemetryServerBindingV1,
    input: InfrastructureTelemetryEventInputV1
  ): Promise<GovernedAppendResult> {
    return appendGovernedEventInTransaction(db, this.normalize(principal, binding, input))
  }

  async appendManyInTransaction(
    db: DbClient,
    principal: InfrastructurePrincipal,
    entries: readonly {
      binding: InfrastructureTelemetryServerBindingV1
      input: InfrastructureTelemetryEventInputV1
    }[]
  ): Promise<GovernedAppendResult[]> {
    if (entries.length === 0) return []
    return appendGovernedEventBatchInTransaction(
      db,
      entries.map(({ binding, input }) => this.normalize(principal, binding, input)) as [
        PendingGovernedEvent<'infrastructure_telemetry'>,
        ...PendingGovernedEvent<'infrastructure_telemetry'>[],
      ]
    )
  }

  private normalize(
    principal: InfrastructurePrincipal,
    binding: InfrastructureTelemetryServerBindingV1,
    input: InfrastructureTelemetryEventInputV1
  ): PendingGovernedEvent {
    const submittedEvidence = { ...input } as Record<string, unknown>
    delete submittedEvidence.hostLookupReference
    delete submittedEvidence.workflowRunLookupReference
    assertNoClientAuthority(submittedEvidence)
    assertSafeEventPayload(input.payload)
    assertPrincipalBinding(principal, binding)
    if (!(principal.allowedTelemetryTypes as readonly string[]).includes(input.telemetryType)) {
      throw new Error(`${principal.kind} cannot submit telemetry type ${input.telemetryType}`)
    }
    if (INTERVAL_TYPES.has(input.telemetryType) && (!input.intervalStart || !input.intervalEnd)) {
      throw new Error(`${input.telemetryType} requires a bounded interval`)
    }
    const numericEvidence = [
      input.desiredReplicas,
      input.observedReplicas,
      input.readyReplicas,
      input.cpuRequestCores,
      input.cpuLimitCores,
      input.memoryRequestBytes,
      input.memoryLimitBytes,
      input.cpuUsageCoreSeconds,
      input.memoryUsageByteSeconds,
    ]
    if (
      numericEvidence.some(value => value !== undefined && (!Number.isFinite(value) || value < 0))
    ) {
      throw new Error('infrastructure quantities must be finite non-negative numbers')
    }

    const occurredAtIso = normalizeIsoTimestamp(input.occurredAt, 'occurredAt')
    const intervalStart = input.intervalStart
      ? normalizeIsoTimestamp(input.intervalStart, 'intervalStart')
      : null
    const intervalEnd = input.intervalEnd
      ? normalizeIsoTimestamp(input.intervalEnd, 'intervalEnd')
      : null
    if (intervalStart && intervalEnd && intervalStart >= intervalEnd) {
      throw new Error('infrastructure intervalStart must precede intervalEnd')
    }
    const ingestedAt = this.dependencies.now().toISOString()
    const payload = input.payload ?? {}
    const canonical = {
      family: 'infrastructure_telemetry',
      sourceService: principal.sourceService,
      serviceSub: principal.serviceSub,
      sourceKind: principal.kind,
      sourceEventId: input.sourceEventId,
      // Reconcile outcomes are state facts coalesced by their deterministic
      // source identity. Preserve the first observation time in storage while
      // allowing an identical later observation to replay instead of conflict.
      ...(input.telemetryType === 'reconcile_outcome' ? {} : { occurredAt: occurredAtIso }),
      telemetryType: input.telemetryType,
      binding,
      intervalStart,
      intervalEnd,
      desiredReplicas: input.desiredReplicas ?? null,
      observedReplicas: input.observedReplicas ?? null,
      readyReplicas: input.readyReplicas ?? null,
      cpuRequestCores: input.cpuRequestCores ?? null,
      cpuLimitCores: input.cpuLimitCores ?? null,
      memoryRequestBytes: input.memoryRequestBytes ?? null,
      memoryLimitBytes: input.memoryLimitBytes ?? null,
      cpuUsageCoreSeconds: input.cpuUsageCoreSeconds ?? null,
      memoryUsageByteSeconds: input.memoryUsageByteSeconds ?? null,
      payload,
    }

    const envelope: PendingInfrastructureTelemetryEventEnvelopeV1<typeof payload> = {
      ...binding,
      eventId: this.dependencies.newEventId(),
      schemaVersion: 1,
      sourceKind: principal.kind,
      sourceService: principal.sourceService,
      sourceEventId: input.sourceEventId,
      serviceSub: principal.serviceSub,
      telemetryType: input.telemetryType,
      intervalStart,
      intervalEnd,
      desiredReplicas: input.desiredReplicas ?? null,
      observedReplicas: input.observedReplicas ?? null,
      readyReplicas: input.readyReplicas ?? null,
      cpuRequestCores: input.cpuRequestCores ?? null,
      cpuLimitCores: input.cpuLimitCores ?? null,
      memoryRequestBytes: input.memoryRequestBytes ?? null,
      memoryLimitBytes: input.memoryLimitBytes ?? null,
      cpuUsageCoreSeconds: input.cpuUsageCoreSeconds ?? null,
      memoryUsageByteSeconds: input.memoryUsageByteSeconds ?? null,
      payload,
      payloadSha256: canonicalPayloadSha256(canonical),
      occurredAt: occurredAtIso,
      ingestedAt,
    }

    return pendingGovernedInfrastructureTelemetryEventFromEnvelope(envelope)
  }
}

export function pendingGovernedInfrastructureTelemetryEventFromEnvelope<Payload extends object>(
  envelope: PendingInfrastructureTelemetryEventEnvelopeV1<Payload>
): PendingGovernedEvent<'infrastructure_telemetry'> {
  return {
    family: 'infrastructure_telemetry',
    eventId: envelope.eventId,
    schemaVersion: envelope.schemaVersion,
    sourceService: envelope.sourceService,
    sourceKind: envelope.sourceKind,
    sourceEventId: envelope.sourceEventId,
    sourceIdentityColumn: 'source_occurrence_id',
    occurredAt: envelope.occurredAt,
    ingestedAt: envelope.ingestedAt,
    payloadSha256: envelope.payloadSha256,
    familyColumns: [
      { name: 'telemetry_type', value: envelope.telemetryType },
      { name: 'trigger_kind', value: envelope.triggerKind },
      { name: 'outcome', value: envelope.outcome },
      { name: 'reason_code', value: envelope.reasonCode },
      { name: 'environment', value: envelope.environment },
      { name: 'cluster_name', value: envelope.clusterName },
      { name: 'namespace', value: envelope.namespace },
      { name: 'workload_kind', value: envelope.workloadKind },
      { name: 'workload_ref', value: envelope.workloadRef },
      { name: 'kubernetes_kind', value: envelope.kubernetesKind },
      { name: 'kubernetes_name', value: envelope.kubernetesName },
      { name: 'kubernetes_uid', value: envelope.kubernetesUid },
      { name: 'metadata_generation', value: envelope.metadataGeneration },
      { name: 'interval_start', value: envelope.intervalStart },
      { name: 'interval_end', value: envelope.intervalEnd },
      { name: 'desired_replicas', value: envelope.desiredReplicas },
      { name: 'observed_replicas', value: envelope.observedReplicas },
      { name: 'ready_replicas', value: envelope.readyReplicas },
      { name: 'cpu_request_cores', value: envelope.cpuRequestCores },
      { name: 'cpu_limit_cores', value: envelope.cpuLimitCores },
      { name: 'memory_request_bytes', value: envelope.memoryRequestBytes },
      { name: 'memory_limit_bytes', value: envelope.memoryLimitBytes },
      { name: 'cpu_usage_core_seconds', value: envelope.cpuUsageCoreSeconds },
      { name: 'memory_usage_byte_seconds', value: envelope.memoryUsageByteSeconds },
      { name: 'related_operation_id', value: envelope.relatedOperationId },
      { name: 'related_run_id', value: envelope.relatedRunId },
      { name: 'payload_metadata', value: JSON.stringify(envelope.payload) },
    ],
    stream: {
      environment: envelope.environment,
      tenantId: null,
      teamId: null,
      runId: envelope.relatedRunId,
      operationId: envelope.relatedOperationId,
      workloadRef: envelope.workloadRef,
    },
  }
}
