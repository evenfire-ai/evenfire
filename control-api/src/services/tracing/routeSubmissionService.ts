import type { DbClient } from '../../db.js'
import type {
  AdministrativeEventSubmitterPrincipalV1,
  AgentRunEventSubmitterPrincipalV1,
  InfrastructureTelemetrySubmitterPrincipalV1,
  TracingEventRecord,
} from '../../middleware/tracingSubmitterAuth.js'
import {
  governedTraceAcceptedTotal,
  governedTraceBatchSize,
  governedTraceConflictingTotal,
  governedTraceIngestDurationSeconds,
  governedTraceRejectedTotal,
  governedTraceReplayedTotal,
  recordGovernedTraceOperationalError,
} from '../../observability/metrics.js'
import type { AdministrativeEventSubmissionService } from '../../routes/internal/administrativeEvents.js'
import type { AgentRunEventSubmissionService } from '../../routes/internal/agentRunEvents.js'
import type { InfrastructureTelemetryEventSubmissionService } from '../../routes/internal/infrastructureTelemetryEvents.js'
import { AdministrativeEventService } from './administrativeEvents.js'
import { AgentRunEventService } from './agentRunEvents.js'
import {
  TracingIdempotencyConflictError,
  UnsafeTracingInputError,
  assertNoClientAuthority,
  assertSafeEventPayload,
} from './append.js'
import {
  AGENT_RUN_EVENT_TYPES,
  type AdministrativeEventInputV1,
  type AdministrativeServerBindingV1,
  type AgentRunEventInputV1,
  type AgentRunServerBindingV1,
  type GovernedAppendResult,
  type GovernedEventFamily,
  INFRASTRUCTURE_TELEMETRY_TYPES,
  type InfrastructureTelemetryEventInputV1,
  type InfrastructureTelemetryServerBindingV1,
  type SafeEventPayloadV1,
  type TracingServiceDependencies,
  type TracingSubmissionResult,
  type WorkflowAgentRunEventInputV1,
} from './contracts.js'
import { InfrastructureTelemetryEventService } from './infrastructureTelemetryEvents.js'
import { meterTracingDbClient, withTracingQueryMeter } from './queryMeter.js'

type MaybePromise<T> = T | Promise<T>
type Submission<P> = { principal: P; events: readonly TracingEventRecord[] }
type AgentSubmission = Submission<AgentRunEventSubmitterPrincipalV1>
type AdminSubmission = Submission<AdministrativeEventSubmitterPrincipalV1>
type InfraSubmission = Submission<InfrastructureTelemetrySubmitterPrincipalV1>
type AnySubmission = AgentSubmission | AdminSubmission | InfraSubmission

export interface AgentRunBindingResolver {
  resolve(
    principal: AgentRunEventSubmitterPrincipalV1,
    event: WorkflowAgentRunEventInputV1
  ): MaybePromise<AgentRunServerBindingV1 | null | undefined>
  resolveMany?(
    principal: AgentRunEventSubmitterPrincipalV1,
    events: readonly WorkflowAgentRunEventInputV1[]
  ): MaybePromise<readonly (AgentRunServerBindingV1 | null | undefined)[]>
}

export interface AdministrativeOperationBindingResolver {
  resolve(
    principal: AdministrativeEventSubmitterPrincipalV1,
    event: AdministrativeEventInputV1
  ): MaybePromise<AdministrativeServerBindingV1 | null | undefined>
  resolveMany?(
    principal: AdministrativeEventSubmitterPrincipalV1,
    events: readonly AdministrativeEventInputV1[]
  ): MaybePromise<readonly (AdministrativeServerBindingV1 | null | undefined)[]>
}

