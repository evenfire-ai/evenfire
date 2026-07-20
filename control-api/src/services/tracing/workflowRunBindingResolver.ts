import { createHash } from 'node:crypto'
import type { DbClient } from '../../db.js'
import type { AgentRunEventSubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
import {
  type WorkflowRunBinding,
  WorkflowRunBindingRepository,
} from '../workflowRunBindingRepository.js'
import type { AgentRunServerBindingV1, WorkflowAgentRunEventInputV1 } from './contracts.js'
import { canonicalTracingEnvironment } from './environment.js'
import type { AgentRunBindingResolver } from './routeSubmissionService.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Canceled'])
const ACTOR_TYPES = new Set(['user', 'admin', 'autonomous', 'scheduled'])
const TASK_EVENT_SOURCE =
  /^task:([^:]{1,128}):(start|end|llm:[^:]+|tool:[^:]+|approval:[^:]+:[^:]+)$/

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000') ? value : null
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : nonEmptyString(value)
}

function timestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function durationMs(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 86_400_000 ? parsed : null
}

function spanId(runId: string, kind: 'root' | 'end'): string {
  return createHash('sha256').update(`workflow-run:${runId}:${kind}`).digest('hex')
}

function terminalOutcome(phase: string): AgentRunServerBindingV1['outcome'] | null {
  if (phase === 'Succeeded') return 'succeeded'
  if (phase === 'Failed') return 'failed'
  if (phase === 'Canceled') return 'cancelled'
  return null
}

export class WorkflowRunBindingResolver implements AgentRunBindingResolver {
  private readonly workflowRunBindings: WorkflowRunBindingRepository

  constructor(
    db: Pick<DbClient, 'query'>,
    private readonly environment = canonicalTracingEnvironment()
  ) {
    this.workflowRunBindings = new WorkflowRunBindingRepository(db)
  }

  async resolve(
    principal: AgentRunEventSubmitterPrincipalV1,
    event: WorkflowAgentRunEventInputV1
  ): Promise<AgentRunServerBindingV1 | null> {
    return (await this.resolveMany(principal, [event]))[0] ?? null
  }

  async resolveMany(
    principal: AgentRunEventSubmitterPrincipalV1,
    events: readonly WorkflowAgentRunEventInputV1[]
  ): Promise<readonly (AgentRunServerBindingV1 | null)[]> {
    if (principal.kind !== 'wrc_internal_control') return events.map(() => null)

    const runIds = events
      .map(event => event.runId)
      .filter(runId => UUID_PATTERN.test(runId))
      .map(runId => runId.toLowerCase())
    const bindings = await this.workflowRunBindings.resolveMany(runIds)

    return events.map(event => {
      if (!UUID_PATTERN.test(event.runId)) return null
      const runId = event.runId.toLowerCase()
      const binding = bindings.get(runId)
      return binding ? this.bindingFromRow(binding, runId, event.eventType) : null
    })
  }

  private bindingFromRow(
    row: WorkflowRunBinding,
    runId: string,
    eventType: WorkflowAgentRunEventInputV1['eventType']
  ): AgentRunServerBindingV1 | null {
    if (nullableString(row.runId)?.toLowerCase() !== runId) return null

    const recipeNamespace = nonEmptyString(row.recipeNamespace)
    const recipeName = nonEmptyString(row.recipeName)
    const phase = nonEmptyString(row.phase)
    const actorType = nonEmptyString(row.actorType)
    const startedAt = timestamp(row.startedAt)
    const completedAt = timestamp(row.completedAt)
    if (!recipeNamespace || !recipeName || !phase || !actorType || !ACTOR_TYPES.has(actorType)) {
      return null
    }

    const resolvedActorId = nullableString(row.actorId)
    if ((actorType === 'user' || actorType === 'admin') && !resolvedActorId) return null

    const rootSpanId = spanId(runId, 'root')
    let outcome: AgentRunServerBindingV1['outcome']
    let resolvedDurationMs: number | null = null
    if (eventType === 'run_start') {
      if (!startedAt || phase === 'Pending') return null
      outcome = 'started'
    } else if (eventType === 'run_end') {
      outcome = terminalOutcome(phase) ?? 'unknown'
      if (!TERMINAL_PHASES.has(phase) || !completedAt || outcome === 'unknown') return null
      resolvedDurationMs = durationMs(row.durationMs)
    } else {
      return null
    }

    return {
      runId,
      sessionId: null,
      spanId: eventType === 'run_start' ? rootSpanId : spanId(runId, 'end'),
      parentSpanId: eventType === 'run_start' ? null : rootSpanId,
      origin: 'workflow_runtime',
      identityIssuer: null,
      actorHumanSub: resolvedActorId,
      agentSub: `workflow-recipe:${recipeNamespace}/${recipeName}`,
      actorMedium: 'workflow',
      resourceAud: null,
      effectiveScopes: [],
      decision: 'not_applicable',
      decisionSourceKind: null,
      decisionSourceRef: null,
      approvalRequestId: nullableString(row.approvalRequestId),
      tokenExchangeId: null,
      environment: this.environment,
      tenantId: null,
      teamId: nullableString(row.usageTeamId) ?? nullableString(row.teamId),
      userId: resolvedActorId,
      recipeNamespace,
      recipeName,
      hostRef: null,
      outcome,
      durationMs: resolvedDurationMs,
    }
  }
}

