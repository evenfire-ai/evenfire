import type { DbClient } from '../../db.js'

export const GOVERNED_EVENT_FAMILIES = [
  'agent_run',
  'administrative',
  'infrastructure_telemetry',
] as const

export type GovernedEventFamily = (typeof GOVERNED_EVENT_FAMILIES)[number]

export const AGENT_RUN_EVENT_TYPES = [
  'run_start',
  'llm_call',
  'tool_call',
  'approval',
  'token_usage',
  'run_end',
] as const

export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number]

export const GOVERNED_TOOL_KINDS = ['internal_tool', 'mcp_server_tool', 'workflow'] as const

export type GovernedToolKind = (typeof GOVERNED_TOOL_KINDS)[number]
export type GovernedToolKindRead = GovernedToolKind | 'unclassified'

/** Decision source kinds that current control-plane bindings may write. */
export const CURRENT_DECISION_SOURCE_KINDS = [
  'policy_evaluator',
  'approval_request',
  'approval_resolution',
  'legacy_gate',
] as const

export type CurrentDecisionSourceKind = (typeof CURRENT_DECISION_SOURCE_KINDS)[number]

/** Read compatibility for rows written before the canonical source catalog. */
export const LEGACY_DECISION_SOURCE_KINDS = ['policy', 'runtime_guard'] as const

export const DECISION_SOURCE_KINDS = [
  ...CURRENT_DECISION_SOURCE_KINDS,
  ...LEGACY_DECISION_SOURCE_KINDS,
] as const

export type DecisionSourceKind = (typeof DECISION_SOURCE_KINDS)[number]

export const INFRASTRUCTURE_TELEMETRY_TYPES = [
  'reconcile_outcome',
  'health_transition',
  'lifecycle_transition',
  'capacity_sample',
  'usage_sample',
  'controller_error',
] as const

export type InfrastructureTelemetryType = (typeof INFRASTRUCTURE_TELEMETRY_TYPES)[number]

export interface SafeEventPayloadV1 {
  reason_code?: string
  error_class?: string
  phase?: string
  state?: string
  status?: string
  transition?: string
  resource_class?: string
  unit?: string
  provider_ref?: string
  summary?: string
  detail_ref?: string
  target_label?: string
  target_principal_kind?: 'operator' | 'host' | 'context' | 'service'
  target_principal_ref?: string
  tool_name?: string
  tool_kind?: GovernedToolKind
  tool_source_ref?: string
  model?: string
  attempt?: number
  count?: number
  config_hash?: string
}

interface SourceOccurrenceInputV1 {
  sourceEventId: string
  occurredAt: string
  payload?: SafeEventPayloadV1
}

/** Non-authoritative producer input. Identity, routing, and decisions are server bindings. */
export interface AgentRunEventInputV1 extends SourceOccurrenceInputV1 {
  eventType: AgentRunEventType
}

interface GovernedEventEnvelopeBaseV1<Payload extends object> {
  eventId: string
  schemaVersion: 1
  sourceKind: string
  sourceService: string
  sourceEventId: string
  payload: Payload
  payloadSha256: string
  occurredAt: string
  ingestedAt: string
  ingestSequence: string
}

/**
 * Canonical persisted Agent Event Envelope. Producer input and server binding
 * are intentionally separate; this shape exists only after control-api has
 * derived identity, authorization, and ingestion metadata.
 */
export interface AgentRunEventEnvelopeV1<
  Payload extends object = SafeEventPayloadV1,
> extends GovernedEventEnvelopeBaseV1<Payload> {
  sourceKind: 'mcp_host_runtime' | 'wrc_internal_control' | 'control_api_local'
  runId: string
  sessionId: string | null
  spanId: string
  parentSpanId: string | null
  origin: 'direct_chat' | 'workflow_runtime' | 'channel_event' | 'api'
  eventType: AgentRunEventType
  outcome: AgentRunServerBindingV1['outcome']
  identityIssuer: string | null
  actorHumanSub: string | null
  actorMedium: string | null
  agentSub: string
  resourceAud: string | null
  effectiveScopes: readonly string[]
  decision: AgentRunServerBindingV1['decision']
  decisionSourceKind: DecisionSourceKind | null
  decisionSourceRef: string | null
  decisionActorSub: string | null
  approvalRequestId: string | null
  tokenExchangeId: string | null
  hostRef: string | null
  recipeNamespace: string | null
  recipeName: string | null
  teamId: string | null
  userId: string | null
  durationMs: number | null
}

