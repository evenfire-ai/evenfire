import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { type DbClient, pool, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  approvalsCancelledTotal,
  approvalsCreatedTotal,
  approvalsDecidedTotal,
  approvalsDurationSeconds,
  approvalsExpiredTotal,
} from '../observability/metrics.js'
import { stableStringify } from '../utils/stableStringify.js'
import {
  enqueueApprovalRequestedNotification,
  enqueueApprovalUpdatedNotification,
} from './notificationEmitter.js'
import { ApprovalPromptHistoryService } from './tracing/approvalPromptHistoryService.js'
import { enqueueWorkflowApprovalTraceProjection } from './tracing/workflowApprovalTraceProjector.js'
import type { WorkflowRunActorType, WorkflowRunRow } from './workflowRunService.js'
import {
  type WorkflowTriggerGrantResult,
  resolveWorkflowTriggerGrant,
} from './workflows/workflowTriggerGrantResolver.js'

export {
  resolveWorkflowTriggerGrant,
  type WorkflowTriggerGrantMode,
  type WorkflowTriggerGrantResult,
} from './workflows/workflowTriggerGrantResolver.js'

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'consumed'

export type ApprovalConsumeErrorCode =
  | 'approval_request_not_found'
  | 'approval_recipe_mismatch'
  | 'approval_expired'
  | 'approval_trigger_binding_mismatch'
  | 'approval_target_user_mismatch'
  | 'approval_requester_mismatch'
  | 'approval_target_missing'
  | 'approval_trigger_grant_missing'
  | 'approval_target_not_allowed'
  | 'approval_team_decider_not_active'
  | 'approval_status_not_consumable'

export class ApprovalConsumeError extends Error {
  constructor(
    readonly code: ApprovalConsumeErrorCode,
    message: string,
    readonly approvalStatus?: ApprovalStatus
  ) {
    super(message)
    this.name = 'ApprovalConsumeError'
  }
}

export class InvalidWorkflowTriggerIntentError extends Error {
  constructor(message = 'Invalid payload.metadata.workflowTrigger') {
    super(message)
    this.name = 'InvalidWorkflowTriggerIntentError'
  }
}

export class InvalidWorkflowApprovalRunBindingError extends Error {
  constructor(message = 'Workflow approval run binding is not authoritative') {
    super(message)
    this.name = 'InvalidWorkflowApprovalRunBindingError'
  }
}

export class ApprovalTriggerRunIdempotencyConflictError extends Error {
  constructor(message = 'Approved workflow trigger intent conflicts with an existing run') {
    super(message)
    this.name = 'ApprovalTriggerRunIdempotencyConflictError'
  }
}

export type ApprovalPayload = { message: string; options?: string[]; metadata?: unknown }

const WORKFLOW_RUN_ID_PREFIX =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=:)/i
const WORKFLOW_BINDING_PROOF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORKFLOW_CHILD_RECIPE_NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/