export interface InfrastructureWorkloadBindingResolver {
  resolve(
    principal: InfrastructureTelemetrySubmitterPrincipalV1,
    event: InfrastructureTelemetryEventInputV1
  ): MaybePromise<InfrastructureTelemetryServerBindingV1 | null | undefined>
  resolveMany?(
    principal: InfrastructureTelemetrySubmitterPrincipalV1,
    events: readonly InfrastructureTelemetryEventInputV1[]
  ): MaybePromise<readonly (InfrastructureTelemetryServerBindingV1 | null | undefined)[]>
}

type BindingResolver<Principal, Event, Binding> = {
  resolve(principal: Principal, event: Event): MaybePromise<Binding | null | undefined>
  resolveMany?(
    principal: Principal,
    events: readonly Event[]
  ): MaybePromise<readonly (Binding | null | undefined)[]>
}

export class TracingBindingUnavailableError extends Error {
  readonly code = 'tracing_binding_unavailable'
  readonly status = 403
  readonly statusCode = 403

  constructor(
    readonly bindingKind: 'run' | 'operation' | 'workload',
    readonly eventIndex: number
  ) {
    super(`trusted ${bindingKind} binding is unavailable for tracing event ${eventIndex}`)
    this.name = 'TracingBindingUnavailableError'
  }
}

export class InvalidTracingInputError extends TypeError {
  readonly code = 'invalid_tracing_input'
  readonly status = 400
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'InvalidTracingInputError'
  }
}

type AgentAppender = Pick<AgentRunEventService, 'appendManyInTransaction'>
type AdminAppender = Pick<AdministrativeEventService, 'appendManyInTransaction'>
type InfraAppender = Pick<InfrastructureTelemetryEventService, 'appendManyInTransaction'>

type MetricSource = 'mcp-host' | 'workflow-recipes' | 'host-context-controller'
type MetricEvent = { sourceEventId: string; type: string }

export interface RouteTracingSubmissionServiceDependencies extends TracingServiceDependencies {
  agentRunBindingResolver?: AgentRunBindingResolver
  administrativeOperationBindingResolver?: AdministrativeOperationBindingResolver
  infrastructureWorkloadBindingResolver?: InfrastructureWorkloadBindingResolver
  agentRunEventAppender?: AgentAppender
  administrativeEventAppender?: AdminAppender
  infrastructureTelemetryAppender?: InfraAppender
}

const failClosedAgentResolver: AgentRunBindingResolver = { resolve: () => null }
const failClosedAdminResolver: AdministrativeOperationBindingResolver = { resolve: () => null }
const failClosedInfraResolver: InfrastructureWorkloadBindingResolver = { resolve: () => null }

const AGENT_FIELDS = new Set([
  'sourceEventId',
  'occurredAt',
  'payload',
  'eventType',
  'runId',
  'approvalRequestId',
  'hostRef',
  'sessionId',
  'origin',
])
const ADMIN_FIELDS = new Set([
  'sourceEventId',
  'occurredAt',
  'payload',
  'kind',
  'reasonCode',
  'sourceStatusRef',
])
const INFRA_FIELDS = new Set([
  'sourceEventId',
  'occurredAt',
  'payload',
  'telemetryType',
  'hostLookupReference',
  'workflowRunLookupReference',
  'intervalStart',
  'intervalEnd',
  'desiredReplicas',
  'observedReplicas',
  'readyReplicas',
  'cpuRequestCores',
  'cpuLimitCores',
  'memoryRequestBytes',
  'memoryLimitBytes',
  'cpuUsageCoreSeconds',
  'memoryUsageByteSeconds',
])

function validateShape(
  event: TracingEventRecord,
  allowed: ReadonlySet<string>,
  index: number,
  referenceFields: ReadonlySet<string> = new Set()
): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new InvalidTracingInputError(`events[${index}] must be an object`)
  }
  assertNoClientAuthority(
    Object.fromEntries(Object.entries(event).filter(([field]) => !referenceFields.has(field))),
    `events[${index}]`
  )
  for (const field of Object.keys(event)) {
    if (!allowed.has(field)) throw new UnsafeTracingInputError(`events[${index}].${field}`)
  }
}

