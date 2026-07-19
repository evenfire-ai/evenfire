import type { DbClient } from '../../db.js'
import type { AgentRunEventSubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
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
  AgentRunEventInputV1,
  AgentRunEventType,
  AgentRunServerBindingV1,
  GovernedAppendResult,
  PendingAgentRunEventEnvelopeV1,
  TracingServiceDependencies,
} from './contracts.js'

export interface McpHostRuntimeAgentRunPrincipalV1 {
  kind: 'mcp_host_runtime'
  sourceService: string
  serviceSub: string
  credentialId: string
  recipeNamespace: string
  recipeName: string
  hostRefs: readonly string[]
  allowedEventTypes: readonly AgentRunEventType[]
}

export interface ControlApiLocalAgentRunPrincipalV1 {
  kind: 'control_api_local'
  sourceService: 'control-api'
  serviceSub: string
  credentialId: 'in-process'
  allowedEventTypes: readonly ['approval']
}

type AgentRunPrincipalV1 =
  | AgentRunEventSubmitterPrincipalV1
  | McpHostRuntimeAgentRunPrincipalV1
  | ControlApiLocalAgentRunPrincipalV1

export class AgentRunPrincipalBindingInvariantError extends Error {
  readonly code = 'agent_run_principal_binding_invariant'

  constructor(message: string) {
    super(message)
    this.name = 'AgentRunPrincipalBindingInvariantError'
  }
}

function assertPrincipalBinding(
  principal: AgentRunPrincipalV1,
  binding: AgentRunServerBindingV1,
  input: AgentRunEventInputV1
): void {
  if (principal.kind === 'control_api_local') {
    if (
      input.eventType !== 'approval' ||
      binding.origin !== 'workflow_runtime' ||
      binding.hostRef !== null ||
      binding.approvalRequestId === null ||
      !binding.recipeNamespace ||
      !binding.recipeName
    ) {
      throw new AgentRunPrincipalBindingInvariantError(
        'control_api_local approval projection requires a bound workflow approval'
      )
    }
    return
  }
  if (principal.kind === 'wrc_internal_control') {
    if (binding.origin !== 'workflow_runtime') {
      throw new AgentRunPrincipalBindingInvariantError(
        'wrc_internal_control agent lifecycle events require workflow_runtime origin'
      )
    }
    return
  }

  if (
    binding.recipeNamespace !== principal.recipeNamespace ||
    binding.recipeName !== principal.recipeName ||
    binding.hostRef === null ||
    !principal.hostRefs.includes(binding.hostRef)
  ) {
    throw new AgentRunPrincipalBindingInvariantError(
      'mcp_host_runtime binding must exactly match its recipe and host claims'
    )
  }
  if (binding.origin === 'workflow_runtime') {
    throw new AgentRunPrincipalBindingInvariantError(
      'mcp_host_runtime cannot claim workflow_runtime origin'
    )
  }
}

function permits(values: readonly string[], value: string): boolean {
  return values.includes(value)
}

export class AgentRunEventService {
  private readonly dependencies: Required<TracingServiceDependencies>

  constructor(dependencies: TracingServiceDependencies) {
    this.dependencies = resolveServiceDependencies(dependencies)
  }

  async append(
    principal: AgentRunPrincipalV1,
    binding: AgentRunServerBindingV1,
    input: AgentRunEventInputV1
  ): Promise<GovernedAppendResult> {
    const event = this.normalize(principal, binding, input)
    return this.dependencies.transaction(db => appendGovernedEventInTransaction(db, event))
  }

  async appendInTransaction(
    db: DbClient,
    principal: AgentRunPrincipalV1,
    binding: AgentRunServerBindingV1,
    input: AgentRunEventInputV1
  ): Promise<GovernedAppendResult> {
    return appendGovernedEventInTransaction(db, this.normalize(principal, binding, input))
  }

  async appendManyInTransaction(
    db: DbClient,
    principal: AgentRunPrincipalV1,
    entries: readonly { binding: AgentRunServerBindingV1; input: AgentRunEventInputV1 }[]
  ): Promise<GovernedAppendResult[]> {
    if (entries.length === 0) return []
    return appendGovernedEventBatchInTransaction(
      db,
      entries.map(({ binding, input }) => this.normalize(principal, binding, input)) as [
        PendingGovernedEvent<'agent_run'>,
        ...PendingGovernedEvent<'agent_run'>[],
      ]
    )
  }