export async function resolveWorkflowApprovalRunBinding(
  db: DbClient,
  params: {
    recipeNamespace: string
    recipeName: string
    correlation?: { taskId?: string; stepId?: string }
    runBindingProof?: string
  }
): Promise<{ runId: string; stepId: string } | null> {
  const proof = params.runBindingProof?.trim()
  const taskId = params.correlation?.taskId
  if (typeof taskId !== 'string' || !WORKFLOW_RUN_ID_PREFIX.test(taskId)) {
    if (proof) throw new InvalidWorkflowApprovalRunBindingError()
    return null
  }
  const runId = WORKFLOW_RUN_ID_PREFIX.exec(taskId)?.[1]?.toLowerCase()
  const childRecipeName = taskId.split(':', 3)[1]?.trim()
  const stepId = params.correlation?.stepId?.trim()
  if (
    !runId ||
    !childRecipeName ||
    !WORKFLOW_CHILD_RECIPE_NAME.test(childRecipeName) ||
    !stepId ||
    !proof ||
    !WORKFLOW_BINDING_PROOF.test(proof)
  ) {
    throw new InvalidWorkflowApprovalRunBindingError()
  }
  const proofSha256 = createHash('sha256').update(proof).digest('hex')
  const result = await db.query(
    `SELECT wr.run_id::text AS "runId", step.step_id AS "stepId"
       FROM workflow_runs wr
       JOIN workflow_run_steps step
         ON step.run_id = wr.run_id
        AND step.step_id = $4
        AND step.phase = 'Running'
        AND step.approval_binding_sha256 = $5
       JOIN agent_run_events root
         ON root.run_id = wr.run_id
        AND root.event_type = 'run_start'
        AND root.origin = 'workflow_runtime'
        AND root.source_kind = 'wrc_internal_control'
        AND root.source_service = 'workflow-recipes'
      WHERE wr.run_id = $1::uuid
        AND wr.recipe_namespace = $2
        AND wr.recipe_name = $3
        AND wr.child_recipe_namespace = $2
        AND wr.child_recipe_name = $6
        AND wr.phase = 'Running'
      LIMIT 1`,
    [runId, params.recipeNamespace, params.recipeName, stepId, proofSha256, childRecipeName]
  )
  if (!result.rows[0]) throw new InvalidWorkflowApprovalRunBindingError()
  return { runId, stepId }
}
export type WorkflowTriggerIntent = {
  namespace: string
  name: string
  caller: string
  requesterUserId?: string
}
export type DecisionMaker = {
  userId: string
  teamId?: string | null
  note?: string | null
  decidedAt: string
}
export type ApprovalCorrelation = { taskId?: string; stepId?: string }
export type PendingApprovalSummary = {
  id: string
  recipeNamespace: string
  recipeName: string
  requestedAt: string
  expiresAt: string
  payload: ApprovalPayload
  correlation: ApprovalCorrelation | null
  target: {
    userId: string | null
    teamId: string | null
    teamName: string | null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function rawWorkflowTriggerIntent(payload: unknown): unknown {
  const record = asRecord(payload)
  const metadata = asRecord(record?.metadata)
  return metadata?.workflowTrigger
}

function hasWorkflowTriggerIntent(payload: unknown): boolean {
  return rawWorkflowTriggerIntent(payload) !== undefined
}

export function parseWorkflowTriggerIntent(payload: unknown): WorkflowTriggerIntent | null {
  const workflowTrigger = asRecord(rawWorkflowTriggerIntent(payload))
  if (!workflowTrigger) return null
  const namespace =
    typeof workflowTrigger.namespace === 'string' ? workflowTrigger.namespace.trim() : ''
  const name = typeof workflowTrigger.name === 'string' ? workflowTrigger.name.trim() : ''
  const caller = typeof workflowTrigger.caller === 'string' ? workflowTrigger.caller.trim() : ''
  const requesterUserId =
    typeof workflowTrigger.requesterUserId === 'string'
      ? workflowTrigger.requesterUserId.trim()
      : ''
  if (!namespace || !name || !caller) return null
  return { namespace, name, caller, ...(requesterUserId ? { requesterUserId } : {}) }
}

export type ApprovalRequest = {
  id: string
  recipeNamespace: string
  recipeName: string
  requestedAt: string
  expiresAt: string
  status: ApprovalStatus
  targetUserId: string | null
  targetTeamId: string | null
  payload: ApprovalPayload
  decisionMaker: DecisionMaker | null
  idempotencyKey: string
  correlation: ApprovalCorrelation | null
}

export async function allowlistCheck(
  recipeNamespace: string,
  recipeName: string,
  targetUserId: string | undefined,
  targetTeamId: string | undefined
): Promise<boolean> {
  if (targetUserId) {
    const result = await pool.query(
      `SELECT 1 FROM user_workflow_triggers
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND user_id = $3`,
      [recipeNamespace, recipeName, targetUserId]
    )
    return (result.rowCount ?? 0) > 0
  }
  if (targetTeamId) {
    const result = await pool.query(
      `SELECT 1 FROM workflow_recipe_allowed_teams
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND team_id = $3`,
      [recipeNamespace, recipeName, targetTeamId]
    )
    return (result.rowCount ?? 0) > 0
  }
  return false
}

export async function triggerGrantCheck(
  recipeNamespace: string,
  recipeName: string,
  targetUserId: string | undefined,
  targetTeamId: string | undefined
): Promise<boolean> {
  if (targetUserId) {
    const result = await resolveWorkflowTriggerGrant({
      userId: targetUserId,
      recipeNamespace,
      recipeName,
      mode: 'approval-target-user',
    })
    return result.granted
  }
  if (targetTeamId) {
    const result = await pool.query(
      `SELECT 1 FROM team_workflow_triggers
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND team_id = $3`,
      [recipeNamespace, recipeName, targetTeamId]
    )
    return (result.rowCount ?? 0) > 0
  }
  return false
}

/**
 * Canonical payload hash — stable across JSON key ordering so semantically-equal
 * requests collapse to a single idempotent row, but any meaningful change
 * (target switch, message edit, correlation tweak, TTL bump) produces a
 * different hash and triggers the payload-mismatch guard.
 */
export function computePayloadHash(params: {
  targetUserId?: string
  targetTeamId?: string
  payload: unknown
  correlation?: unknown
  ttlSeconds?: number
}): string {
  const canonical = stableStringify({
    targetUserId: params.targetUserId ?? null,
    targetTeamId: params.targetTeamId ?? null,
    payload: params.payload,
    correlation: params.correlation ?? null,
    ttlSeconds: params.ttlSeconds ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export async function createApprovalRequest(params: {
  recipeNamespace: string
  recipeName: string
  targetUserId?: string
  targetTeamId?: string
  payload: { message: string; options?: string[]; metadata?: unknown }
  idempotencyKey: string
  correlation?: { taskId?: string; stepId?: string }
  runBindingProof?: string
  ttlSeconds?: number
}): Promise<
  | { id: string; status: 'pending'; expiresAt: string }
  | { id: string; status: ApprovalStatus; existing: true }
  | { mismatch: true; existingId: string; existingStatus: ApprovalStatus }
> {
  const ttl = params.ttlSeconds ?? config.userApprovalRequestDefaultTtlSec

  const ttlSeconds = Number(ttl)
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`Invalid TTL: ${ttl}`)
  }

  const payloadHash = computePayloadHash({
    targetUserId: params.targetUserId,
    targetTeamId: params.targetTeamId,
    payload: params.payload,
    correlation: params.correlation,
    ttlSeconds,
  })

  const triggerIntent = parseWorkflowTriggerIntent(params.payload)
  if (hasWorkflowTriggerIntent(params.payload) && !triggerIntent) {
    throw new InvalidWorkflowTriggerIntentError()
  }

  const result = await withTransaction(async db => {
    const runBinding = await resolveWorkflowApprovalRunBinding(db, params)
    const inserted = await db.query(
      `INSERT INTO workflow_approval_requests
         (recipe_namespace, recipe_name, expires_at, status, target_user_id, target_team_id,
          payload, idempotency_key, correlation, payload_hash,
          bound_workflow_run_id, bound_workflow_step_id)
       VALUES ($1, $2, NOW() + interval '1 second' * $3, 'pending', $4, $5,
               $6::jsonb, $7, $8::jsonb, $9, $10::uuid, $11)
       ON CONFLICT (recipe_namespace, recipe_name, idempotency_key) DO NOTHING
       RETURNING id, expires_at, status`,
      [
        params.recipeNamespace,
        params.recipeName,
        ttlSeconds,
        params.targetUserId ?? null,
        params.targetTeamId ?? null,
        JSON.stringify(params.payload),
        params.idempotencyKey,
        params.correlation ? JSON.stringify(params.correlation) : null,
        payloadHash,
        runBinding?.runId ?? null,
        runBinding?.stepId ?? null,
      ]
    )

    if ((inserted.rowCount ?? 0) === 0) {
      const existing = await db.query(
        `SELECT id, status, payload_hash AS "payloadHash" FROM workflow_approval_requests
          WHERE recipe_namespace = $1 AND recipe_name = $2 AND idempotency_key = $3`,
        [params.recipeNamespace, params.recipeName, params.idempotencyKey]
      )

      if ((existing.rowCount ?? 0) === 0) {
        throw new Error('Idempotency conflict row was not found after insert conflict')
      }

      const row = existing.rows[0] as { id: string; status: ApprovalStatus; payloadHash: string }
      if (row.payloadHash && row.payloadHash !== payloadHash) {
        return {
          kind: 'mismatch' as const,
          existingId: row.id,
          existingStatus: row.status,
        }
      }

      return {
        kind: 'existing' as const,
        id: row.id,
        status: row.status,
      }
    }

    const row = inserted.rows[0] as { id: string; expires_at: string; status: ApprovalStatus }
    await new ApprovalPromptHistoryService(db).capture({
      approvalRequestId: row.id,
      approvalKind: 'workflow',
      prompt: params.payload.message,
      sourceKind: 'control_api_local',
      runId: runBinding?.runId ?? null,
      origin: 'workflow_runtime',
    })
    if (triggerIntent) {
      await db.query(
        `INSERT INTO workflow_approval_trigger_intents (
           approval_request_id,
           trigger_namespace,
           trigger_name,
           trigger_caller_key
         )
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (approval_request_id) DO NOTHING`,
        [row.id, triggerIntent.namespace, triggerIntent.name, triggerIntent.caller]
      )
    }

    await enqueueApprovalRequestedNotification(db, {
      approvalRequestId: row.id,
      recipeNamespace: params.recipeNamespace,
      recipeName: params.recipeName,
      targetUserId: params.targetUserId,
      targetTeamId: params.targetTeamId,
      payload: params.payload,
      expiresAt: row.expires_at,
    })

    return {
      kind: 'created' as const,
      id: row.id,
      status: row.status,
      expiresAt: row.expires_at,
    }
  })

  if (result.kind === 'mismatch') {
    approvalsCreatedTotal.inc({ status: 'idempotency_mismatch' }, 1)
    return { mismatch: true, existingId: result.existingId, existingStatus: result.existingStatus }
  }

  if (result.kind === 'existing') {
    approvalsCreatedTotal.inc({ status: 'existing' }, 1)
    enqueueWorkflowApprovalTraceProjection(result.id)
    return { id: result.id, status: result.status, existing: true }
  }

  approvalsCreatedTotal.inc({ status: 'pending' }, 1)
  enqueueWorkflowApprovalTraceProjection(result.id)

  return { id: result.id, status: 'pending', expiresAt: result.expiresAt }
}

export async function getApprovalRecipeBinding(id: string): Promise<{
  recipeNamespace: string
  recipeName: string
  triggerNamespace?: string | null
  triggerName?: string | null
  triggerCaller?: string | null
} | null> {
  const result = await pool.query(
    `SELECT recipe_namespace AS "recipeNamespace",
            recipe_name AS "recipeName",
            wati.trigger_namespace AS "triggerNamespace",
            wati.trigger_name AS "triggerName",
            wati.trigger_caller_key AS "triggerCaller"
       FROM workflow_approval_requests war
  LEFT JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = war.id
      WHERE war.id = $1`,
    [id]
  )
  const row = result.rows[0] as
    | {
        recipeNamespace: string
        recipeName: string
        triggerNamespace: string | null
        triggerName: string | null
        triggerCaller: string | null
      }
    | undefined
  return row ?? null
}

export async function getStatus(
  id: string,
  recipeNamespace: string,
  recipeName: string
): Promise<ApprovalRequest | null> {
  // Lazy expiration: recordDecision()/cancelRequest() already flip status to
  // 'expired' in-TX when they notice a past expires_at, but a read-only caller
  // would otherwise observe status='pending' with expiresAt in the past until
  // the 60s cron catches up. Collapse the read+update into one transaction so
  // the status we return is always consistent with expires_at.
  return withTransaction(async db => {
    const locked = await db.query(
      `SELECT id,
              recipe_namespace AS "recipeNamespace",
              recipe_name AS "recipeName",
              requested_at AS "requestedAt",
              expires_at AS "expiresAt",
              status,
              target_user_id AS "targetUserId",
              target_team_id AS "targetTeamId",
              payload,
              decision_maker AS "decisionMaker",
              idempotency_key AS "idempotencyKey",
              correlation
         FROM workflow_approval_requests
        WHERE id = $1 AND recipe_namespace = $2 AND recipe_name = $3
          FOR UPDATE`,
      [id, recipeNamespace, recipeName]
    )

    const row = locked.rows[0] as ApprovalRequest | undefined
    if (!row) return null

    // Terminal statuses (approved/denied/expired/cancelled/consumed) never flip.
    if (row.status !== 'pending') {
      return row
    }

    const expiresAtMs = Date.parse(row.expiresAt)
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      await db.query(
        `UPDATE workflow_approval_requests
            SET status = 'expired',
                decided_at = COALESCE(decided_at, NOW())
          WHERE id = $1 AND status = 'pending'`,
        [id]
      )
      return { ...row, status: 'expired' }
    }

    return row
  })
}

export async function listPendingApprovalsForUser(
  userId: string,
  limit = 20
): Promise<PendingApprovalSummary[]> {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20
  const result = await pool.query(
    `SELECT war.id,
            war.recipe_namespace AS "recipeNamespace",
            war.recipe_name AS "recipeName",
            war.requested_at AS "requestedAt",
            war.expires_at AS "expiresAt",
            war.payload,
            war.correlation,
            war.target_user_id AS "targetUserId",
            war.target_team_id AS "targetTeamId",
            t.name AS "targetTeamName"
       FROM workflow_approval_requests war
  LEFT JOIN teams t
         ON t.id = war.target_team_id
      WHERE war.status = 'pending'
        AND war.expires_at > NOW()
        AND (
          (
            war.target_user_id = $1
            AND EXISTS (
              SELECT 1
                FROM user_workflow_triggers wau
               WHERE wau.recipe_namespace = war.recipe_namespace
                 AND wau.recipe_name = war.recipe_name
                 AND wau.user_id = $1
            )
          )
          OR
          (
            war.target_team_id IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM team_members tm
               WHERE tm.team_id = war.target_team_id
                 AND tm.user_id = $1
                 AND tm.status = 'active'
            )
            AND EXISTS (
              SELECT 1
                FROM workflow_recipe_allowed_teams wat
               WHERE wat.recipe_namespace = war.recipe_namespace
                 AND wat.recipe_name = war.recipe_name
                 AND wat.team_id = war.target_team_id
            )
          )
        )
      ORDER BY war.requested_at DESC
      LIMIT $2`,
    [userId, safeLimit]
  )

  return result.rows.map(row => {
    const typed = row as {
      id: string
      recipeNamespace: string
      recipeName: string
      requestedAt: string
      expiresAt: string
      payload: ApprovalPayload
      correlation: ApprovalCorrelation | null
      targetUserId: string | null
      targetTeamId: string | null
      targetTeamName: string | null
    }
    return {
      id: typed.id,
      recipeNamespace: typed.recipeNamespace,
      recipeName: typed.recipeName,
      requestedAt: typed.requestedAt,
      expiresAt: typed.expiresAt,
      payload: typed.payload,
      correlation: typed.correlation,
      target: {
        userId: typed.targetUserId,
        teamId: typed.targetTeamId,
        teamName: typed.targetTeamName,
      },
    }
  })
}

export type RecordDecisionAudit = {
  clientIp?: string | null
  userAgent?: string | null
  correlationId?: string | null
}

export type RecordDecisionResult =
  | { ok: true; workflowRun?: { row: WorkflowRunRow; created: boolean } }
  | { ok: false; error?: string }

async function createWorkflowRunForApprovedTriggerIntent(
  params: {
    approvalRequestId: string
    correlationId?: string | null
  },
  db: DbClient
): Promise<{ row: WorkflowRunRow; created: boolean } | null> {
  const intent = await db.query(
    `SELECT war.id AS "approvalRequestId",
            wati.trigger_namespace AS "recipeNamespace",
            wati.trigger_name AS "recipeName",
            wati.trigger_caller_key AS "callerKey",
            watri.actor_type AS "actorType",
            watri.actor_id AS "actorId",
            watri.team_id AS "teamId",
            watri.usage_team_id AS "usageTeamId",
            watri.trigger_source AS "triggerSource",
            watri.idempotency_key AS "idempotencyKey",
            watri.inputs,
            watri.intermediate_parameters AS "intermediateParameters",
            watri.output_overrides AS "outputOverrides",
            watri.max_duration_seconds AS "maxDurationSeconds",
            watri.ttl_seconds_after_finished AS "ttlSecondsAfterFinished",
            watri.idempotency_payload_hash AS "idempotencyPayloadHash"
       FROM workflow_approval_trigger_run_intents watri
       JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = watri.approval_request_id
       JOIN workflow_approval_requests war
         ON war.id = watri.approval_request_id
      WHERE watri.approval_request_id = $1`,
    [params.approvalRequestId]
  )

  if ((intent.rowCount ?? 0) === 0) return null

  const row = intent.rows[0] as {
    recipeNamespace: string
    recipeName: string
    callerKey: string
    actorType: WorkflowRunActorType
    actorId: string | null
    teamId: string | null
    usageTeamId: string | null
    triggerSource: 'onDemand' | 'schedule' | 'autonomous'
    idempotencyKey: string
    inputs: Record<string, unknown> | null
    intermediateParameters: Record<string, unknown> | null
    outputOverrides: Record<string, unknown> | null
    maxDurationSeconds: number | null
    ttlSecondsAfterFinished: number | null
    idempotencyPayloadHash: string
  }

  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
    `workflow_run:${row.recipeNamespace}:${row.recipeName}:${row.idempotencyKey}`,
  ])

  const existing = await db.query(
    `SELECT * FROM workflow_runs
      WHERE recipe_namespace = $1
        AND recipe_name = $2
        AND idempotency_key = $3
      FOR UPDATE`,
    [row.recipeNamespace, row.recipeName, row.idempotencyKey]
  )

  if ((existing.rowCount ?? 0) > 0) {
    const existingRow = existing.rows[0] as WorkflowRunRow
    if (
      existingRow.idempotency_payload_hash !== row.idempotencyPayloadHash ||
      existingRow.approval_request_id !== params.approvalRequestId ||
      existingRow.actor_id !== row.actorId
    ) {
      throw new ApprovalTriggerRunIdempotencyConflictError()
    }
    return { row: existingRow, created: false }
  }

  const consumedApproval = await consumeApprovalForTrigger(
    {
      approvalRequestId: params.approvalRequestId,
      recipeNamespace: row.recipeNamespace,
      recipeName: row.recipeName,
      callerKey: row.callerKey,
      correlationId: params.correlationId ?? params.approvalRequestId,
    },
    db
  )

  const inserted = await db.query(
    `INSERT INTO workflow_runs (
       recipe_namespace, recipe_name, phase, actor_type, team_id, usage_team_id, actor_id,
       idempotency_key, trigger_source, inputs, intermediate_parameters,
       output_overrides, max_duration_seconds, ttl_seconds_after_finished, approval_request_id,
       idempotency_payload_hash
     )
     VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15)
     RETURNING *`,
    [
      row.recipeNamespace,
      row.recipeName,
      row.actorType,
      row.teamId ?? consumedApproval.teamId ?? null,
      // New Desktop pre-run approvals persist usageTeamId in the run intent.
      // The consumed-approval fallback keeps attribution intact for any older
      // approval-bound rows that only carried the decision team.
      row.usageTeamId ?? row.teamId ?? consumedApproval.teamId ?? null,
      row.actorId,
      row.idempotencyKey,
      row.triggerSource,
      row.inputs ? JSON.stringify(row.inputs) : null,
      row.intermediateParameters ? JSON.stringify(row.intermediateParameters) : null,
      row.outputOverrides ? JSON.stringify(row.outputOverrides) : null,
      row.maxDurationSeconds,
      row.ttlSecondsAfterFinished,
      params.approvalRequestId,
      row.idempotencyPayloadHash,
    ]
  )

  if (!inserted.rowCount) {
    throw new Error('createWorkflowRunForApprovedTriggerIntent: insert returned no rows')
  }

  return { row: inserted.rows[0] as WorkflowRunRow, created: true }
}