function stringField(
  event: TracingEventRecord,
  field: string,
  index: number,
  optional = false
): string | undefined {
  const value = event[field]
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || (!optional && value.length === 0)) {
    throw new InvalidTracingInputError(`events[${index}].${field} must be a string`)
  }
  return value
}

function numberField(event: TracingEventRecord, field: string, index: number): number | undefined {
  const value = event[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number')
    throw new InvalidTracingInputError(`events[${index}].${field} must be a number`)
  return value
}

function payloadField(event: TracingEventRecord): SafeEventPayloadV1 | undefined {
  assertSafeEventPayload(event.payload)
  return event.payload as SafeEventPayloadV1 | undefined
}

function normalizeAgent(event: TracingEventRecord, index: number): WorkflowAgentRunEventInputV1 {
  validateShape(
    event,
    AGENT_FIELDS,
    index,
    new Set(['runId', 'approvalRequestId', 'hostRef', 'sessionId', 'origin'])
  )
  const eventType = stringField(event, 'eventType', index)!
  if (!AGENT_RUN_EVENT_TYPES.some(value => value === eventType)) {
    throw new InvalidTracingInputError(`events[${index}].eventType is not supported`)
  }
  const origin = stringField(event, 'origin', index, true)
  if (origin !== undefined && !['direct_chat', 'channel_event', 'api'].includes(origin)) {
    throw new InvalidTracingInputError(`events[${index}].origin is not supported`)
  }
  const sessionId = event.sessionId === null ? null : stringField(event, 'sessionId', index, true)
  return {
    runId: stringField(event, 'runId', index)!,
    approvalRequestId: stringField(event, 'approvalRequestId', index, true),
    sourceEventId: stringField(event, 'sourceEventId', index)!,
    occurredAt: stringField(event, 'occurredAt', index)!,
    eventType: eventType as AgentRunEventInputV1['eventType'],
    payload: payloadField(event),
    hostRef: stringField(event, 'hostRef', index, true),
    sessionId,
    origin: origin as WorkflowAgentRunEventInputV1['origin'],
  }
}

function appendableAgentInput(event: WorkflowAgentRunEventInputV1): AgentRunEventInputV1 {
  return {
    sourceEventId: event.sourceEventId,
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    payload: event.payload,
  }
}

function normalizeAdmin(event: TracingEventRecord, index: number): AdministrativeEventInputV1 {
  validateShape(event, ADMIN_FIELDS, index)
  const kind = stringField(event, 'kind', index)!
  if (!['intent', 'linked_outcome', 'service_action'].includes(kind)) {
    throw new InvalidTracingInputError(`events[${index}].kind is not supported`)
  }
  return {
    sourceEventId: stringField(event, 'sourceEventId', index)!,
    occurredAt: stringField(event, 'occurredAt', index)!,
    kind: kind as AdministrativeEventInputV1['kind'],
    reasonCode: stringField(event, 'reasonCode', index, true),
    sourceStatusRef: stringField(event, 'sourceStatusRef', index, true),
    payload: payloadField(event),
  }
}

function normalizeInfra(
  event: TracingEventRecord,
  index: number
): InfrastructureTelemetryEventInputV1 {
  validateShape(
    event,
    INFRA_FIELDS,
    index,
    new Set(['hostLookupReference', 'workflowRunLookupReference'])
  )
  const telemetryType = stringField(event, 'telemetryType', index)!
  if (!INFRASTRUCTURE_TELEMETRY_TYPES.some(value => value === telemetryType)) {
    throw new InvalidTracingInputError(`events[${index}].telemetryType is not supported`)
  }
  const text = (field: string) => stringField(event, field, index, true)
  const number = (field: string) => numberField(event, field, index)
  const hostLookupReference = event.hostLookupReference
  const workflowRunLookupReference = event.workflowRunLookupReference
  if (
    hostLookupReference !== undefined &&
    (!hostLookupReference ||
      typeof hostLookupReference !== 'object' ||
      Array.isArray(hostLookupReference) ||
      typeof (hostLookupReference as Record<string, unknown>).name !== 'string' ||
      typeof (hostLookupReference as Record<string, unknown>).namespace !== 'string' ||
      ((hostLookupReference as Record<string, unknown>).generation !== undefined &&
        typeof (hostLookupReference as Record<string, unknown>).generation !== 'number'))
  ) {
    throw new InvalidTracingInputError(
      `events[${index}].hostLookupReference must be a Host lookup reference`
    )
  }
  if (
    workflowRunLookupReference !== undefined &&
    (!workflowRunLookupReference ||
      typeof workflowRunLookupReference !== 'object' ||
      Array.isArray(workflowRunLookupReference) ||
      Object.keys(workflowRunLookupReference as Record<string, unknown>).some(
        key => key !== 'runId'
      ) ||
      typeof (workflowRunLookupReference as Record<string, unknown>).runId !== 'string')
  ) {
    throw new InvalidTracingInputError(
      `events[${index}].workflowRunLookupReference must be a workflow run lookup reference`
    )
  }
  return {
    sourceEventId: stringField(event, 'sourceEventId', index)!,
    occurredAt: stringField(event, 'occurredAt', index)!,
    telemetryType: telemetryType as InfrastructureTelemetryEventInputV1['telemetryType'],
    hostLookupReference:
      hostLookupReference as InfrastructureTelemetryEventInputV1['hostLookupReference'],
    workflowRunLookupReference:
      workflowRunLookupReference as InfrastructureTelemetryEventInputV1['workflowRunLookupReference'],
    intervalStart: text('intervalStart'),
    intervalEnd: text('intervalEnd'),
    desiredReplicas: number('desiredReplicas'),
    observedReplicas: number('observedReplicas'),
    readyReplicas: number('readyReplicas'),
    cpuRequestCores: number('cpuRequestCores'),
    cpuLimitCores: number('cpuLimitCores'),
    memoryRequestBytes: number('memoryRequestBytes'),
    memoryLimitBytes: number('memoryLimitBytes'),
    cpuUsageCoreSeconds: number('cpuUsageCoreSeconds'),
    memoryUsageByteSeconds: number('memoryUsageByteSeconds'),
    payload: payloadField(event),
  }
}

function requireEvents(events: readonly TracingEventRecord[]): void {
  if (events.length === 0)
    throw new InvalidTracingInputError('tracing submission requires at least one event')
}

async function resolveTrustedBindings<Principal, Event, Binding>(input: {
  resolver: BindingResolver<Principal, Event, Binding>
  principal: Principal
  events: readonly Event[]
  bindingKind: 'run' | 'operation' | 'workload'
}): Promise<Binding[]> {
  const resolved = input.resolver.resolveMany
    ? await input.resolver.resolveMany(input.principal, input.events)
    : await Promise.all(input.events.map(event => input.resolver.resolve(input.principal, event)))
  if (resolved.length !== input.events.length) {
    throw new Error(
      `trusted ${input.bindingKind} binding resolver returned an unexpected batch size`
    )
  }
  return resolved.map((binding, index) => {
    if (!binding) throw new TracingBindingUnavailableError(input.bindingKind, index)
    return binding
  })
}

function isAgent(input: AnySubmission): input is AgentSubmission {
  return 'allowedEventTypes' in input.principal
}

function isAdmin(input: AnySubmission): input is AdminSubmission {
  return 'allowedKinds' in input.principal
}

function metricSource(input: AnySubmission): MetricSource {
  return input.principal.sourceService
}

function metricEvents(input: AnySubmission): {
  family: GovernedEventFamily
  events: MetricEvent[]
} {
  if (isAgent(input)) {
    return {
      family: 'agent_run',
      events: input.events.map(event => ({
        sourceEventId: typeof event.sourceEventId === 'string' ? event.sourceEventId : '',
        type: AGENT_RUN_EVENT_TYPES.includes(event.eventType as AgentRunEventInputV1['eventType'])
          ? String(event.eventType)
          : 'invalid',
      })),
    }
  }
  if (isAdmin(input)) {
    return {
      family: 'administrative',
      events: input.events.map(event => ({
        sourceEventId: typeof event.sourceEventId === 'string' ? event.sourceEventId : '',
        type: ['intent', 'linked_outcome', 'service_action'].includes(String(event.kind))
          ? String(event.kind)
          : 'invalid',
      })),
    }
  }
  return {
    family: 'infrastructure_telemetry',
    events: input.events.map(event => ({
      sourceEventId: typeof event.sourceEventId === 'string' ? event.sourceEventId : '',
      type: INFRASTRUCTURE_TELEMETRY_TYPES.includes(
        event.telemetryType as InfrastructureTelemetryEventInputV1['telemetryType']
      )
        ? String(event.telemetryType)
        : 'invalid',
    })),
  }
}

function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
}