/** The pre-insert form; Postgres assigns the monotonic ingest sequence. */
export type PendingAgentRunEventEnvelopeV1<Payload extends object = SafeEventPayloadV1> = Omit<
  AgentRunEventEnvelopeV1<Payload>,
  'ingestSequence'
>

/** WRC lookup input. `runId` is a reference only and is removed before persistence. */
export interface WorkflowAgentRunEventInputV1 extends AgentRunEventInputV1 {
  runId: string
  approvalRequestId?: string
  /** Runtime lookup hints. Only mcp-host uses these; control-api verifies Host authority. */
  hostRef?: string
  sessionId?: string | null
  origin?: 'direct_chat' | 'channel_event' | 'api'
}

export interface AdministrativeEventInputV1 extends SourceOccurrenceInputV1 {
  kind: 'intent' | 'linked_outcome' | 'service_action'
  reasonCode?: string
  sourceStatusRef?: string
}

export interface InfrastructureTelemetryEventInputV1 extends SourceOccurrenceInputV1 {
  telemetryType: InfrastructureTelemetryType
  /** Non-authoritative lookup hint; control-api derives the Host binding. */
  hostLookupReference?: {
    name: string
    namespace: string
    generation?: number
  }
  /** Non-authoritative lookup hint; control-api derives the WorkflowRecipe binding. */
  workflowRunLookupReference?: { runId: string }
  intervalStart?: string
  intervalEnd?: string
  desiredReplicas?: number
  observedReplicas?: number
  readyReplicas?: number
  cpuRequestCores?: number
  cpuLimitCores?: number
  memoryRequestBytes?: number
  memoryLimitBytes?: number
  cpuUsageCoreSeconds?: number
  memoryUsageByteSeconds?: number
}

export type AdministrativeEventEnvelopeV1<Payload extends object = SafeEventPayloadV1> =
  GovernedEventEnvelopeBaseV1<Payload> &
    AdministrativeServerBindingV1 & {
      sourceKind: 'control_api_local' | 'hcc_internal_control' | 'wrc_internal_control'
      serviceSub: string
      eventKind: AdministrativeEventInputV1['kind']
    }

export type PendingAdministrativeEventEnvelopeV1<Payload extends object = SafeEventPayloadV1> =
  Omit<AdministrativeEventEnvelopeV1<Payload>, 'ingestSequence'>

export type InfrastructureTelemetryEventEnvelopeV1<Payload extends object = SafeEventPayloadV1> =
  GovernedEventEnvelopeBaseV1<Payload> &
    InfrastructureTelemetryServerBindingV1 & {
      sourceKind: 'hcc_internal_control' | 'trace_maintenance' | 'wrc_internal_control'
      serviceSub: string
      telemetryType: InfrastructureTelemetryType
      intervalStart: string | null
      intervalEnd: string | null
      desiredReplicas: number | null
      observedReplicas: number | null
      readyReplicas: number | null
      cpuRequestCores: number | null
      cpuLimitCores: number | null
      memoryRequestBytes: number | null
      memoryLimitBytes: number | null
      cpuUsageCoreSeconds: number | null
      memoryUsageByteSeconds: number | null
    }

export type PendingInfrastructureTelemetryEventEnvelopeV1<
  Payload extends object = SafeEventPayloadV1,
> = Omit<InfrastructureTelemetryEventEnvelopeV1<Payload>, 'ingestSequence'>

/** In-process authority for control-api mutations; remote principals come from middleware. */
export interface ControlApiLocalAdministrativePrincipalV1 {
  kind: 'control_api_local'
  sourceService: 'control-api'
  serviceSub: string
  credentialId: string
  allowedKinds: readonly ('intent' | 'linked_outcome' | 'service_action')[]
}

export interface AgentRunServerBindingV1 {
  runId: string
  sessionId: string | null
  spanId: string
  parentSpanId: string | null
  origin: 'direct_chat' | 'workflow_runtime' | 'channel_event' | 'api'
  identityIssuer: string | null
  actorHumanSub: string | null
  agentSub: string
  actorMedium: string | null
  resourceAud: string | null
  effectiveScopes: readonly string[]
  decision: 'allow' | 'deny' | 'require_approval' | 'not_applicable'
  decisionSourceKind: CurrentDecisionSourceKind | null
  decisionSourceRef: string | null
  decisionActorSub?: string | null
  approvalRequestId: string | null
  tokenExchangeId: string | null
  environment: string
  tenantId: string | null
  teamId: string | null
  userId: string | null
  recipeNamespace: string | null
  recipeName: string | null
  hostRef: string | null
  outcome: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'approved' | 'denied' | 'unknown'
  durationMs: number | null
}

