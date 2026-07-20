import { config } from '../../config.js'
import type { DbClient } from '../../db.js'
import type { AdministrativeEventSubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
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
  AdministrativeEventInputV1,
  AdministrativeServerBindingV1,
  ControlApiLocalAdministrativePrincipalV1,
  GovernedAppendResult,
  PendingAdministrativeEventEnvelopeV1,
  TracingServiceDependencies,
} from './contracts.js'
import {
  CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
  ControlApiLocalAdministrativeBindingResolver,
  type ControlApiLocalAdministrativeContextV1,
} from './controlApiLocalAdministrativeBindingResolver.js'

function permits(values: readonly string[], value: string): boolean {
  return values.includes(value)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function bindLocalAdministrativeAuthority(
  principal: AdministrativeEventSubmitterPrincipalV1 | ControlApiLocalAdministrativePrincipalV1,
  binding: AdministrativeServerBindingV1
): AdministrativeServerBindingV1 {
  if (principal.kind !== 'control_api_local' || !binding.operatorSub) return binding

  return {
    ...binding,
    identityIssuer: binding.identityIssuer ?? config.adminJwtIssuer,
    operatorUserId:
      binding.operatorUserId ??
      (UUID_PATTERN.test(binding.operatorSub) ? binding.operatorSub.toLowerCase() : null),
    resourceAud: binding.resourceAud ?? config.adminJwtAudience,
    effectiveScopes: binding.effectiveScopes ?? [],
    authorizationDecision: binding.authorizationDecision ?? 'allow',
    decisionActorSub: binding.decisionActorSub ?? binding.operatorSub,
  }
}

export class AdministrativePrincipalBindingInvariantError extends Error {
  readonly code = 'administrative_principal_binding_invariant'

  constructor(message: string) {
    super(message)
    this.name = 'AdministrativePrincipalBindingInvariantError'
  }
}

function assertPrincipalBinding(
  principal: AdministrativeEventSubmitterPrincipalV1 | ControlApiLocalAdministrativePrincipalV1,
  binding: AdministrativeServerBindingV1,
  input: AdministrativeEventInputV1
): void {
  if (principal.kind === 'hcc_internal_control') {
    if (input.kind !== 'linked_outcome') {
      throw new AdministrativePrincipalBindingInvariantError(
        'hcc_internal_control may submit only linked_outcome administrative events'
      )
    }
    if (!binding.operationId) {
      throw new AdministrativePrincipalBindingInvariantError(
        'hcc_internal_control linked_outcome requires a server-bound operationId'
      )
    }
    return
  }

  if (
    principal.kind === 'wrc_internal_control' &&
    input.kind !== 'service_action' &&
    input.kind !== 'linked_outcome'
  ) {
    throw new AdministrativePrincipalBindingInvariantError(
      'wrc_internal_control may submit only service_action or linked_outcome administrative events'
    )
  }

  if (input.kind === 'linked_outcome' && !binding.operationId) {
    throw new AdministrativePrincipalBindingInvariantError(
      'linked_outcome requires a server-bound operationId'
    )
  }

  if (principal.kind === 'control_api_local' && input.kind === 'linked_outcome') {
    if (binding.action !== 'host_mutation' || binding.targetType !== 'host') {
      throw new AdministrativePrincipalBindingInvariantError(
        'control_api_local linked_outcome is limited to Host administrative operations'
      )
    }
  }
}

export class AdministrativeEventService {
  private readonly dependencies: Required<TracingServiceDependencies>

  constructor(dependencies: TracingServiceDependencies) {
    this.dependencies = resolveServiceDependencies(dependencies)
  }

  async append(
    principal: AdministrativeEventSubmitterPrincipalV1 | ControlApiLocalAdministrativePrincipalV1,
    binding: AdministrativeServerBindingV1,
    input: AdministrativeEventInputV1
  ): Promise<GovernedAppendResult> {
    const event = this.normalize(principal, binding, input)
    return this.dependencies.transaction(db => appendGovernedEventInTransaction(db, event))
  }

  async appendInTransaction(
    db: DbClient,
    principal: AdministrativeEventSubmitterPrincipalV1 | ControlApiLocalAdministrativePrincipalV1,
    binding: AdministrativeServerBindingV1,
    input: AdministrativeEventInputV1
  ): Promise<GovernedAppendResult> {
    return appendGovernedEventInTransaction(db, this.normalize(principal, binding, input))
  }

  async appendManyInTransaction(
    db: DbClient,
    principal: AdministrativeEventSubmitterPrincipalV1 | ControlApiLocalAdministrativePrincipalV1,
    entries: readonly {
      binding: AdministrativeServerBindingV1
      input: AdministrativeEventInputV1
    }[]
  ): Promise<GovernedAppendResult[]> {
    if (entries.length === 0) return []
    return appendGovernedEventBatchInTransaction(
      db,
      entries.map(({ binding, input }) => this.normalize(principal, binding, input)) as [
        PendingGovernedEvent<'administrative'>,
        ...PendingGovernedEvent<'administrative'>[],
      ]
    )
  }

  /**
   * Local callers supply only server-owned mutation context. This method does
   * not expose an HTTP binding path or introduce a second persistence route.
   */
  async appendControlApiLocalInTransaction(
    db: DbClient,
    context: ControlApiLocalAdministrativeContextV1,
    input: AdministrativeEventInputV1
  ): Promise<GovernedAppendResult> {
    const binding = new ControlApiLocalAdministrativeBindingResolver().resolve(context, input)
    if (!binding) {
      throw new AdministrativePrincipalBindingInvariantError(
        'control_api_local administrative event requires the exact server-owned configuration context'
      )
    }
    return this.appendInTransaction(
      db,
      CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
      binding,
      input
    )
  }

  private normalize(
    principal: AdministrativeEventSubmitterPrincipalV1 | ControlApiLocalAdministrativePrincipalV1,
    binding: AdministrativeServerBindingV1,
    input: AdministrativeEventInputV1
  ): PendingGovernedEvent {
    const authoritativeBinding = bindLocalAdministrativeAuthority(principal, binding)
    assertNoClientAuthority(input)
    assertSafeEventPayload(input.payload)
    assertPrincipalBinding(principal, authoritativeBinding, input)
    if (!permits(principal.allowedKinds, input.kind)) {
      throw new Error(`${principal.kind} cannot submit administrative event kind ${input.kind}`)
    }

    const occurredAtIso = normalizeIsoTimestamp(input.occurredAt, 'occurredAt')
    const ingestedAt = this.dependencies.now().toISOString()
    const payload = {
      ...(input.payload ?? {}),
      ...(input.reasonCode ? { reason_code: input.reasonCode } : {}),
      ...(input.sourceStatusRef ? { detail_ref: input.sourceStatusRef } : {}),
    }
    const canonical = {
      family: 'administrative',
      sourceService: principal.sourceService,
      serviceSub: principal.serviceSub,
      sourceKind: principal.kind,
      sourceEventId: input.sourceEventId,
      occurredAt: occurredAtIso,
      kind: input.kind,
      reasonCode: input.reasonCode ?? null,
      sourceStatusRef: input.sourceStatusRef ?? null,
      binding: authoritativeBinding,
      payload,
    }

    const envelope: PendingAdministrativeEventEnvelopeV1<typeof payload> = {
      ...authoritativeBinding,
      eventId: this.dependencies.newEventId(),
      schemaVersion: 1,
      sourceKind: principal.kind,
      sourceService: principal.sourceService,
      sourceEventId: input.sourceEventId,
      serviceSub: principal.serviceSub,
      eventKind: input.kind,
      payload,
      payloadSha256: canonicalPayloadSha256(canonical),
      occurredAt: occurredAtIso,
      ingestedAt,
    }

    return pendingGovernedAdministrativeEventFromEnvelope(envelope)
  }
}

export function pendingGovernedAdministrativeEventFromEnvelope<Payload extends object>(
  envelope: PendingAdministrativeEventEnvelopeV1<Payload>
): PendingGovernedEvent<'administrative'> {
  return {
    family: 'administrative',
    eventId: envelope.eventId,
    schemaVersion: envelope.schemaVersion,
    sourceService: envelope.sourceService,
    sourceKind: envelope.sourceKind,
    sourceEventId: envelope.sourceEventId,
    sourceIdentityColumn: 'source_event_id',
    occurredAt: envelope.occurredAt,
    ingestedAt: envelope.ingestedAt,
    payloadSha256: envelope.payloadSha256,
    familyColumns: [
      { name: 'event_kind', value: envelope.eventKind },
      { name: 'action', value: envelope.action },
      { name: 'outcome', value: envelope.outcome },
      { name: 'operator_sub', value: envelope.operatorSub },
      { name: 'identity_issuer', value: envelope.identityIssuer ?? null },
      { name: 'operator_user_id', value: envelope.operatorUserId ?? null },
      { name: 'delegated_actor_sub', value: envelope.delegatedActorSub ?? null },
      { name: 'resource_aud', value: envelope.resourceAud ?? null },
      { name: 'effective_scopes', value: [...(envelope.effectiveScopes ?? [])].sort() },
      { name: 'token_exchange_id', value: envelope.tokenExchangeId ?? null },
      { name: 'authorization_decision', value: envelope.authorizationDecision ?? null },
      { name: 'decision_actor_sub', value: envelope.decisionActorSub ?? null },
      { name: 'approval_request_id', value: envelope.approvalRequestId ?? null },
      { name: 'service_sub', value: envelope.serviceSub },
      { name: 'operation_id', value: envelope.operationId },
      { name: 'related_run_id', value: envelope.relatedRunId },
      { name: 'request_id', value: envelope.requestId },
      { name: 'target_type', value: envelope.targetType },
      { name: 'target_ref', value: envelope.targetRef },
      { name: 'target_identity_issuer', value: envelope.targetIdentityIssuer ?? null },
      { name: 'target_human_sub', value: envelope.targetHumanSub ?? null },
      { name: 'target_user_id', value: envelope.targetUserId ?? null },
      { name: 'environment', value: envelope.environment },
      { name: 'team_id', value: envelope.teamId },
      { name: 'namespace', value: envelope.namespace },
      { name: 'source_audit_ref', value: envelope.sourceAuditRef },
      { name: 'payload_metadata', value: JSON.stringify(envelope.payload) },
    ],
    stream: {
      environment: envelope.environment,
      tenantId: envelope.tenantId,
      teamId: envelope.teamId,
      runId: envelope.relatedRunId,
      operationId: envelope.operationId,
      workloadRef: null,
    },
  }
}
