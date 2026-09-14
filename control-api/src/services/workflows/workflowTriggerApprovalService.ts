import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { type DbClient, withTransaction } from '../../db.js'
import { approvalsCreatedTotal } from '../../observability/metrics.js'
import { stableStringify } from '../../utils/stableStringify.js'
import { emitNotification } from '../notificationEmitter.js'
import { ApprovalPromptHistoryService } from '../tracing/approvalPromptHistoryService.js'
import {
  type ApprovalPayload,
  type ApprovalStatus,
  computePayloadHash,
} from '../userApprovalRequestService.js'
import {
  type WorkflowRunActorType,
  type WorkflowRunRow,
  computeWorkflowRunPayloadHash,
} from '../workflowRunService.js'
import {
  type WorkflowAuthorityBinding,
  persistWorkflowAuthorityBinding,
} from './workflowAuthorityBindingService.js'

function matchesPersistedAuthorityIgnoringDelegationIdentity(
  authority: WorkflowAuthorityBinding,
  persistedBindingHash: string,
  persistedDelegationJti: string | null | undefined
): boolean {
  if (authority.bindingHash === persistedBindingHash) return true
  if (!persistedDelegationJti) return false
  const persistedShape = {
    ...authority.binding,
    delegationJti: persistedDelegationJti,
  }
  return (
    createHash('sha256').update(stableStringify(persistedShape)).digest('hex') ===
    persistedBindingHash
  )
}

export type WorkflowTriggerApprovalRunIntent = {
  actorType: WorkflowRunActorType
  actorId: string | null
  teamId: string | null
  usageTeamId: string | null
  triggerSource: 'onDemand' | 'schedule' | 'autonomous'
  inputs?: Record<string, unknown> | null
  intermediateParameters?: Record<string, unknown> | null
  outputOverrides?: Record<string, unknown> | null
  maxDurationSeconds?: number | null
  ttlSecondsAfterFinished?: number | null
}

export type WorkflowTriggerApprovalRequestResult =
  | {
      kind: 'approval'
      approvalRequestId: string
      status: ApprovalStatus
      expiresAt?: string
      existing?: true
    }
  | {
      kind: 'run'
      row: WorkflowRunRow
      created: false
    }
  | {
      kind: 'mismatch'
      approvalRequestId: string
      status: ApprovalStatus
      reason?: 'payload_hash_mismatch' | 'missing_run_intent'
    }

