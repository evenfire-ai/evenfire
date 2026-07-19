'use client'

import { apiGet } from './api'
import type { TraceApiQuery } from './governedTraceFilters'

export const GOVERNED_EVENT_FAMILIES = [
  'agent_run',
  'administrative',
  'infrastructure_telemetry',
] as const

export type GovernedEventFamily = (typeof GOVERNED_EVENT_FAMILIES)[number]

export type GovernedTraceEvent = {
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
  decisionActorSub: string | null
  actingAgentSub: string | null
  resourceAud: string | null
  effectiveScopes: string[]
  authorizationDecision: string | null
  tokenExchangeId: string | null
  eventType: string
  outcome: string | null
  targetType: string | null
  targetRef: string | null
  recipeNamespace: string | null
  recipeName: string | null
  hostRef: string | null
  operatorUserId?: string | null
  operatorPrincipalId?: string | null
  operatorPrincipalKind?: 'control_admin' | 'platform_user' | 'system' | 'unresolved'
  operatorDisplayName?: string | null
  delegatedActorSub?: string | null
  sourceKind?: string | null
  sourceService?: string | null
  serviceSub?: string | null
  targetUserId?: string | null
  targetUserSub?: string | null
  targetUserDisplayName?: string | null
  teamId?: string | null
  targetTeamDisplayName?: string | null
  telemetryType?: string | null
  reasonCode?: string | null
  clusterName?: string | null
  namespace?: string | null
  workloadKind?: string | null
  workloadRef?: string | null
  controller?: string | null
  payload: Record<string, unknown>
}

export type GovernedTracePage = {
  events: GovernedTraceEvent[]
  nextCursor: string | null
  capturedHighWatermark: string
}

export type GovernedTraceQuery = {
  [key: string]: string | readonly GovernedEventFamily[] | undefined
  cursor?: string
  families?: readonly GovernedEventFamily[]
  order?: 'oldest' | 'latest'
  occurredFrom?: string
  occurredTo?: string
}

export type TraceAttributionStatus = 'verified' | 'verified_late' | 'mixed' | 'unavailable'
export type AdministrativeIdentityStatus =
  | 'verified'
  | 'verified_late'
  | 'legacy'
  | 'system'
  | 'unavailable'
export type GovernedTracePrincipalKind = 'control_admin' | 'platform_user' | 'system' | 'unresolved'
export type PromptHistoryAvailability =
  | 'available'
  | 'disabled'
  | 'none'
  | 'expired'
  | 'unavailable'
export type GovernedToolKind = 'internal_tool' | 'mcp_server_tool' | 'workflow' | 'unclassified'