export interface AuthoritativeHostReader {
  getResource(plural: 'hosts', name: string, namespace: string): Promise<unknown>
}

function hostIdentity(
  principal: Extract<AgentRunEventSubmitterPrincipalV1, { kind: 'mcp_host_runtime' }>,
  hostRef: string
): { name: string; namespace: string } | null {
  const segments = hostRef.split('/')
  if (segments.length === 1) {
    return nonEmptyString(segments[0])
      ? { name: segments[0]!, namespace: principal.recipeNamespace }
      : null
  }
  if (segments.length !== 2 || !nonEmptyString(segments[0]) || !nonEmptyString(segments[1])) {
    return null
  }
  return { namespace: segments[0]!, name: segments[1]! }
}

function directOutcome(event: WorkflowAgentRunEventInputV1): AgentRunServerBindingV1['outcome'] {
  if (event.eventType === 'run_start') return 'started'
  if (event.eventType === 'approval') {
    if (event.payload?.status === 'approved') return 'approved'
    if (event.payload?.status === 'denied') return 'denied'
  }
  if (event.payload?.status === 'cancelled') return 'cancelled'
  if (event.payload?.status === 'failed' || event.payload?.error_class) return 'failed'
  return 'succeeded'
}

function directApprovalStatus(
  event: WorkflowAgentRunEventInputV1
): 'requested' | 'approved' | 'denied' | null {
  if (event.eventType !== 'approval') return null
  if (!event.approvalRequestId || !UUID_PATTERN.test(event.approvalRequestId)) return null
  const source = /:approval:([^:]+):(requested|approved|denied)$/.exec(event.sourceEventId)
  if (source?.[1]?.toLowerCase() !== event.approvalRequestId.toLowerCase()) return null
  const sourceStatus = source[2]
  const payloadStatus = event.payload?.status
  return sourceStatus && payloadStatus === sourceStatus
    ? (sourceStatus as 'requested' | 'approved' | 'denied')
    : null
}

export class HostReferencedRunBindingResolver implements AgentRunBindingResolver {
  constructor(
    private readonly hostReader: AuthoritativeHostReader,
    private readonly db: Pick<DbClient, 'query'>,
    private readonly environment = canonicalTracingEnvironment()
  ) {}

  async resolve(
    principal: AgentRunEventSubmitterPrincipalV1,
    event: WorkflowAgentRunEventInputV1
  ): Promise<AgentRunServerBindingV1 | null> {
    return (await this.resolveMany(principal, [event]))[0] ?? null
  }

