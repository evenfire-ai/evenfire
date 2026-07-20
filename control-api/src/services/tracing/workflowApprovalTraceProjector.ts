import { createHash } from 'node:crypto'
import type { DbClient } from '../../db.js'
import { rootLogger } from '../../observability/logger.js'
import { AgentRunEventService } from './agentRunEvents.js'
import type { ControlApiLocalAgentRunPrincipalV1 } from './agentRunEvents.js'
import type { AgentRunEventInputV1, AgentRunServerBindingV1 } from './contracts.js'
import { canonicalTracingEnvironment } from './environment.js'
import { withTraceIngestTransaction } from './pools.js'

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_BATCH_SIZE = 100
const MAX_QUEUED_IDS = 1_024

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ApprovalRow = {
  id: string
  status: string
  requestedAt: string | Date
  decidedAt: string | Date | null
  decidedByUserId: string | null
  decisionMaker: unknown
  boundWorkflowRunId: string | null
  boundWorkflowStepId: string | null
  recipeNamespace: string
  recipeName: string
}

type RunBindingRow = {
  actorId: string | null
  actorType: string
  teamId: string | null
  usageTeamId: string | null
  rootSpanId: string
}

export class WorkflowApprovalTracePendingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowApprovalTracePendingError'
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return {}
}

function iso(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('approval timestamp is invalid')
  return parsed.toISOString()
}

function spanId(runId: string, requestId: string, transition: string): string {
  return createHash('sha256')
    .update(`workflow-approval:${runId}:${requestId}:${transition}`)
    .digest('hex')
}

const principal: ControlApiLocalAgentRunPrincipalV1 = {
  kind: 'control_api_local',
  sourceService: 'control-api',
  serviceSub: 'workflow-approval-trace-projector',
  credentialId: 'in-process',
  allowedEventTypes: ['approval'],
}

function decisionActor(row: ApprovalRow): string | null {
  if (row.decidedByUserId) return row.decidedByUserId
  const candidate = objectValue(row.decisionMaker).userId
  return typeof candidate === 'string' && candidate.trim() ? candidate : null
}

async function loadApproval(db: DbClient, requestId: string): Promise<ApprovalRow | null> {
  const result = await db.query(
    `SELECT id::text,
            status,
            requested_at AS "requestedAt",
            decided_at AS "decidedAt",
            decided_by_user_id::text AS "decidedByUserId",
            decision_maker AS "decisionMaker",
            bound_workflow_run_id::text AS "boundWorkflowRunId",
            bound_workflow_step_id AS "boundWorkflowStepId",
            recipe_namespace AS "recipeNamespace",
            recipe_name AS "recipeName"
       FROM workflow_approval_requests
      WHERE id = $1::uuid`,
    [requestId]
  )
  return (result.rows[0] as ApprovalRow | undefined) ?? null
}

async function loadRunBinding(
  db: DbClient,
  row: ApprovalRow,
  runId: string
): Promise<RunBindingRow | null> {
  const result = await db.query(
    `SELECT wr.actor_id AS "actorId",
            wr.actor_type AS "actorType",
            wr.team_id::text AS "teamId",
            wr.usage_team_id AS "usageTeamId",
            root.span_id AS "rootSpanId"
       FROM workflow_runs wr
       JOIN agent_run_events root
         ON root.run_id = wr.run_id
        AND root.event_type = 'run_start'
        AND root.origin = 'workflow_runtime'
        AND root.source_kind = 'wrc_internal_control'
        AND root.source_service = 'workflow-recipes'
      WHERE wr.run_id = $1::uuid
        AND wr.recipe_namespace = $2
        AND wr.recipe_name = $3
      ORDER BY root.ingest_sequence ASC
      LIMIT 1`,
    [runId, row.recipeNamespace, row.recipeName]
  )
  return (result.rows[0] as RunBindingRow | undefined) ?? null
}

function projectionEntries(
  row: ApprovalRow,
  runId: string,
  stepId: string,
  run: RunBindingRow
): Array<{ binding: AgentRunServerBindingV1; input: AgentRunEventInputV1 }> {
  const initiatingHuman = ['user', 'admin'].includes(run.actorType) ? run.actorId : null
  const environment = canonicalTracingEnvironment()
  const baseBinding = {
    runId,
    sessionId: null,
    parentSpanId: run.rootSpanId,
    origin: 'workflow_runtime' as const,
    identityIssuer: null,
    actorHumanSub: initiatingHuman,
    agentSub: `workflow-recipe:${row.recipeNamespace}/${row.recipeName}`,
    actorMedium: 'workflow',
    resourceAud: null,
    effectiveScopes: [] as const,
    approvalRequestId: row.id,
    tokenExchangeId: null,
    environment,
    tenantId: null,
    teamId: run.usageTeamId ?? run.teamId,
    userId: initiatingHuman,
    recipeNamespace: row.recipeNamespace,
    recipeName: row.recipeName,
    hostRef: null,
    durationMs: null,
  }
  const detailRef = `workflow-step:${stepId}`
  const sourceRef = `workflow_approval_requests:${row.id}`
  const entries: Array<{ binding: AgentRunServerBindingV1; input: AgentRunEventInputV1 }> = [
    {
      binding: {
        ...baseBinding,
        spanId: spanId(runId, row.id, 'requested'),
        outcome: 'unknown',
        decision: 'require_approval',
        decisionSourceKind: 'approval_request',
        decisionSourceRef: sourceRef,
        decisionActorSub: null,
      },
      input: {
        sourceEventId: `workflow-approval:${row.id}:requested`,
        occurredAt: iso(row.requestedAt),
        eventType: 'approval',
        payload: { status: 'requested', detail_ref: detailRef },
      },
    },
  ]

  if ((row.status === 'approved' || row.status === 'denied') && row.decidedAt) {
    entries.push({
      binding: {
        ...baseBinding,
        spanId: spanId(runId, row.id, row.status),
        outcome: row.status,
        decision: row.status === 'approved' ? 'allow' : 'deny',
        decisionSourceKind: 'approval_resolution',
        decisionSourceRef: sourceRef,
        decisionActorSub: decisionActor(row),
      },
      input: {
        sourceEventId: `workflow-approval:${row.id}:${row.status}`,
        occurredAt: iso(row.decidedAt),
        eventType: 'approval',
        payload: { status: row.status, detail_ref: detailRef },
      },
    })
  }
  return entries
}