export async function recordDecision(
  id: string,
  decision: 'approve' | 'deny',
  decidedBy: { userId: string; teamId?: string },
  note?: string,
  audit?: RecordDecisionAudit,
  dbTx?: DbClient
): Promise<RecordDecisionResult> {
  const work = async (db: DbClient): Promise<RecordDecisionResult> => {
    // Fetch requested_at so we can compute decision latency for the histogram
    // (lifecycle duration from creation to terminal decision).
    const current = await db.query(
      `SELECT status,
              expires_at <= NOW() AS "isExpired",
              requested_at AS "requestedAt",
              recipe_namespace AS "recipeNamespace",
              recipe_name AS "recipeName",
              target_user_id AS "targetUserId",
              target_team_id AS "targetTeamId",
              payload
         FROM workflow_approval_requests
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )

    if ((current.rowCount ?? 0) === 0) {
      return { ok: false, error: 'not_found' }
    }

    const row = current.rows[0] as {
      status: ApprovalStatus
      isExpired?: boolean
      requestedAt?: string | Date | null
      recipeNamespace: string
      recipeName: string
      targetUserId?: string | null
      targetTeamId?: string | null
      payload?: unknown
    }
    if (row.status !== 'pending') {
      return { ok: false, error: 'not_pending' }
    }

    if (row.isExpired) {
      await db.query(
        `UPDATE workflow_approval_requests
            SET status = 'expired',
                decided_at = COALESCE(decided_at, NOW())
          WHERE id = $1 AND status = 'pending'`,
        [id]
      )
      await enqueueApprovalUpdatedNotification(db, {
        approvalRequestId: id,
        recipeNamespace: row.recipeNamespace,
        recipeName: row.recipeName,
        targetUserId: row.targetUserId,
        targetTeamId: row.targetTeamId,
        status: 'expired',
      })
      approvalsExpiredTotal.inc(1)
      rootLogger.info(
        {
          event: 'approval_transition',
          from: 'pending',
          to: 'expired',
          approvalRequestId: id,
          cause: 'decide_expired',
          correlationId: audit?.correlationId ?? null,
        },
        'approval transition'
      )
      return { ok: false, error: 'expired' }
    }

    const requesterUserId = parseWorkflowTriggerIntent(row.payload)?.requesterUserId
    if (row.targetTeamId && requesterUserId && requesterUserId !== decidedBy.userId) {
      return { ok: false, error: 'approval_requester_mismatch' }
    }

    const decidedAt = new Date()
    const decidedAtIso = decidedAt.toISOString()
    await db.query(
      `UPDATE workflow_approval_requests
          SET status = $2,
              decision_maker = $3::jsonb,
              decided_at = $4,
              decided_by_user_id = $5,
              client_ip = $6,
              user_agent = $7
        WHERE id = $1`,
      [
        id,
        decision === 'approve' ? 'approved' : 'denied',
        JSON.stringify({
          userId: decidedBy.userId,
          teamId: decidedBy.teamId ?? null,
          note: note ?? null,
          decidedAt: decidedAtIso,
        }),
        decidedAt,
        decidedBy.userId,
        audit?.clientIp ?? null,
        audit?.userAgent ?? null,
      ]
    )
    await enqueueApprovalUpdatedNotification(db, {
      approvalRequestId: id,
      recipeNamespace: row.recipeNamespace,
      recipeName: row.recipeName,
      targetUserId: row.targetUserId,
      targetTeamId: row.targetTeamId,
      status: decision === 'approve' ? 'approved' : 'denied',
    })

    const workflowRun =
      decision === 'approve'
        ? await createWorkflowRunForApprovedTriggerIntent(
            { approvalRequestId: id, correlationId: audit?.correlationId ?? null },
            db
          )
        : null

    approvalsDecidedTotal.inc({ decision: decision === 'approve' ? 'approved' : 'denied' }, 1)

    // Duration: from requested_at (row creation) to decided_at (now).
    if (row.requestedAt) {
      const requestedAtMs =
        row.requestedAt instanceof Date ? row.requestedAt.getTime() : Date.parse(row.requestedAt)
      if (Number.isFinite(requestedAtMs)) {
        const durationSec = Math.max(0, (decidedAt.getTime() - requestedAtMs) / 1000)
        approvalsDurationSeconds.observe(
          { decision: decision === 'approve' ? 'approved' : 'denied' },
          durationSec
        )
      }
    }

    rootLogger.info(
      {
        event: 'approval_transition',
        from: 'pending',
        to: decision === 'approve' ? 'approved' : 'denied',
        approvalRequestId: id,
        decidedBy: decidedBy.userId,
        teamId: decidedBy.teamId ?? null,
        correlationId: audit?.correlationId ?? null,
      },
      'approval transition'
    )

    return workflowRun ? { ok: true, workflowRun } : { ok: true }
  }

  const result = dbTx ? await work(dbTx) : await withTransaction(work)
  if (!dbTx && result.ok) enqueueWorkflowApprovalTraceProjection(id)
  return result
}

export type CancelRequestAudit = {
  cancelledBy?: string | null
  correlationId?: string | null
}

export async function cancelRequest(
  id: string,
  recipeNamespace: string,
  recipeName: string,
  audit?: CancelRequestAudit
): Promise<{ ok: boolean; error?: string }> {
  return withTransaction(async db => {
    const current = await db.query(
      `SELECT status,
              expires_at,
              target_user_id AS "targetUserId",
              target_team_id AS "targetTeamId"
         FROM workflow_approval_requests
        WHERE id = $1 AND recipe_namespace = $2 AND recipe_name = $3 FOR UPDATE`,
      [id, recipeNamespace, recipeName]
    )

    if ((current.rowCount ?? 0) === 0) {
      return { ok: false, error: 'not_found' }
    }

    const row = current.rows[0] as {
      status: ApprovalStatus
      expires_at: Date | string
      targetUserId?: string | null
      targetTeamId?: string | null
    }
    if (row.status === 'pending' && new Date(row.expires_at) < new Date()) {
      await db.query(
        `UPDATE workflow_approval_requests
            SET status = 'expired',
                decided_at = COALESCE(decided_at, NOW())
          WHERE id = $1`,
        [id]
      )
      await enqueueApprovalUpdatedNotification(db, {
        approvalRequestId: id,
        recipeNamespace,
        recipeName,
        targetUserId: row.targetUserId,
        targetTeamId: row.targetTeamId,
        status: 'expired',
      })
      return { ok: false, error: 'expired' }
    }
    if (row.status !== 'pending') {
      return { ok: false, error: 'not_pending' }
    }

    await db.query(
      `UPDATE workflow_approval_requests
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancelled_by = $2
        WHERE id = $1`,
      [id, audit?.cancelledBy ?? null]
    )
    await enqueueApprovalUpdatedNotification(db, {
      approvalRequestId: id,
      recipeNamespace,
      recipeName,
      targetUserId: row.targetUserId,
      targetTeamId: row.targetTeamId,
      status: 'cancelled',
    })

    approvalsCancelledTotal.inc(1)
    rootLogger.info(
      {
        event: 'approval_transition',
        from: 'pending',
        to: 'cancelled',
        approvalRequestId: id,
        cancelledBy: audit?.cancelledBy ?? null,
        correlationId: audit?.correlationId ?? null,
      },
      'approval transition'
    )

    return { ok: true }
  })
}

export async function consumeApprovalForTrigger(
  params: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    callerKey: string
    correlationId: string
  },
  dbTx: DbClient
): Promise<{ teamId: string | null }> {
  rootLogger.info(
    {
      approvalRequestId: params.approvalRequestId,
      recipe: `${params.recipeNamespace}/${params.recipeName}`,
      callerKey: params.callerKey,
      correlationId: params.correlationId,
    },
    'consuming approval for trigger execution'
  )

  // Lock the parent approval row. `workflow_approval_trigger_intents` is an
  // immutable child keyed by FK; the parent row lock blocks concurrent child
  // inserts, and the final UPDATE rechecks the current typed intent.
  const existing = await dbTx.query(
    `SELECT war.status,
            war.recipe_namespace AS "recipeNamespace",
            war.recipe_name AS "recipeName",
            war.expires_at <= NOW() AS "isExpired",
            war.target_user_id AS "targetUserId",
            war.target_team_id AS "targetTeamId",
            war.payload,
            war.decided_by_user_id AS "decidedByUserId",
            wati.trigger_namespace AS "triggerNamespace",
            wati.trigger_name AS "triggerName",
            wati.trigger_caller_key AS "triggerCaller",
            EXISTS (
              SELECT 1
                FROM user_workflow_triggers wau
               WHERE wau.recipe_namespace = war.recipe_namespace
                 AND wau.recipe_name = war.recipe_name
                 AND wau.user_id = war.target_user_id
            ) AS "targetUserAllowed",
            EXISTS (
              SELECT 1
                FROM workflow_recipe_allowed_teams wat
               WHERE wat.recipe_namespace = war.recipe_namespace
                 AND wat.recipe_name = war.recipe_name
                 AND wat.team_id = war.target_team_id
            ) AS "targetTeamAllowed"
       FROM workflow_approval_requests war
  LEFT JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = war.id
      WHERE war.id = $1
      FOR UPDATE OF war`,
    [params.approvalRequestId]
  )

  if ((existing.rowCount ?? 0) === 0) {
    throw new ApprovalConsumeError(
      'approval_request_not_found',
      `Approval request ${params.approvalRequestId} not found`
    )
  }

  const row = existing.rows[0] as {
    status: ApprovalStatus
    recipeNamespace: string
    recipeName: string
    isExpired?: boolean
    targetUserId?: string | null
    targetTeamId?: string | null
    payload?: unknown
    decidedByUserId?: string | null
    triggerNamespace?: string | null
    triggerName?: string | null
    triggerCaller?: string | null
    targetUserAllowed?: boolean
    targetTeamAllowed?: boolean
  }

  if (row.isExpired) {
    throw new ApprovalConsumeError(
      'approval_expired',
      `Approval request ${params.approvalRequestId} cannot be consumed: expired`,
      row.status
    )
  }
  if (
    row.triggerNamespace !== params.recipeNamespace ||
    row.triggerName !== params.recipeName ||
    row.triggerCaller !== params.callerKey
  ) {
    const actualTrigger = `${row.triggerNamespace ?? '<missing>'}/${row.triggerName ?? '<missing>'} caller=${row.triggerCaller ?? '<missing>'}`
    const expectedTrigger = `${params.recipeNamespace}/${params.recipeName} caller=${params.callerKey}`
    throw new ApprovalConsumeError(
      'approval_trigger_binding_mismatch',
      `Approval request ${params.approvalRequestId} cannot be consumed: trigger binding mismatch (${actualTrigger} actual, ${expectedTrigger} expected)`
    )
  }
  if (row.status !== 'approved') {
    throw new ApprovalConsumeError(
      'approval_status_not_consumable',
      `Approval request ${params.approvalRequestId} cannot be consumed: status is '${row.status}'`,
      row.status
    )
  }

  const decidedByUserId = row.decidedByUserId?.trim()
  if (!decidedByUserId) {
    throw new ApprovalConsumeError(
      'approval_trigger_grant_missing',
      `Approval request ${params.approvalRequestId} cannot be consumed: missing decision user`,
      row.status
    )
  }

  let resolvedGrant: WorkflowTriggerGrantResult
  if (row.targetUserId) {
    if (row.targetUserId !== decidedByUserId) {
      throw new ApprovalConsumeError(
        'approval_target_user_mismatch',
        `Approval request ${params.approvalRequestId} cannot be consumed: decision user does not match target user`,
        row.status
      )
    }
    if (!row.targetUserAllowed) {
      throw new ApprovalConsumeError(
        'approval_target_not_allowed',
        `Approval request ${params.approvalRequestId} cannot be consumed: target no longer allowed`,
        row.status
      )
    }
    resolvedGrant = await resolveWorkflowTriggerGrant(
      {
        userId: decidedByUserId,
        recipeNamespace: params.recipeNamespace,
        recipeName: params.recipeName,
        mode: 'approval-target-user',
      },
      dbTx
    )
  } else if (row.targetTeamId) {
    const requesterUserId = parseWorkflowTriggerIntent(row.payload)?.requesterUserId
    if (requesterUserId && requesterUserId !== decidedByUserId) {
      throw new ApprovalConsumeError(
        'approval_requester_mismatch',
        `Approval request ${params.approvalRequestId} cannot be consumed: decision user does not match request user`,
        row.status
      )
    }
    if (!row.targetTeamAllowed) {
      throw new ApprovalConsumeError(
        'approval_target_not_allowed',
        `Approval request ${params.approvalRequestId} cannot be consumed: target no longer allowed`,
        row.status
      )
    }
    resolvedGrant = await resolveWorkflowTriggerGrant(
      {
        userId: decidedByUserId,
        recipeNamespace: params.recipeNamespace,
        recipeName: params.recipeName,
        mode: 'approval-target-team',
        targetTeamId: row.targetTeamId,
      },
      dbTx
    )
    if (!resolvedGrant.granted) {
      const member = await dbTx.query(
        `SELECT 1 FROM team_members
          WHERE user_id = $1 AND team_id = $2 AND status = 'active'`,
        [decidedByUserId, row.targetTeamId]
      )
      if ((member.rowCount ?? 0) === 0) {
        throw new ApprovalConsumeError(
          'approval_team_decider_not_active',
          `Approval request ${params.approvalRequestId} cannot be consumed: team decider is no longer active`,
          row.status
        )
      }
    }
  } else {
    throw new ApprovalConsumeError(
      'approval_target_missing',
      `Approval request ${params.approvalRequestId} cannot be consumed: missing target user or team`,
      row.status
    )
  }

  if (!resolvedGrant.granted) {
    throw new ApprovalConsumeError(
      'approval_trigger_grant_missing',
      `Approval request ${params.approvalRequestId} cannot be consumed: trigger grant missing`,
      row.status
    )
  }

  const consumed = await dbTx.query(
    `UPDATE workflow_approval_requests war
        SET status = 'consumed'
      WHERE war.id = $1
        AND war.status = 'approved'
        AND war.expires_at > NOW()
        AND EXISTS (
          SELECT 1
            FROM workflow_approval_trigger_intents wati
           WHERE wati.approval_request_id = war.id
             AND wati.trigger_namespace = $2
             AND wati.trigger_name = $3
             AND wati.trigger_caller_key = $4
        )
        AND (
          (
            war.target_user_id IS NOT NULL
            AND war.target_user_id::text = war.decided_by_user_id
            AND EXISTS (
              SELECT 1
                FROM user_workflow_triggers allow_uwt
               WHERE allow_uwt.recipe_namespace = war.recipe_namespace
                 AND allow_uwt.recipe_name = war.recipe_name
                 AND allow_uwt.user_id = war.target_user_id
            )
            AND EXISTS (
              SELECT 1
                FROM user_workflow_triggers trigger_uwt
               WHERE trigger_uwt.recipe_namespace = $2
                 AND trigger_uwt.recipe_name = $3
                 AND trigger_uwt.user_id::text = war.decided_by_user_id
            )
          )
          OR
          (
            war.target_team_id IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM workflow_recipe_allowed_teams wat
               WHERE wat.recipe_namespace = war.recipe_namespace
                 AND wat.recipe_name = war.recipe_name
                 AND wat.team_id = war.target_team_id
            )
            AND (
              NULLIF(war.payload->'metadata'->'workflowTrigger'->>'requesterUserId', '') IS NULL
              OR war.decided_by_user_id = war.payload->'metadata'->'workflowTrigger'->>'requesterUserId'
            )
            AND EXISTS (
              SELECT 1
                FROM team_members tm
               WHERE tm.user_id::text = war.decided_by_user_id
                 AND tm.team_id = war.target_team_id
                 AND tm.status = 'active'
            )
            AND EXISTS (
              SELECT 1
                FROM team_workflow_triggers twt
               WHERE twt.recipe_namespace = $2
                 AND twt.recipe_name = $3
                 AND twt.team_id = war.target_team_id
            )
          )
        )
      RETURNING COALESCE(war.target_team_id::text, war.decision_maker->>'teamId') AS "teamId"`,
    [params.approvalRequestId, params.recipeNamespace, params.recipeName, params.callerKey]
  )
  if ((consumed.rowCount ?? 0) === 0) {
    throw new ApprovalConsumeError(
      'approval_trigger_grant_missing',
      `Approval request ${params.approvalRequestId} cannot be consumed: authorization changed before consumption`,
      row.status
    )
  }
  const consumedRow = consumed.rows[0] as { teamId?: string | null } | undefined
  return { teamId: consumedRow?.teamId ?? null }
}

export async function assertApprovalTriggerBinding(params: {
  approvalRequestId: string
  recipeNamespace: string
  recipeName: string
  callerKey: string
}): Promise<void> {
  const existing = await pool.query(
    `SELECT war.status,
            wati.trigger_namespace AS "triggerNamespace",
            wati.trigger_name AS "triggerName",
            wati.trigger_caller_key AS "triggerCaller"
       FROM workflow_approval_requests war
  LEFT JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = war.id
      WHERE war.id = $1
      LIMIT 1`,
    [params.approvalRequestId]
  )

  if ((existing.rowCount ?? 0) === 0) {
    throw new ApprovalConsumeError(
      'approval_request_not_found',
      `Approval request ${params.approvalRequestId} not found`
    )
  }

  const row = existing.rows[0] as {
    status: ApprovalStatus
    triggerNamespace?: string | null
    triggerName?: string | null
    triggerCaller?: string | null
  }

  if (
    row.triggerNamespace !== params.recipeNamespace ||
    row.triggerName !== params.recipeName ||
    row.triggerCaller !== params.callerKey
  ) {
    const actualTrigger = `${row.triggerNamespace ?? '<missing>'}/${row.triggerName ?? '<missing>'} caller=${row.triggerCaller ?? '<missing>'}`
    const expectedTrigger = `${params.recipeNamespace}/${params.recipeName} caller=${params.callerKey}`
    throw new ApprovalConsumeError(
      'approval_trigger_binding_mismatch',
      `Approval request ${params.approvalRequestId} cannot be used for trigger preflight: trigger binding mismatch (${actualTrigger} actual, ${expectedTrigger} expected)`,
      row.status
    )
  }
}

export async function expirePendingRequests(): Promise<number> {
  const result = await pool.query(
    `UPDATE workflow_approval_requests
        SET status = 'expired',
            decided_at = COALESCE(decided_at, NOW())
      WHERE status = 'pending' AND expires_at < NOW()
     RETURNING id`
  )
  const expired = result.rowCount ?? 0
  if (expired > 0) {
    approvalsExpiredTotal.inc(expired)
    rootLogger.info(
      { event: 'approvals_expired_by_cron', count: expired },
      'approvals expired by cron'
    )
  }
  return expired
}