  async resolveMany(
    principal: AgentRunEventSubmitterPrincipalV1,
    events: readonly WorkflowAgentRunEventInputV1[]
  ): Promise<readonly (AgentRunServerBindingV1 | null)[]> {
    if (principal.kind !== 'mcp_host_runtime') return events.map(() => null)
    const structurallyValid = events.map(
      event =>
        UUID_PATTERN.test(event.runId) &&
        Boolean(event.origin) &&
        Boolean(event.hostRef) &&
        principal.hostRefs.includes(event.hostRef!) &&
        hostIdentity(principal, event.hostRef!) !== null &&
        TASK_EVENT_SOURCE.test(event.sourceEventId)
    )
    if (!structurallyValid.some(Boolean)) return events.map(() => null)
    const runIds = [
      ...new Set(
        events
          .filter((_, index) => structurallyValid[index])
          .map(event => event.runId.toLowerCase())
      ),
    ]
    const directBindingRows = await this.db.query(
      `SELECT run_id::text, host_ref, session_id, origin, identity_issuer,
              actor_human_sub, user_id::text, team_id::text
         FROM governed_run_attribution_bindings
        WHERE run_id = ANY($1::uuid[])`,
      [runIds]
    )
    const directBindings = new Map<
      string,
      {
        hostRef: string
        sessionId: string
        origin: string
        identityIssuer: string
        actorHumanSub: string
        userId: string | null
        teamId: string | null
      }
    >()
    for (const row of directBindingRows.rows as Array<Record<string, unknown>>) {
      directBindings.set(String(row.run_id).toLowerCase(), {
        hostRef: String(row.host_ref),
        sessionId: String(row.session_id),
        origin: String(row.origin),
        identityIssuer: String(row.identity_issuer),
        actorHumanSub: String(row.actor_human_sub),
        userId: row.user_id === null ? null : String(row.user_id),
        teamId: row.team_id === null ? null : String(row.team_id),
      })
    }
    const referencedHosts = [
      ...new Set(
        events.filter((_, index) => structurallyValid[index]).map(event => event.hostRef!)
      ),
    ]
    const hosts = new Map<string, unknown>()
    await Promise.all(
      referencedHosts.map(async hostRef => {
        const identity = hostIdentity(principal, hostRef)
        if (!identity) return
        try {
          hosts.set(
            hostRef,
            await this.hostReader.getResource('hosts', identity.name, identity.namespace)
          )
        } catch {
          // An absent or unreadable Host cannot establish tracing authority.
        }
      })
    )
    const parsed = events.map(event => {
      const match = TASK_EVENT_SOURCE.exec(event.sourceEventId)
      return { event, taskId: match?.[1] ?? null, occurrence: match?.[2] ?? null }
    })
    const rootSourceIds = [
      ...new Set(parsed.filter(item => item.taskId).map(item => `task:${item.taskId}:start`)),
    ]
    const existing =
      rootSourceIds.length === 0
        ? { rows: [] }
        : await this.db.query(
            `SELECT source_event_id, run_id::text, host_ref, origin, session_id
             FROM agent_run_events
            WHERE source_service = 'mcp-host'
              AND source_kind = 'mcp_host_runtime'
              AND event_type = 'run_start'
              AND source_event_id = ANY($1::text[])`,
            [rootSourceIds]
          )
    const roots = new Map<
      string,
      { runId: string; hostRef: string | null; origin: string; sessionId: string | null }
    >()
    for (const row of existing.rows as Array<Record<string, unknown>>) {
      roots.set(String(row.source_event_id), {
        runId: String(row.run_id).toLowerCase(),
        hostRef: row.host_ref === null ? null : String(row.host_ref),
        origin: String(row.origin),
        sessionId: row.session_id === null ? null : String(row.session_id),
      })
    }
    for (const item of parsed) {
      if (!item.taskId || item.occurrence !== 'start') continue
      const rootSourceId = `task:${item.taskId}:start`
      const candidate = {
        runId: item.event.runId.toLowerCase(),
        hostRef: item.event.hostRef ?? null,
        origin: item.event.origin ?? '',
        sessionId: item.event.sessionId?.trim() || null,
      }
      const current = roots.get(rootSourceId)
      if (!current) roots.set(rootSourceId, candidate)
    }
    return parsed.map((item, index) => {
      if (!structurallyValid[index]) return null
      if (!item.taskId || !item.occurrence) return null
      const root = roots.get(`task:${item.taskId}:start`)
      if (
        !root ||
        root.runId !== item.event.runId.toLowerCase() ||
        root.hostRef !== (item.event.hostRef ?? null) ||
        root.origin !== item.event.origin ||
        root.sessionId !== (item.event.sessionId?.trim() || null)
      )
        return null
      const host = item.event.hostRef ? hosts.get(item.event.hostRef) : undefined
      const directBinding = directBindings.get(item.event.runId.toLowerCase()) ?? null
      if (
        directBinding &&
        (directBinding.hostRef !== item.event.hostRef ||
          directBinding.sessionId !== (item.event.sessionId?.trim() || null) ||
          directBinding.origin !== item.event.origin)
      ) {
        return null
      }
      return host ? this.resolveWithHost(principal, item.event, host, directBinding) : null
    })
  }