export async function projectWorkflowApprovalTraceInTransaction(
  db: DbClient,
  requestId: string,
  appendEntries: (
    db: DbClient,
    entries: Array<{ binding: AgentRunServerBindingV1; input: AgentRunEventInputV1 }>
  ) => Promise<void> = async (client, entries) => {
    const service = new AgentRunEventService({
      transaction: async () => {
        throw new Error('workflow approval projection requires caller transaction')
      },
    })
    await service.appendManyInTransaction(client, principal, entries)
  }
): Promise<number> {
  if (!UUID_PATTERN.test(requestId)) return 0
  const approval = await loadApproval(db, requestId)
  if (!approval) return 0
  const runId = approval.boundWorkflowRunId?.toLowerCase() ?? null
  const stepId = approval.boundWorkflowStepId?.trim() ?? ''
  if (!runId || !stepId) return 0
  const run = await loadRunBinding(db, approval, runId)
  if (!run) {
    throw new WorkflowApprovalTracePendingError(
      `workflow root is not available for approval ${requestId}`
    )
  }
  const entries = projectionEntries(approval, runId, stepId, run)
  await appendEntries(db, entries)
  return entries.length
}

export function projectWorkflowApprovalTrace(requestId: string): Promise<number> {
  return withTraceIngestTransaction(db => projectWorkflowApprovalTraceInTransaction(db, requestId))
}

let started = false
let running = false
let timer: ReturnType<typeof setInterval> | undefined
let scanAfterId = ''
const queuedIds = new Set<string>()

export function enqueueWorkflowApprovalTraceProjection(requestId: string): void {
  if (!started || !UUID_PATTERN.test(requestId)) return
  if (queuedIds.size >= MAX_QUEUED_IDS && !queuedIds.has(requestId)) {
    rootLogger.warn({ event: 'workflow_approval_trace_queue_full' }, 'approval trace gap recorded')
    return
  }
  queuedIds.add(requestId)
  queueMicrotask(() => void wake())
}

async function scanMissingApprovalIds(limit: number): Promise<string[]> {
  return withTraceIngestTransaction(async db => {
    const scan = (afterId: string) =>
      db.query(
        `SELECT approval.id::text
         FROM workflow_approval_requests approval
         JOIN workflow_runs run
           ON run.run_id = approval.bound_workflow_run_id
          AND run.recipe_namespace = approval.recipe_namespace
          AND run.recipe_name = approval.recipe_name
         JOIN agent_run_events root
           ON root.run_id = run.run_id
          AND root.event_type = 'run_start'
          AND root.origin = 'workflow_runtime'
          AND root.source_kind = 'wrc_internal_control'
          AND root.source_service = 'workflow-recipes'
        WHERE approval.bound_workflow_run_id IS NOT NULL
          AND NULLIF(BTRIM(approval.bound_workflow_step_id), '') IS NOT NULL
          AND approval.id::text > $1
          AND (
            NOT EXISTS (
              SELECT 1 FROM agent_run_events event
               WHERE event.source_kind = 'control_api_local'
                 AND event.source_service = 'control-api'
                 AND event.source_event_id = 'workflow-approval:' || approval.id::text || ':requested'
            )
            OR (
              approval.status IN ('approved', 'denied')
              AND NOT EXISTS (
                SELECT 1 FROM agent_run_events event
                 WHERE event.source_kind = 'control_api_local'
                   AND event.source_service = 'control-api'
                   AND event.source_event_id = 'workflow-approval:' || approval.id::text || ':' || approval.status
              )
            )
          )
        ORDER BY approval.id::text ASC
        LIMIT $2`,
        [afterId, limit]
      )
    let result = await scan(scanAfterId)
    if (result.rows.length === 0 && scanAfterId) {
      scanAfterId = ''
      result = await scan(scanAfterId)
    }
    const ids = result.rows.map(row => String((row as { id: unknown }).id))
    if (ids.length > 0) scanAfterId = ids.at(-1)!
    return ids
  })
}

async function wake(): Promise<void> {
  if (!started || running) return
  running = true
  try {
    const scanned = await scanMissingApprovalIds(DEFAULT_BATCH_SIZE)
    const ids = [...new Set([...scanned, ...queuedIds])].slice(0, DEFAULT_BATCH_SIZE)
    ids.forEach(id => queuedIds.delete(id))
    for (const id of ids) {
      try {
        await projectWorkflowApprovalTrace(id)
      } catch (error) {
        if (error instanceof WorkflowApprovalTracePendingError) queuedIds.add(id)
        else rootLogger.warn({ error, approvalRequestId: id }, 'approval trace projection failed')
      }
    }
  } catch (error) {
    rootLogger.warn({ error }, 'approval trace projection scan failed')
  } finally {
    running = false
  }
}

export function startWorkflowApprovalTraceProjector(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (started) return
  started = true
  timer = setInterval(() => void wake(), intervalMs)
  timer.unref?.()
  void wake()
}

export function stopWorkflowApprovalTraceProjector(): void {
  started = false
  running = false
  scanAfterId = ''
  queuedIds.clear()
  if (timer) clearInterval(timer)
  timer = undefined
}