export interface AdministrativeServerBindingV1 {
  action: string
  outcome: string
  operatorSub: string | null
  operationId: string | null
  relatedRunId: string | null
  requestId: string | null
  targetType: string
  targetRef: string
  environment: string
  tenantId: string | null
  teamId: string | null
  namespace: string | null
  sourceAuditRef: string | null
  identityIssuer?: string | null
  operatorUserId?: string | null
  delegatedActorSub?: string | null
  resourceAud?: string | null
  effectiveScopes?: readonly string[]
  tokenExchangeId?: string | null
  authorizationDecision?: 'allow' | 'deny' | 'require_approval' | 'not_applicable' | null
  decisionActorSub?: string | null
  approvalRequestId?: string | null
  targetIdentityIssuer?: string | null
  targetHumanSub?: string | null
  targetUserId?: string | null
}

export interface InfrastructureTelemetryServerBindingV1 {
  triggerKind:
    | 'administrative_intent'
    | 'runtime_activity'
    | 'controller_reconcile'
    | 'periodic_sample'
  outcome: string | null
  reasonCode: string | null
  environment: string
  clusterName: string
  namespace: string
  workloadKind: string
  workloadRef: string
  kubernetesKind: string
  kubernetesName: string
  kubernetesUid: string | null
  metadataGeneration: number | null
  relatedOperationId: string | null
  relatedRunId: string | null
}

export interface TracingTransactionRunner {
  <T>(work: (db: DbClient) => Promise<T>): Promise<T>
}

export interface TracingServiceDependencies {
  transaction: TracingTransactionRunner
  now?: () => Date
  newEventId?: () => string
}

export interface TracingSubmissionResult {
  accepted: number
  replayed: number
}

export interface GovernedAppendResult extends TracingSubmissionResult {
  kind: 'accepted' | 'replayed'
  family: GovernedEventFamily
  eventId: string
  streamSequence: string
  payloadSha256: string
  ingestedAt: string
}

export type GovernedReadScope =
  | { kind: 'stream' }
  | { kind: 'workflow_run'; runId: string; recipeNamespace: string; recipeName: string }
  | { kind: 'host_run'; runId: string; hostRef: string }
  | { kind: 'workload'; workloadRef: string }

export interface GovernedEventReadQueryV1 {
  scope: GovernedReadScope
  families?: readonly GovernedEventFamily[]
  order?: 'oldest' | 'latest'
  cursor?: string
  limit?: number
  occurredFrom?: string
  occurredTo?: string
  filters?: GovernedEventReadFiltersV1
}

export type GovernedEventReadFiltersV1 = {
  outcome?: readonly string[]
  sourceService?: readonly string[]
  operatorUserId?: readonly string[]
  delegatedActorSub?: readonly string[]
  action?: readonly string[]
  targetType?: readonly string[]
  targetRef?: readonly string[]
  targetUserId?: readonly string[]
  teamId?: readonly string[]
  telemetryType?: readonly string[]
  workloadKind?: readonly string[]
  workloadRef?: readonly string[]
  namespace?: readonly string[]
  clusterName?: readonly string[]
  controller?: readonly string[]
  reasonCode?: readonly string[]
}

export interface GovernedEventReadRowV1 {
  streamSequence: string
  eventFamily: GovernedEventFamily
  eventId: string
  schemaVersion: number
  occurredAt: string
  ingestedAt: string
  correlationRef: string | null
  sessionId: string | null
  actorKind: string | null
  actorSub: string | null
  serviceOrAgentSub: string | null
  initiatingHumanSub: string | null
  actingAgentSub: string | null
  resourceAud: string | null
  effectiveScopes: string[]
  authorizationDecision: string | null
  decisionActorSub: string | null
  tokenExchangeId: string | null
  eventType: string
  outcome: string | null
  targetType: string | null
  targetRef: string | null
  recipeNamespace: string | null
  recipeName: string | null
  hostRef: string | null
  operatorUserId: string | null
  operatorPrincipalId: string | null
  operatorPrincipalKind: 'control_admin' | 'platform_user' | 'system' | 'unresolved'
  operatorDisplayName: string | null
  delegatedActorSub: string | null
  sourceKind: string | null
  sourceService: string | null
  serviceSub: string | null
  targetUserId: string | null
  targetUserSub: string | null
  targetUserDisplayName: string | null
  teamId: string | null
  targetTeamDisplayName: string | null
  telemetryType: string | null
  reasonCode: string | null
  clusterName: string | null
  namespace: string | null
  workloadKind: string | null
  workloadRef: string | null
  controller: string | null
  payload: Record<string, unknown>
}