  private resolveWithHost(
    principal: Extract<AgentRunEventSubmitterPrincipalV1, { kind: 'mcp_host_runtime' }>,
    event: WorkflowAgentRunEventInputV1,
    host: unknown,
    directBinding: {
      identityIssuer: string
      actorHumanSub: string
      userId: string | null
      teamId: string | null
    } | null
  ): AgentRunServerBindingV1 | null {
    if (!UUID_PATTERN.test(event.runId) || !event.origin || !event.hostRef) return null
    const hostRef = event.hostRef
    if (!principal.hostRefs.includes(hostRef)) return null
    if (event.eventType === 'approval' && directApprovalStatus(event) === null) return null
    if (
      event.eventType === 'tool_call' &&
      event.approvalRequestId &&
      !UUID_PATTERN.test(event.approvalRequestId)
    ) {
      return null
    }
    const identity = hostIdentity(principal, hostRef)
    if (!identity) return null
    const resource = host as {
      apiVersion?: string
      kind?: string
      metadata?: { name?: string; namespace?: string }
    }
    if (
      resource.apiVersion !== 'clerum.io/v1alpha1' ||
      resource.kind !== 'Host' ||
      resource.metadata?.name !== identity.name ||
      resource.metadata.namespace !== identity.namespace
    )
      return null
    const runId = event.runId.toLowerCase()
    const root = createHash('sha256').update(`host-run:${runId}:root`).digest('hex')
    const resolvedOutcome = directOutcome(event)
    const decision =
      event.eventType === 'approval'
        ? resolvedOutcome === 'approved'
          ? 'allow'
          : resolvedOutcome === 'denied'
            ? 'deny'
            : 'require_approval'
        : 'not_applicable'
    return {
      runId,
      sessionId: event.sessionId?.trim() || null,
      spanId:
        event.eventType === 'run_start'
          ? root
          : createHash('sha256').update(`host-run:${runId}:${event.sourceEventId}`).digest('hex'),
      parentSpanId: event.eventType === 'run_start' ? null : root,
      origin: event.origin,
      identityIssuer: directBinding?.identityIssuer ?? null,
      actorHumanSub: directBinding?.actorHumanSub ?? null,
      agentSub: `mcp-host:${hostRef}`,
      actorMedium:
        event.origin === 'channel_event'
          ? 'channel'
          : event.origin === 'direct_chat'
            ? 'desktop'
            : 'api',
      resourceAud: null,
      effectiveScopes: [],
      decision,
      // mcp-host emits this only after its authenticated legacy approval gate
      // validates the bound user/channel and applies the local state transition.
      // Native control-plane approvals use approval_resolution instead.
      decisionSourceKind: event.eventType === 'approval' ? 'legacy_gate' : null,
      decisionSourceRef: event.eventType === 'approval' ? event.sourceEventId : null,
      decisionActorSub:
        event.eventType === 'approval' &&
        (resolvedOutcome === 'approved' || resolvedOutcome === 'denied')
          ? (directBinding?.actorHumanSub ?? null)
          : null,
      approvalRequestId:
        (event.eventType === 'approval' || event.eventType === 'tool_call') &&
        event.approvalRequestId
          ? event.approvalRequestId.toLowerCase()
          : null,
      tokenExchangeId: null,
      environment: this.environment,
      tenantId: null,
      teamId: directBinding?.teamId ?? null,
      userId: directBinding?.userId ?? null,
      recipeNamespace: principal.recipeNamespace,
      recipeName: principal.recipeName,
      hostRef,
      outcome: resolvedOutcome,
      durationMs: null,
    }
  }
}

export class AgentRunBindingResolverChain implements AgentRunBindingResolver {
  constructor(private readonly resolvers: readonly AgentRunBindingResolver[]) {}

  async resolve(principal: AgentRunEventSubmitterPrincipalV1, event: WorkflowAgentRunEventInputV1) {
    return (await this.resolveMany(principal, [event]))[0] ?? null
  }

  async resolveMany(
    principal: AgentRunEventSubmitterPrincipalV1,
    events: readonly WorkflowAgentRunEventInputV1[]
  ): Promise<readonly (AgentRunServerBindingV1 | null | undefined)[]> {
    const unresolved = new Set(events.map((_, index) => index))
    const results: Array<AgentRunServerBindingV1 | null> = events.map(() => null)
    for (const resolver of this.resolvers) {
      if (unresolved.size === 0) break
      const pendingIndexes = [...unresolved]
      const pendingEvents = pendingIndexes.map(index => events[index]!)
      const resolved = resolver.resolveMany
        ? await resolver.resolveMany(principal, pendingEvents)
        : await Promise.all(pendingEvents.map(event => resolver.resolve(principal, event)))
      if (resolved.length !== pendingEvents.length)
        throw new Error('binding resolver batch mismatch')
      resolved.forEach((binding, offset) => {
        if (!binding) return
        const index = pendingIndexes[offset]!
        results[index] = binding
        unresolved.delete(index)
      })
    }
    return results
  }
}