export type GovernedTraceTokenUsageSummary = {
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

export type GovernedTraceSessionSummaryV1 = {
  hostRef: string
  sessionId: string
  origins: Array<'direct_chat' | 'channel_event' | 'api' | 'workflow_runtime'>
  firstOccurredAt: string
  lastOccurredAt: string
  runCount: number
  eventCount: number
  latestRunOutcome: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | null
  agent: {
    status: Exclude<TraceAttributionStatus, 'verified_late'>
    subject: string | null
    displayName: string | null
  }
  human: {
    status: TraceAttributionStatus
    subject: string | null
    userId: string | null
    displayName: string | null
    identityIssuer: string | null
  }
  tools: {
    totalCalls: number
    distinctTools: number
    byKind: Record<GovernedToolKind, number>
  }
  tokenUsage: GovernedTraceTokenUsageSummary
  approvals: {
    requested: number
    approved: number
    denied: number
    promptHistory: PromptHistoryAvailability
  }
}

export type GovernedTraceSessionPage = {
  sessions: GovernedTraceSessionSummaryV1[]
  nextCursor: string | null
  capturedHighWatermark: string
}

export type GovernedTraceSessionRun = {
  runId: string
  startedAt: string
  endedAt: string | null
  outcome: string
  origin: 'direct_chat' | 'channel_event' | 'api' | 'workflow_runtime'
  eventCount: number
}

export type GovernedTraceToolUsage = {
  toolName: string
  toolKind: GovernedToolKind
  toolSourceRef: string | null
  totalCalls: number
  succeeded: number
  failed: number
  firstOccurredAt: string
  lastOccurredAt: string
}

export type GovernedTraceApproval = {
  approvalRequestId: string | null
  runId: string
  source: 'tool' | 'workflow'
  toolName: string | null
  toolKind: GovernedToolKind | null
  toolSourceRef: string | null
  requestedAt: string | null
  decidedAt: string | null
  state: 'requested' | 'approved' | 'denied' | 'unavailable'
  decisionActorSub: string | null
  observedExecution: 'succeeded' | 'failed' | 'not_observed'
  promptHistory: PromptHistoryAvailability
}

export type GovernedTraceInteraction = {
  streamSequence: string
  eventId: string
  runId: string
  eventType: string
  occurredAt: string
  outcome: string
  toolName: string | null
  toolKind: GovernedToolKind | null
  toolSourceRef: string | null
  approvalRequestId: string | null
  decision: string
  decisionActorSub: string | null
  safeFields: Record<string, string | number | boolean | null>
}

export type GovernedTraceTokenUsagePoint = {
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

export type GovernedTraceTokenUsage = GovernedTraceTokenUsageSummary & {
  points: GovernedTraceTokenUsagePoint[]
  pointsTruncated: boolean
}

export type GovernedTraceSessionDetail = {
  summary: GovernedTraceSessionSummaryV1
  runs: GovernedTraceSessionRun[]
  tools: GovernedTraceToolUsage[]
  approvals: GovernedTraceApproval[]
  tokenUsage: GovernedTraceTokenUsage
  interactions: GovernedTraceInteraction[]
  nextCursor: string | null
  capturedHighWatermark: string
}

export type GovernedAdministrativeEventDetail = {
  eventId: string
  occurredAt: string
  ingestedAt: string
  action: string
  outcome: string
  operatorHuman: {
    status: AdministrativeIdentityStatus
    principalKind: GovernedTracePrincipalKind
    principalId: string | null
    subject: string | null
    userId: string | null
    displayName: string | null
    identityIssuer: string | null
  }
  delegatedActor: { subject: string | null }
  evidenceProducer: {
    sourceKind: string
    sourceService: string
    serviceSub: string
  }
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
  targetHuman: {
    status: AdministrativeIdentityStatus
    principalKind: GovernedTracePrincipalKind
    principalId: string | null
    subject: string | null
    userId: string | null
    displayName: string | null
    identityIssuer: string | null
  }
  safeFields: Record<string, string | number | boolean | null>
}

export type GovernedInfrastructureEventDetail = {
  eventId: string
  occurredAt: string
  ingestedAt: string
  telemetryType: string
  outcome: string
  reasonCode: string | null
  triggerKind: string
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
  safeFields: Record<string, string | number | boolean | null>
}

export type GovernedApprovalPromptHistory = {
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

export type TracingOperationsHealth = 'healthy' | 'warning' | 'critical'
export type TracingOperationsSeverity = 'critical' | 'warning' | 'info'

export type TracingOperationsSnapshot = {
  generatedAt: string
  instanceStartedAt: string
  scope: 'control-api-instance'
  health: TracingOperationsHealth
  limits: {
    bodyBytes: number
    eventsPerRequest: number
    maxInFlight: number
    ingestPoolMax: number
    readPoolMax: number
    poolConnectionTimeoutMs: number
    ingestStatementTimeoutMs: number
    readStatementTimeoutMs: number
    recentErrorSeconds: number
  }
  ingestion: {
    acceptedEvents: number
    replayedEvents: number
    rejectedEvents: number
    conflictingEvents: number
    admissionRequests: number
    admissionRejected: number
    inFlight: number
  }
  pools: Array<{
    name: 'ingest' | 'read'
    active: number
    idle: number
    waiting: number
    rejectedSinceRestart: number
    statementTimeoutsSinceRestart: number
  }>
  errors: Array<{
    reason: string
    message: string
    severity: TracingOperationsSeverity
    countSinceRestart: number
    lastOccurredAt: string | null
    relatedSetting: string | null
    effectiveValue: number | null
    operatorAction: string
  }>
}

export type InfrastructureCostPeriod = 'day' | 'week' | 'month'

export type InfrastructureCostDimensions = {
  cloudProvider: 'gcp'
  cloudProjectId: string
  clusterLocation: string
  clusterName: string
  environment: string
  namespace: string
  workloadKind: string
  workloadRef: string
  currency: string
}

export type InfrastructureCostQuery = {
  period: InfrastructureCostPeriod
  anchorDate: string
  valuation: 'estimated' | 'billed' | 'variance'
  basis: 'requested_capacity' | 'gcp_request_allocation'
} & InfrastructureCostDimensions

export type InfrastructureCostScope = {
  dimensions: InfrastructureCostDimensions
  firstUtcDay: string
  lastUtcDay: string
  availableValuations: readonly ('estimated' | 'billed')[]
  latestAsOfUtc: string
  billingExportWatermark: string | null
  billingLagHours: number | null
}

export type InfrastructureCostScopeCatalog = {
  scopes: readonly InfrastructureCostScope[]
  truncated: boolean
}

export type InfrastructureCostComponent = {
  componentKey: string
  resourceClass: string
  allocationBucket: string | null
  unitHours: string | null
  priceSnapshotId: string | null
  providerService: string | null
  providerSku: string | null
  billingViewVersion: string | null
  sourceRowCount: number | null
  sourceSha256: string
  billingExportWatermark: string | null
  grossAmount: string
  creditsAmount: string
  netAmount: string
  priceSourceRef?: string | null
  priceEffectiveFrom?: string | null
  priceUnitPrice?: string | null
}

export type InfrastructureCostSelection = {
  period: InfrastructureCostPeriod
  periodStartUtc: string
  periodEndUtc: string
  sourceDailyVersionHash: string
  dailyVersionVector: readonly { utcDay: string; id: string; rollupVersion: number }[]
  publicationState: 'provisional' | 'finalized'
  completenessStatus: 'complete' | 'partial' | 'unavailable'
  grossAmount: string
  creditsAmount: string
  netAmount: string
  overheadAmount: string
  unallocatedAmount: string
  unsupportedAmount: string
  valuationKind: 'estimated' | 'billed'
  selectedBasis: 'requested_capacity' | 'gcp_request_allocation'
  asOfUtc: string
  billingExportWatermark: string | null
  billingLagHours: number | null
  billingFreshnessStatus: 'fresh' | 'stale' | 'unavailable' | 'not_applicable'
  components: readonly InfrastructureCostComponent[]
}

export type InfrastructureCostResponse = {
  period: InfrastructureCostPeriod
  periodStartUtc: string
  periodEndUtc: string
  dimensions: InfrastructureCostDimensions
  requestedCapacity: InfrastructureCostSelection | null
  gcpRequestAllocation: InfrastructureCostSelection | null
  variance?: {
    netAmount: string
    billedBasis: 'gcp_request_allocation'
    estimateBasis: 'requested_capacity'
  }
}

function queryForTraceRead(query: GovernedTraceQuery): Record<string, string | undefined> {
  const encoded = Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  return {
    ...encoded,
    cursor: query.cursor,
    families: query.families?.join(','),
    order: query.order,
    occurredFrom: query.occurredFrom,
    occurredTo: query.occurredTo,
  }
}

export async function getGovernedTraceEvents(
  path: string,
  query: GovernedTraceQuery = {},
  signal?: AbortSignal
): Promise<GovernedTracePage> {
  return apiGet(path, queryForTraceRead(query), { signal }) as Promise<GovernedTracePage>
}

export async function getGovernedTraceSessions(
  query: TraceApiQuery = {},
  signal?: AbortSignal
): Promise<GovernedTraceSessionPage> {
  return apiGet('/api/v1/admin/tracing/sessions', query, {
    signal,
  }) as Promise<GovernedTraceSessionPage>
}

export async function getGovernedTraceSessionDetail(
  hostRef: string,
  sessionId: string,
  query: TraceApiQuery = {},
  signal?: AbortSignal
): Promise<GovernedTraceSessionDetail> {
  return apiGet(
    `/api/v1/admin/tracing/sessions/${encodeURIComponent(hostRef)}/${encodeURIComponent(sessionId)}`,
    query,
    { signal }
  ) as Promise<GovernedTraceSessionDetail>
}

export async function getGovernedAdministrativeEventDetail(
  eventId: string,
  signal?: AbortSignal
): Promise<GovernedAdministrativeEventDetail> {
  return apiGet(
    `/api/v1/admin/tracing/administrative/${encodeURIComponent(eventId)}`,
    {},
    { signal }
  ) as Promise<GovernedAdministrativeEventDetail>
}

export async function getGovernedInfrastructureEventDetail(
  eventId: string,
  signal?: AbortSignal
): Promise<GovernedInfrastructureEventDetail> {
  return apiGet(
    `/api/v1/admin/tracing/infrastructure/${encodeURIComponent(eventId)}`,
    {},
    { signal }
  ) as Promise<GovernedInfrastructureEventDetail>
}

export async function getGovernedApprovalPromptHistory(
  approvalRequestId: string
): Promise<GovernedApprovalPromptHistory> {
  return apiGet(
    `/api/v1/admin/tracing/approvals/${encodeURIComponent(approvalRequestId)}/prompt-history`
  ) as Promise<GovernedApprovalPromptHistory>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isTracingOperationsSnapshot(value: unknown): value is TracingOperationsSnapshot {
  if (!isRecord(value) || value.scope !== 'control-api-instance') return false
  if (!['healthy', 'warning', 'critical'].includes(String(value.health))) return false
  if (!isTimestamp(value.generatedAt) || !isTimestamp(value.instanceStartedAt)) return false
  if (!isRecord(value.limits) || !isRecord(value.ingestion)) return false
  const limitKeys = [
    'bodyBytes',
    'eventsPerRequest',
    'maxInFlight',
    'ingestPoolMax',
    'readPoolMax',
    'poolConnectionTimeoutMs',
    'ingestStatementTimeoutMs',
    'readStatementTimeoutMs',
    'recentErrorSeconds',
  ]
  const ingestionKeys = [
    'acceptedEvents',
    'replayedEvents',
    'rejectedEvents',
    'conflictingEvents',
    'admissionRequests',
    'admissionRejected',
    'inFlight',
  ]
  if (!limitKeys.every(key => isFiniteNumber(value.limits[key]))) return false
  if (!ingestionKeys.every(key => isFiniteNumber(value.ingestion[key]))) return false
  if (!Array.isArray(value.pools) || value.pools.length !== 2) return false
  if (!Array.isArray(value.errors) || value.errors.length > 10) return false
  const poolNames = new Set<string>()
  const poolsValid = value.pools.every(pool => {
    if (!isRecord(pool) || !['ingest', 'read'].includes(String(pool.name))) return false
    poolNames.add(String(pool.name))
    return [
      'active',
      'idle',
      'waiting',
      'rejectedSinceRestart',
      'statementTimeoutsSinceRestart',
    ].every(key => isFiniteNumber(pool[key]))
  })
  if (!poolsValid || poolNames.size !== 2) return false
  const reasons = [
    'unsupported_content_type',
    'invalid_json',
    'body_too_large',
    'batch_too_large',
    'capacity_exhausted',
    'event_rejected',
    'idempotency_conflict',
    'submission_failed',
    'pool_rejected',
    'statement_timeout',
    'attribution_binding_unavailable',
    'attribution_binding_conflict',
    'prompt_history_disabled',
    'prompt_history_key_unavailable',
    'prompt_history_rejected',
  ]
  return value.errors.every(error => {
    if (!isRecord(error) || !reasons.includes(String(error.reason))) return false
    if (!['critical', 'warning', 'info'].includes(String(error.severity))) return false
    if (typeof error.message !== 'string' || typeof error.operatorAction !== 'string') return false
    if (!isFiniteNumber(error.countSinceRestart)) return false
    if (error.lastOccurredAt !== null && !isTimestamp(error.lastOccurredAt)) return false
    if (error.relatedSetting !== null && typeof error.relatedSetting !== 'string') return false
    return error.effectiveValue === null || isFiniteNumber(error.effectiveValue)
  })
}

export async function getTracingOperationsSnapshot(
  signal?: AbortSignal
): Promise<TracingOperationsSnapshot> {
  const value = await apiGet('/api/v1/admin/tracing/operations', {}, { signal })
  if (!isTracingOperationsSnapshot(value)) {
    throw new Error('Control API returned an invalid tracing operations snapshot.')
  }
  return value
}

export function isTraceCostsUnavailable(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status?: unknown }).status === 501
  )
}

export async function getInfrastructureTraceCosts(
  query: InfrastructureCostQuery
): Promise<InfrastructureCostResponse> {
  return apiGet(
    '/api/v1/admin/tracing/costs/infrastructure',
    query
  ) as Promise<InfrastructureCostResponse>
}

export async function getInfrastructureCostScopes(): Promise<InfrastructureCostScopeCatalog> {
  return apiGet(
    '/api/v1/admin/tracing/costs/infrastructure/scopes'
  ) as Promise<InfrastructureCostScopeCatalog>
}