export interface GovernedEventReadPageV1 {
  events: GovernedEventReadRowV1[]
  nextCursor: string | null
  capturedHighWatermark: string
}

export interface GovernedEventReadRepositoryQueryV1 {
  scope: GovernedReadScope
  families: readonly GovernedEventFamily[]
  order: 'oldest' | 'latest'
  afterSequence: string
  highWatermark: string
  limit: number
  occurredFrom: string | null
  occurredTo: string | null
  filters: GovernedEventReadFiltersV1
}

export interface GovernedEventReadRepositoryV1 {
  captureHighWatermark(): Promise<string>
  readAfter(query: GovernedEventReadRepositoryQueryV1): Promise<GovernedEventReadRowV1[]>
}

export const GOVERNED_TRACE_ORIGINS = [
  'direct_chat',
  'workflow_runtime',
  'channel_event',
  'api',
] as const
export type GovernedTraceOrigin = (typeof GOVERNED_TRACE_ORIGINS)[number]

export type PromptHistoryAvailability =
  | 'available'
  | 'disabled'
  | 'none'
  | 'expired'
  | 'unavailable'

export type GovernedTraceSessionSummaryV1 = {
  hostRef: string
  sessionId: string
  origins: GovernedTraceOrigin[]
  firstOccurredAt: string
  lastOccurredAt: string
  runCount: number
  eventCount: number
  latestRunOutcome: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | null
  agent: {
    status: 'verified' | 'mixed' | 'unavailable'
    subject: string | null
    displayName: string | null
  }
  human: {
    status: 'verified' | 'verified_late' | 'mixed' | 'unavailable'
    subject: string | null
    userId: string | null
    displayName: string | null
    identityIssuer: string | null
  }
  tools: {
    totalCalls: number
    distinctTools: number
    byKind: Record<GovernedToolKindRead, number>
  }
  tokenUsage: GovernedTraceSessionTokenUsageSummaryV1
  approvals: {
    requested: number
    approved: number
    denied: number
    promptHistory: Exclude<PromptHistoryAvailability, 'expired'>
  }
}

export type GovernedTraceSessionInteractionV1 = {
  streamSequence: string
  eventId: string
  runId: string
  eventType: AgentRunEventType
  occurredAt: string
  outcome: string
  toolName: string | null
  toolKind: GovernedToolKindRead | null
  toolSourceRef: string | null
  approvalRequestId: string | null
  decision: string
  decisionActorSub: string | null
  safeFields: SafeEventPayloadV1
}

export type GovernedTraceSessionRunV1 = {
  runId: string
  startedAt: string
  endedAt: string | null
  outcome: string
  origin: GovernedTraceOrigin
  eventCount: number
}

export type GovernedTraceSessionToolV1 = {
  toolName: string
  toolKind: GovernedToolKindRead
  toolSourceRef: string | null
  totalCalls: number
  succeeded: number
  failed: number
  firstOccurredAt: string
  lastOccurredAt: string
}

export type GovernedTraceSessionApprovalV1 = {
  approvalRequestId: string | null
  runId: string
  source: 'tool' | 'workflow'
  toolName: string | null
  toolKind: GovernedToolKindRead | null
  toolSourceRef: string | null
  state: 'requested' | 'approved' | 'denied' | 'unavailable'
  requestedAt: string | null
  decidedAt: string | null
  decisionActorSub: string | null
  observedExecution: 'succeeded' | 'failed' | 'not_observed'
  promptHistory: PromptHistoryAvailability
}

export type GovernedTraceSessionTokenUsageSummaryV1 = {
  observedLlmCalls: number
  meteredCalls: number
  coverage: 'complete' | 'partial' | 'unavailable' | 'not_applicable'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheReporting: 'complete' | 'partial' | 'unavailable' | 'not_applicable'
  totalTokens: number
}