export async function createWorkflowTriggerApprovalRequest(params: {
  recipeNamespace: string
  recipeName: string
  callerKey: string
  targetUserId?: string
  targetTeamId?: string
  payload: ApprovalPayload
  idempotencyKey: string
  correlation?: { taskId?: string; stepId?: string }
  runIntent: WorkflowTriggerApprovalRunIntent
  authority?: WorkflowAuthorityBinding | null
  reauthorize?: () => Promise<WorkflowAuthorityBinding | null>
  validateCurrentInTransaction?: (
    db: DbClient,
    authority: WorkflowAuthorityBinding
  ) => Promise<WorkflowAuthorityBinding>
}): Promise<WorkflowTriggerApprovalRequestResult> {
  const ttlSeconds = config.userApprovalRequestDefaultTtlSec
  const payloadHash = computePayloadHash({
    targetUserId: params.targetUserId,
    targetTeamId: params.targetTeamId,
    payload: params.payload,
    correlation: params.correlation,
    ttlSeconds,
  })

  const phaseOneAuthority = params.reauthorize ? await params.reauthorize() : params.authority
  if (params.authority && phaseOneAuthority?.bindingHash !== params.authority.bindingHash) {
    throw new Error('workflow_trigger_authority_changed')
  }
  if (params.reauthorize && phaseOneAuthority && !params.validateCurrentInTransaction) {
    throw new Error('workflow_trigger_current_authority_validator_required')
  }

  const result = await withTransaction(async db => {
    let existingBeforeFence = { rowCount: 0 as number | null }
    if (phaseOneAuthority) {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
        `workflow_approval:${params.recipeNamespace}:${params.recipeName}:${params.idempotencyKey}`,
      ])
      existingBeforeFence = await db.query(
        `SELECT id FROM workflow_approval_requests
          WHERE recipe_namespace = $1 AND recipe_name = $2 AND idempotency_key = $3`,
        [params.recipeNamespace, params.recipeName, params.idempotencyKey]
      )
    }
    let authority = phaseOneAuthority
    let inserted: { rows: unknown[]; rowCount: number | null } = { rows: [], rowCount: 0 }
    if ((existingBeforeFence.rowCount ?? 0) === 0) {
      authority =
        phaseOneAuthority && params.validateCurrentInTransaction
          ? await params.validateCurrentInTransaction(db, phaseOneAuthority)
          : phaseOneAuthority
      if (phaseOneAuthority && authority?.bindingHash !== phaseOneAuthority.bindingHash) {
        throw new Error('workflow_trigger_authority_changed')
      }
      inserted = await db.query(
        `INSERT INTO workflow_approval_requests
         (recipe_namespace, recipe_name, expires_at, status, target_user_id, target_team_id, payload, idempotency_key, correlation, payload_hash)
       VALUES ($1, $2, NOW() + interval '1 second' * $3, 'pending', $4, $5, $6::jsonb, $7, $8::jsonb, $9)
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
        ]
      )
    }

    if ((inserted.rowCount ?? 0) === 0) {
      const existing = await db.query(
        `SELECT war.id,
                war.status,
                war.expires_at AS "expiresAt",
                war.payload_hash AS "payloadHash",
                watri.approval_request_id AS "runIntentApprovalRequestId",
                wr.run_id,
                wr.recipe_namespace,
                wr.recipe_name,
                wr.phase,
                wr.actor_type,
                wr.team_id,
                wr.usage_team_id,
                wr.actor_id,
                wr.idempotency_key,
                wr.trigger_source,
                wr.inputs,
                wr.intermediate_parameters,
                wr.output_overrides,
                wr.child_recipe_name,
                wr.child_recipe_namespace,
                wr.owner_instance_id,
                wr.max_duration_seconds,
                wr.ttl_seconds_after_finished,
                wr.approval_request_id,
                wr.idempotency_payload_hash,
                wr.started_at,
                wr.completed_at,
                wr.last_reconciled_at,
                wr.created_at,
                wr.updated_at
                , binding.binding_hash AS "authorityBindingHash"
                , binding.delegation_jti AS "authorityDelegationJti"
           FROM workflow_approval_requests war
      LEFT JOIN workflow_approval_trigger_run_intents watri
             ON watri.approval_request_id = war.id
      LEFT JOIN workflow_runs wr
             ON wr.recipe_namespace = war.recipe_namespace
            AND wr.recipe_name = war.recipe_name
            AND wr.idempotency_key = war.idempotency_key
      LEFT JOIN workflow_authority_bindings binding
             ON binding.id = war.trigger_authority_binding_id
          WHERE war.recipe_namespace = $1
            AND war.recipe_name = $2
            AND war.idempotency_key = $3`,
        [params.recipeNamespace, params.recipeName, params.idempotencyKey]
      )

      if ((existing.rowCount ?? 0) === 0) {
        throw new Error('Idempotency conflict row was not found after insert conflict')
      }

      const row = existing.rows[0] as {
        id: string
        status: ApprovalStatus
        expiresAt: string
        payloadHash: string
        runIntentApprovalRequestId?: string | null
        run_id?: string | null
        authorityBindingHash?: string | null
        authorityDelegationJti?: string | null
      } & Partial<WorkflowRunRow>

      if (
        (row.payloadHash && row.payloadHash !== payloadHash) ||
        Boolean(row.authorityBindingHash) !== Boolean(authority) ||
        (authority &&
          row.authorityBindingHash &&
          !matchesPersistedAuthorityIgnoringDelegationIdentity(
            authority,
            row.authorityBindingHash,
            row.authorityDelegationJti
          ))
      ) {
        return {
          kind: 'mismatch' as const,
          approvalRequestId: row.id,
          status: row.status,
          reason: 'payload_hash_mismatch' as const,
        }
      }

      if (!row.runIntentApprovalRequestId) {
        return {
          kind: 'mismatch' as const,
          approvalRequestId: row.id,
          status: row.status,
          reason: 'missing_run_intent' as const,
        }
      }

      if (row.run_id) {
        return { kind: 'run' as const, row: row as WorkflowRunRow, created: false as const }
      }

      return {
        kind: 'approval' as const,
        approvalRequestId: row.id,
        status: row.status,
        expiresAt: row.expiresAt,
        existing: true as const,
      }
    }

    const row = inserted.rows[0] as { id: string; expires_at: string; status: ApprovalStatus }
    const authorityBindingId = authority
      ? await persistWorkflowAuthorityBinding(db, {
          authority,
          kind: 'trigger',
          entityType: 'workflow_approval',
          entityId: row.id,
        })
      : null
    if (authorityBindingId) {
      await db.query(
        `UPDATE workflow_approval_requests
            SET trigger_authority_binding_id = $2
          WHERE id = $1`,
        [row.id, authorityBindingId]
      )
    }
    await new ApprovalPromptHistoryService(db).capture({
      approvalRequestId: row.id,
      approvalKind: 'workflow',
      prompt: params.payload.message,
      sourceKind: 'control_api_local',
      origin: 'workflow_runtime',
    })
    const idempotencyPayloadHash = computeWorkflowRunPayloadHash({
      recipeNamespace: params.recipeNamespace,
      recipeName: params.recipeName,
      actorType: params.runIntent.actorType,
      actorId: params.runIntent.actorId,
      idempotencyKey: params.idempotencyKey,
      triggerSource: params.runIntent.triggerSource,
      approvalRequestId: row.id,
      callerKey: params.callerKey,
      inputs: params.runIntent.inputs ?? {},
      intermediateParameters: params.runIntent.intermediateParameters ?? null,
      outputOverrides: params.runIntent.outputOverrides ?? null,
      authorityBindingHash: authority?.bindingHash ?? null,
    })

    await db.query(
      `INSERT INTO workflow_approval_trigger_intents (
         approval_request_id,
         trigger_namespace,
         trigger_name,
         trigger_caller_key
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (approval_request_id) DO NOTHING`,
      [row.id, params.recipeNamespace, params.recipeName, params.callerKey]
    )

    await db.query(
      `INSERT INTO workflow_approval_trigger_run_intents (
         approval_request_id,
         actor_type,
         actor_id,
         team_id,
         usage_team_id,
         trigger_source,
         idempotency_key,
         inputs,
         intermediate_parameters,
         output_overrides,
         max_duration_seconds,
         ttl_seconds_after_finished,
         idempotency_payload_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
       ON CONFLICT (approval_request_id) DO NOTHING`,
      [
        row.id,
        params.runIntent.actorType,
        params.runIntent.actorId,
        params.runIntent.teamId,
        params.runIntent.usageTeamId,
        params.runIntent.triggerSource,
        params.idempotencyKey,
        params.runIntent.inputs ? JSON.stringify(params.runIntent.inputs) : null,
        params.runIntent.intermediateParameters
          ? JSON.stringify(params.runIntent.intermediateParameters)
          : null,
        params.runIntent.outputOverrides ? JSON.stringify(params.runIntent.outputOverrides) : null,
        params.runIntent.maxDurationSeconds ?? null,
        params.runIntent.ttlSecondsAfterFinished ?? null,
        idempotencyPayloadHash,
      ]
    )

    return {
      kind: 'approval' as const,
      approvalRequestId: row.id,
      status: row.status,
      expiresAt: row.expires_at,
    }
  })

  if (result.kind === 'mismatch') {
    approvalsCreatedTotal.inc({ status: 'idempotency_mismatch' }, 1)
    return result
  }

  if (result.kind === 'approval' && result.existing) {
    approvalsCreatedTotal.inc({ status: 'existing' }, 1)
    return result
  }

  if (result.kind === 'approval') {
    approvalsCreatedTotal.inc({ status: 'pending' }, 1)
    // Trigger approvals persist their security state in the transaction above.
    // Notification delivery is intentionally best-effort so a transient outbox
    // failure does not roll back the approval/run intent created for the MCP host.
    void emitNotification({
      approvalRequestId: result.approvalRequestId,
      recipeNamespace: params.recipeNamespace,
      recipeName: params.recipeName,
      targetUserId: params.targetUserId,
      targetTeamId: params.targetTeamId,
      payload: params.payload,
      expiresAt: result.expiresAt ?? '',
    }).catch(err => {
      console.error(
        '[WorkflowTriggerApprovalService] Failed to emit notification for approval',
        result.approvalRequestId,
        err
      )
    })
  }

  return result
}