  private normalize(
    principal: AgentRunPrincipalV1,
    binding: AgentRunServerBindingV1,
    input: AgentRunEventInputV1
  ): PendingGovernedEvent {
    assertNoClientAuthority(input)
    assertSafeEventPayload(input.payload)
    assertPrincipalBinding(principal, binding, input)
    if (!permits(principal.allowedEventTypes, input.eventType)) {
      throw new Error(`${principal.kind} cannot submit agent event type ${input.eventType}`)
    }
    if (input.eventType === 'run_start' && binding.parentSpanId !== null) {
      throw new Error('run_start must be the null-parent root span')
    }
    if (input.eventType !== 'run_start' && binding.parentSpanId === null) {
      throw new Error(`${input.eventType} must link to the run root or a descendant span`)
    }

    const occurredAt = normalizeIsoTimestamp(input.occurredAt, 'occurredAt')
    const ingestedAt = this.dependencies.now().toISOString()
    const effectiveScopes = [...new Set(binding.effectiveScopes)].sort()
    const payload = input.payload ?? {}
    const canonical = {
      family: 'agent_run',
      sourceService: principal.sourceService,
      serviceSub: principal.serviceSub,
      sourceKind: principal.kind,
      sourceEventId: input.sourceEventId,
      occurredAt,
      eventType: input.eventType,
      binding: { ...binding, effectiveScopes },
      payload,
    }

    const envelope: PendingAgentRunEventEnvelopeV1 = {
      eventId: this.dependencies.newEventId(),
      schemaVersion: 1,
      sourceKind: principal.kind,
      sourceService: principal.sourceService,
      sourceEventId: input.sourceEventId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      spanId: binding.spanId,
      parentSpanId: binding.parentSpanId,
      origin: binding.origin,
      eventType: input.eventType,
      outcome: binding.outcome,
      identityIssuer: binding.identityIssuer,
      actorHumanSub: binding.actorHumanSub,
      actorMedium: binding.actorMedium,
      agentSub: binding.agentSub,
      resourceAud: binding.resourceAud,
      effectiveScopes,
      decision: binding.decision,
      decisionSourceKind: binding.decisionSourceKind,
      decisionSourceRef: binding.decisionSourceRef,
      decisionActorSub: binding.decisionActorSub ?? null,
      approvalRequestId: binding.approvalRequestId,
      tokenExchangeId: binding.tokenExchangeId,
      hostRef: binding.hostRef,
      recipeNamespace: binding.recipeNamespace,
      recipeName: binding.recipeName,
      teamId: binding.teamId,
      userId: binding.userId,
      durationMs: binding.durationMs,
      payload,
      payloadSha256: canonicalPayloadSha256(canonical),
      occurredAt,
      ingestedAt,
    }

    return pendingGovernedAgentRunEventFromEnvelope(envelope, {
      environment: binding.environment,
      tenantId: binding.tenantId,
    })
  }
}

export function pendingGovernedAgentRunEventFromEnvelope<Payload extends object>(
  envelope: PendingAgentRunEventEnvelopeV1<Payload>,
  stream: { environment: string; tenantId: string | null }
): PendingGovernedEvent<'agent_run'> {
  return {
    family: 'agent_run',
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
      { name: 'run_id', value: envelope.runId },
      { name: 'session_id', value: envelope.sessionId },
      { name: 'span_id', value: envelope.spanId },
      { name: 'parent_span_id', value: envelope.parentSpanId },
      { name: 'origin', value: envelope.origin },
      { name: 'event_type', value: envelope.eventType },
      { name: 'identity_issuer', value: envelope.identityIssuer },
      { name: 'actor_human_sub', value: envelope.actorHumanSub },
      { name: 'agent_sub', value: envelope.agentSub },
      { name: 'actor_medium', value: envelope.actorMedium },
      { name: 'resource_aud', value: envelope.resourceAud },
      { name: 'effective_scopes', value: envelope.effectiveScopes },
      { name: 'decision', value: envelope.decision },
      { name: 'decision_source_kind', value: envelope.decisionSourceKind },
      { name: 'decision_source_ref', value: envelope.decisionSourceRef },
      { name: 'decision_actor_sub', value: envelope.decisionActorSub },
      { name: 'approval_request_id', value: envelope.approvalRequestId },
      { name: 'token_exchange_id', value: envelope.tokenExchangeId },
      { name: 'team_id', value: envelope.teamId },
      { name: 'user_id', value: envelope.userId },
      { name: 'recipe_namespace', value: envelope.recipeNamespace },
      { name: 'recipe_name', value: envelope.recipeName },
      { name: 'host_ref', value: envelope.hostRef },
      { name: 'outcome', value: envelope.outcome },
      { name: 'duration_ms', value: envelope.durationMs },
      { name: 'payload_metadata', value: JSON.stringify(envelope.payload) },
    ],
    stream: {
      environment: stream.environment,
      tenantId: stream.tenantId,
      teamId: envelope.teamId,
      runId: envelope.runId,
      operationId: null,
      workloadRef: envelope.hostRef,
    },
  }
}