export type GovernedTraceSessionTokenUsagePointV1 = {
  streamSequence: string
  eventId: string
  runId: string
  occurredAt: string
  provider: string
  model: string
  sourceKind: string
  iteration: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheTokensReported: boolean
}

export type GovernedTraceSessionTokenUsageV1 = GovernedTraceSessionTokenUsageSummaryV1 & {
  points: GovernedTraceSessionTokenUsagePointV1[]
  pointsTruncated: boolean
}

export type GovernedTraceSessionDetailV1 = {
  summary: GovernedTraceSessionSummaryV1
  runs: GovernedTraceSessionRunV1[]
  tools: GovernedTraceSessionToolV1[]
  approvals: GovernedTraceSessionApprovalV1[]
  tokenUsage: GovernedTraceSessionTokenUsageV1
  interactions: GovernedTraceSessionInteractionV1[]
  nextCursor: string | null
  capturedHighWatermark: string
}

export type GovernedTraceSessionPageV1 = {
  sessions: GovernedTraceSessionSummaryV1[]
  nextCursor: string | null
  capturedHighWatermark: string
}

export type GovernedTracePrincipalKind = 'control_admin' | 'platform_user' | 'system' | 'unresolved'

export type GovernedTraceIdentityV1 = {
  status: 'verified' | 'verified_late' | 'legacy' | 'system' | 'unavailable'
  principalKind: GovernedTracePrincipalKind
  principalId: string | null
  subject: string | null
  userId: string | null
  displayName: string | null
  identityIssuer: string | null
}

export type AdministrativeEventDetailV1 = {
  eventId: string
  action: string
  outcome: string
  occurredAt: string
  ingestedAt: string
  operatorHuman: GovernedTraceIdentityV1
  delegatedActor: { subject: string | null }
  evidenceProducer: { sourceKind: string; sourceService: string; serviceSub: string }
  authorization: {
    resourceAud: string | null
    effectiveScopes: string[]
    tokenExchangeId: string | null
    decision: string | null
    decisionActorSub: string | null
    approvalRequestId: string | null
    operationId: string | null
    requestId: string | null
    relatedRunId: string | null
  }
  context: {
    environment: string | null
    namespace: string | null
    deploymentRef: string | null
    teamId: string | null
    teamDisplayName: string | null
  }
  provenance: {
    sourceAuditRef: string | null
    sourceAdapterKind: string | null
    sourceAdapterVersion: string | null
    codeDigest: string | null
    configDigest: string | null
    policyDigest: string | null
    authorizationRef: string | null
    effectRef: string | null
    preStateDigest: string | null
    postStateDigest: string | null
    payloadSha256: string
  }
  targetResource: { type: string; ref: string }
  targetHuman: GovernedTraceIdentityV1
  safeFields: SafeEventPayloadV1
}

export type InfrastructureEventDetailV1 = {
  eventId: string
  telemetryType: InfrastructureTelemetryType
  outcome: string
  reasonCode: string | null
  triggerKind: string
  occurredAt: string
  ingestedAt: string
  source: {
    sourceKind: string
    sourceService: string
    controller: string
    sourceOccurrenceId: string
    sourceAdapterKind: string | null
    sourceAdapterVersion: string | null
  }
  scope: {
    environment: string
    clusterName: string
    namespace: string
    workloadKind: string
    workloadRef: string
    kubernetesKind: string
    kubernetesName: string
    kubernetesUid: string | null
    metadataGeneration: string | null
  }
  correlation: {
    operationId: string | null
    runId: string | null
    authorizationRef: string | null
    effectRef: string | null
  }
  interval: { start: string | null; end: string | null }
  capacity: {
    desiredReplicas: number | null
    observedReplicas: number | null
    readyReplicas: number | null
    cpuRequestCores: string | null
    cpuLimitCores: string | null
    memoryRequestBytes: string | null
    memoryLimitBytes: string | null
  }
  usage: { cpuUsageCoreSeconds: string | null; memoryUsageByteSeconds: string | null }
  integrity: {
    codeDigest: string | null
    configDigest: string | null
    policyDigest: string | null
    preStateDigest: string | null
    postStateDigest: string | null
    payloadSha256: string
  }
  safeFields: SafeEventPayloadV1
}

export type ApprovalPromptHistoryReadV1 = {
  approvalRequestId: string
  availability: PromptHistoryAvailability
  prompt: null | {
    text: string
    capturedAt: string
    expiresAt: string
    keyVersion: string
    redactionSummary: { redacted: boolean; replacementCount: number }
  }
}