function rejectionReason(
  error: unknown
): 'event_rejected' | 'idempotency_conflict' | 'submission_failed' {
  if (error instanceof TracingIdempotencyConflictError) return 'idempotency_conflict'
  if (
    error instanceof InvalidTracingInputError ||
    error instanceof UnsafeTracingInputError ||
    error instanceof TracingBindingUnavailableError ||
    (error !== null &&
      typeof error === 'object' &&
      ('status' in error || 'statusCode' in error) &&
      [400, 403].includes(
        Number('status' in error ? error.status : (error as { statusCode?: unknown }).statusCode)
      ))
  ) {
    return 'event_rejected'
  }
  return 'submission_failed'
}

export class RouteTracingSubmissionService
  implements
    AgentRunEventSubmissionService,
    AdministrativeEventSubmissionService,
    InfrastructureTelemetryEventSubmissionService
{
  private readonly agentResolver: AgentRunBindingResolver
  private readonly adminResolver: AdministrativeOperationBindingResolver
  private readonly infraResolver: InfrastructureWorkloadBindingResolver
  private readonly agentAppender: AgentAppender
  private readonly adminAppender: AdminAppender
  private readonly infraAppender: InfraAppender

  constructor(private readonly dependencies: RouteTracingSubmissionServiceDependencies) {
    this.agentResolver = dependencies.agentRunBindingResolver ?? failClosedAgentResolver
    this.adminResolver =
      dependencies.administrativeOperationBindingResolver ?? failClosedAdminResolver
    this.infraResolver =
      dependencies.infrastructureWorkloadBindingResolver ?? failClosedInfraResolver
    this.agentAppender =
      dependencies.agentRunEventAppender ?? new AgentRunEventService(dependencies)
    this.adminAppender =
      dependencies.administrativeEventAppender ?? new AdministrativeEventService(dependencies)
    this.infraAppender =
      dependencies.infrastructureTelemetryAppender ??
      new InfrastructureTelemetryEventService(dependencies)
  }

  submit(input: AgentSubmission): Promise<TracingSubmissionResult>
  submit(input: AdminSubmission): Promise<TracingSubmissionResult>
  submit(input: InfraSubmission): Promise<TracingSubmissionResult>
  async submit(input: AnySubmission): Promise<TracingSubmissionResult> {
    const startedAt = process.hrtime.bigint()
    const metrics = metricEvents(input)
    const source = metricSource(input)
    governedTraceBatchSize.observe({ family: metrics.family, source }, metrics.events.length)
    try {
      const result = await withTracingQueryMeter(metrics.family, source, () =>
        isAgent(input)
          ? this.submitAgent(input)
          : isAdmin(input)
            ? this.submitAdmin(input)
            : this.submitInfra(input)
      )
      return result
    } catch (error) {
      const reason = rejectionReason(error)
      recordGovernedTraceOperationalError(metrics.family, reason)
      for (const event of metrics.events) {
        governedTraceRejectedTotal.inc({ family: metrics.family, source, type: event.type })
      }
      if (reason === 'idempotency_conflict' && error instanceof TracingIdempotencyConflictError) {
        const conflictingEvent = metrics.events.find(
          event => event.sourceEventId === error.sourceEventId
        )
        if (conflictingEvent) {
          governedTraceConflictingTotal.inc({
            family: metrics.family,
            source,
            type: conflictingEvent.type,
          })
        }
      }
      throw error
    } finally {
      governedTraceIngestDurationSeconds.observe(
        { family: metrics.family, source },
        elapsedSeconds(startedAt)
      )
    }
  }

  private async submitAgent(input: AgentSubmission): Promise<TracingSubmissionResult> {
    requireEvents(input.events)
    const events = input.events.map(normalizeAgent)
    const bindings = await resolveTrustedBindings({
      resolver: this.agentResolver,
      principal: input.principal,
      events,
      bindingKind: 'run',
    })
    const results = await this.appendWithQueryMetrics(db =>
      this.agentAppender.appendManyInTransaction(
        db,
        input.principal,
        events.map((event, index) => ({
          binding: bindings[index]!,
          input: appendableAgentInput(event),
        }))
      )
    )
    return this.recordAppendResults('agent_run', input.principal.sourceService, events, results)
  }

  private async submitAdmin(input: AdminSubmission): Promise<TracingSubmissionResult> {
    requireEvents(input.events)
    const events = input.events.map(normalizeAdmin)
    const bindings = await resolveTrustedBindings({
      resolver: this.adminResolver,
      principal: input.principal,
      events,
      bindingKind: 'operation',
    })
    const results = await this.appendWithQueryMetrics(db =>
      this.adminAppender.appendManyInTransaction(
        db,
        input.principal,
        events.map((event, index) => ({ binding: bindings[index]!, input: event }))
      )
    )
    return this.recordAppendResults(
      'administrative',
      input.principal.sourceService,
      events,
      results
    )
  }

  private async submitInfra(input: InfraSubmission): Promise<TracingSubmissionResult> {
    requireEvents(input.events)
    const events = input.events.map(normalizeInfra)
    const bindings = await resolveTrustedBindings({
      resolver: this.infraResolver,
      principal: input.principal,
      events,
      bindingKind: 'workload',
    })
    const results = await this.appendWithQueryMetrics(db =>
      this.infraAppender.appendManyInTransaction(
        db,
        input.principal,
        events.map((event, index) => ({ binding: bindings[index]!, input: event }))
      )
    )
    return this.recordAppendResults(
      'infrastructure_telemetry',
      input.principal.sourceService,
      events,
      results
    )
  }

  private recordAppendResults(
    family: GovernedEventFamily,
    source: MetricSource,
    events: readonly { eventType?: string; kind?: string; telemetryType?: string }[],
    results: readonly GovernedAppendResult[]
  ): TracingSubmissionResult {
    if (events.length !== results.length) {
      throw new Error('tracing append returned an unexpected batch size')
    }
    const total = { accepted: 0, replayed: 0 }
    for (const [index, result] of results.entries()) {
      const event = events[index]!
      const type = event.eventType ?? event.kind ?? event.telemetryType ?? 'invalid'
      if (result.accepted) {
        governedTraceAcceptedTotal.inc({ family, source, type }, result.accepted)
      }
      if (result.replayed) {
        governedTraceReplayedTotal.inc({ family, source, type }, result.replayed)
      }
      total.accepted += result.accepted
      total.replayed += result.replayed
    }
    return total
  }

  private appendWithQueryMetrics<T>(work: (db: DbClient) => Promise<T>): Promise<T> {
    return this.dependencies.transaction(db => work(meterTracingDbClient(db)))
  }
}
