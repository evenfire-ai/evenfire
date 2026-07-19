import { config } from '../config.js'
import { type DbClient, withTransaction } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import { type McpHostControlClaims, getMcpHostCallerKey } from '../utils/auth/mcpHostJwtToken.js'
import { enqueueWorkflowApprovalTraceProjection } from './tracing/workflowApprovalTraceProjector.js'
import {
  ApprovalConsumeError,
  ApprovalTriggerRunIdempotencyConflictError,
  parseWorkflowTriggerIntent,
  recordDecision,
} from './userApprovalRequestService.js'
import { normalizeMediumIdentity } from './workflowApprovalMediumIdentityService.js'
import {
  type OperationalMediumIdentityInput,
  findVerifiedOperationalMediumAccount,
  normalizeTelegramProviderChannelType,
} from './workflowApprovalMediumOperationalIdentityService.js'
import { verifyTelegramOperationalChannelBinding } from './workflowApprovalTelegramChannelGateService.js'
import { mapDbRun } from './workflows/workflowRunReadService.js'

export type ProviderApprovalDecisionInput = {
  approvalRequestId: string
  mediumIdentity: OperationalMediumIdentityInput
  providerEventId: string
  decision: 'approve' | 'deny'
  caller: McpHostControlClaims
  gateway?: K8sGateway
  note?: string | null
}

export type ProviderApprovalDecisionResult =
  | { ok: true; duplicate: boolean; status?: string; run?: ReturnType<typeof mapDbRun> }
  | { ok: false; status: number; error: string }

async function markProviderEvent(params: {
  db: DbClient
  medium: string
  providerEventId: string
  result: string
}): Promise<void> {
  await params.db.query(
    `UPDATE workflow_approval_provider_events
        SET processed_at = NOW(), result = $3
      WHERE medium = $1 AND provider_event_id = $2`,
    [params.medium, params.providerEventId, params.result]
  )
}

async function reserveProviderEvent(params: {
  db: DbClient
  medium: string
  providerEventId: string
  approvalRequestId: string
  decision: 'approve' | 'deny'
}): Promise<'process' | 'duplicate' | 'duplicate_failed' | 'replay_mismatch'> {
  const result = await params.db.query(
    `INSERT INTO workflow_approval_provider_events
       (medium, provider_event_id, approval_request_id, decision, result)
     VALUES ($1, $2, $3, $4, 'received')
     ON CONFLICT (medium, provider_event_id) DO NOTHING
     RETURNING id`,
    [params.medium, params.providerEventId, params.approvalRequestId, params.decision]
  )
  if ((result.rowCount ?? 0) > 0) return 'process'

  const existing = await params.db.query(
    `SELECT approval_request_id AS "approvalRequestId",
            decision,
            result
       FROM workflow_approval_provider_events
      WHERE medium = $1 AND provider_event_id = $2
      FOR UPDATE`,
    [params.medium, params.providerEventId]
  )
  const row = existing.rows[0] as
    | { approvalRequestId: string; decision: string; result: string | null }
    | undefined
  if (row?.approvalRequestId === params.approvalRequestId && row.decision === params.decision) {
    if (row.result === 'received') return 'process'
    return row.result === 'decided' ? 'duplicate' : 'duplicate_failed'
  }
  return 'replay_mismatch'
}

async function resolveProviderDecisionAccess(params: {
  db: DbClient
  approvalRequestId: string
  userId: string
  caller: McpHostControlClaims
}): Promise<
  { ok: true; teamId?: string } | { ok: false; status: number; error: string; eventResult: string }
> {
  const callerKey = providerDecisionCallerKey(params.caller)
  const result = await params.db.query(
    `SELECT war.id,
            war.status,
            war.expires_at <= NOW() AS "isExpired",
            war.recipe_namespace AS "recipeNamespace",
            war.recipe_name AS "recipeName",
            war.target_user_id AS "targetUserId",
            war.target_team_id AS "targetTeamId",
            war.payload,
            wati.trigger_namespace AS "triggerNamespace",
            wati.trigger_name AS "triggerName",
            wati.trigger_caller_key AS "triggerCaller",
            EXISTS (
              SELECT 1
                FROM user_workflow_triggers uwt
               WHERE uwt.recipe_namespace = war.recipe_namespace
                 AND uwt.recipe_name = war.recipe_name
                 AND uwt.user_id = $2
            ) AS "userTriggerAllowed",
            EXISTS (
              SELECT 1
                FROM workflow_recipe_allowed_teams wat
               WHERE wat.recipe_namespace = war.recipe_namespace
                 AND wat.recipe_name = war.recipe_name
                 AND wat.team_id = war.target_team_id
            ) AS "teamAllowed",
            EXISTS (
              SELECT 1
                FROM team_members tm
               WHERE tm.team_id = war.target_team_id
                 AND tm.user_id = $2
                 AND tm.status = 'active'
            ) AS "teamMemberActive",
            EXISTS (
              SELECT 1
                FROM team_workflow_triggers twt
               WHERE twt.recipe_namespace = war.recipe_namespace
                 AND twt.recipe_name = war.recipe_name
                 AND twt.team_id = war.target_team_id
            ) AS "teamTriggerAllowed"
       FROM workflow_approval_requests war
  LEFT JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = war.id
      WHERE war.id = $1`,
    [params.approvalRequestId, params.userId]
  )

  if ((result.rowCount ?? 0) === 0) {
    return { ok: false, status: 404, error: 'approval_not_found', eventResult: 'not_found' }
  }

  const row = result.rows[0] as {
    status: string
    isExpired: boolean
    recipeNamespace: string
    recipeName: string
    targetUserId: string | null
    targetTeamId: string | null
    payload: unknown
    triggerNamespace: string | null
    triggerName: string | null
    triggerCaller: string | null
    userTriggerAllowed: boolean
    teamAllowed: boolean
    teamMemberActive: boolean
    teamTriggerAllowed: boolean
  }

  if (row.status !== 'pending') {
    return { ok: false, status: 409, error: 'approval_not_pending', eventResult: 'not_pending' }
  }
  if (row.isExpired) {
    return { ok: false, status: 409, error: 'approval_expired', eventResult: 'expired' }
  }
  const approvalCaller = row.triggerCaller ?? `${row.recipeNamespace}/${row.recipeName}`
  if (row.triggerCaller !== null && (row.triggerNamespace == null || row.triggerName == null)) {
    return { ok: false, status: 403, error: 'approval_binding_mismatch', eventResult: 'forbidden' }
  }
  if (approvalCaller !== callerKey) {
    return { ok: false, status: 403, error: 'approval_binding_mismatch', eventResult: 'forbidden' }
  }

  if (row.targetUserId) {
    if (row.targetUserId === params.userId && row.userTriggerAllowed) return { ok: true }
    return { ok: false, status: 403, error: 'approval_not_authorized', eventResult: 'forbidden' }
  }

  if (row.targetTeamId) {
    const requesterUserId = parseWorkflowTriggerIntent(row.payload)?.requesterUserId
    if (requesterUserId && requesterUserId !== params.userId) {
      return {
        ok: false,
        status: 403,
        error: 'approval_requester_mismatch',
        eventResult: 'forbidden',
      }
    }
    if (row.teamAllowed && row.teamMemberActive && row.teamTriggerAllowed) {
      return { ok: true, teamId: row.targetTeamId }
    }
    return { ok: false, status: 403, error: 'approval_not_authorized', eventResult: 'forbidden' }
  }

  return { ok: false, status: 403, error: 'approval_not_authorized', eventResult: 'forbidden' }
}

function providerDecisionCallerKey(caller: McpHostControlClaims): string {
  if (caller.recipeNamespace === config.sandboxNamespace) {
    return `${caller.recipeNamespace}/${caller.recipeName}`
  }
  return getMcpHostCallerKey(caller)
}

export async function recordProviderApprovalDecision(
  input: ProviderApprovalDecisionInput
): Promise<ProviderApprovalDecisionResult> {
  let identity: ReturnType<typeof normalizeMediumIdentity>
  try {
    identity = normalizeMediumIdentity(input.mediumIdentity)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_provider_identity'
    return { ok: false, status: 400, error: message }
  }
  if (identity.medium === 'slack' && !identity.providerWorkspaceId) {
    return { ok: false, status: 400, error: 'slack_workspace_id_required' }
  }
  if (identity.medium === 'teams' && !identity.providerWorkspaceId) {
    return { ok: false, status: 400, error: 'teams_tenant_id_required' }
  }
  if (!identity.providerChannelId) {
    return { ok: false, status: 400, error: 'provider_channel_id_required' }
  }
  if (
    identity.medium !== 'telegram' &&
    identity.medium !== 'slack' &&
    identity.medium !== 'teams'
  ) {
    return { ok: false, status: 400, error: 'unsupported_provider_medium' }
  }

  const providerEventId = input.providerEventId.trim()
  if (!providerEventId || providerEventId.length > 512) {
    return { ok: false, status: 400, error: 'invalid_provider_event_id' }
  }
  if (
    identity.medium === 'slack' &&
    !providerEventId.startsWith(
      `slack:${identity.providerWorkspaceId}:${identity.providerChannelId}:`
    )
  ) {
    return { ok: false, status: 400, error: 'slack_provider_event_binding_mismatch' }
  }
  if (
    identity.medium === 'telegram' &&
    !providerEventId.startsWith(`telegram:${identity.providerChannelId}:`)
  ) {
    return { ok: false, status: 400, error: 'telegram_provider_event_binding_mismatch' }
  }
  if (
    identity.medium === 'teams' &&
    !providerEventId.startsWith(
      `teams:${identity.providerWorkspaceId}:${identity.providerChannelId}:`
    )
  ) {
    return { ok: false, status: 400, error: 'teams_provider_event_binding_mismatch' }
  }
  if (identity.medium === 'telegram') {
    const channelType = normalizeTelegramProviderChannelType(
      input.mediumIdentity.providerChannelType
    )
    // The operational-channel binding gate (verifyTelegramOperationalChannelBinding)
    // validates a GROUP/supergroup CommunicationChannel via hostRef + ns + name.
    // A Figure D private-DM decision carries a providerTarget with ONLY the
    // signed communicationChannelAlias (no operational ns/name/hostRef) — its
    // cross-bot binding is the channelAlias itself, enforced downstream by
    // findVerifiedOperationalMediumAccount → resolveChannelRefByAlias. Treating
    // that alias-only target as a "non-private" decision wrongly ran the group
    // gate and failed every Figure D private-DM approval with provider_target_required.
    const operationalTarget =
      input.mediumIdentity.providerTarget &&
      (input.mediumIdentity.providerTarget.hostRef ||
        input.mediumIdentity.providerTarget.communicationChannelNamespace ||
        input.mediumIdentity.providerTarget.communicationChannelName)
    const privateUserDm = channelType === 'private' && !operationalTarget
    if (!privateUserDm) {
      if (!input.gateway) {
        return { ok: false, status: 400, error: 'provider_target_required' }
      }
      const channelGate = await verifyTelegramOperationalChannelBinding({
        gateway: input.gateway,
        providerChannelId: identity.providerChannelId,
        providerChannelType: input.mediumIdentity.providerChannelType,
        providerTarget: input.mediumIdentity.providerTarget,
      })
      if (!channelGate.ok) {
        return {
          ok: false,
          status: channelGate.error === 'unsupported_chat_type' ? 400 : 403,
          error: channelGate.error,
        }
      }
    }
  }

  const result = await withTransaction<ProviderApprovalDecisionResult>(async db => {
    const eventState = await reserveProviderEvent({
      db,
      medium: identity.medium,
      providerEventId,
      approvalRequestId: input.approvalRequestId,
      decision: input.decision,
    })
    if (eventState === 'duplicate') {
      return { ok: true, duplicate: true }
    }
    if (eventState === 'duplicate_failed') {
      return { ok: false, status: 409, error: 'provider_event_previous_failure' }
    }
    if (eventState === 'replay_mismatch') {
      return { ok: false, status: 409, error: 'provider_event_replay_mismatch' }
    }

    const eventRef = { db, medium: identity.medium, providerEventId }
    const account = await findVerifiedOperationalMediumAccount(
      {
        ...identity,
        providerChannelType: input.mediumIdentity.providerChannelType,
        providerTarget: input.mediumIdentity.providerTarget,
      },
      db
    )
    if (!account) {
      await markProviderEvent({ ...eventRef, result: 'unverified_medium' })
      return { ok: false, status: 403, error: 'medium_identity_not_verified' }
    }
    if (identity.medium === 'telegram' && input.gateway) {
      const currentBinding = await verifyTelegramOperationalChannelBinding({
        gateway: input.gateway,
        providerChannelId: identity.providerChannelId ?? '',
        providerChannelType: input.mediumIdentity.providerChannelType,
        providerTarget: input.mediumIdentity.providerTarget,
        communicationChannelRef: account.communicationChannelRef,
        accountUserId: account.userId,
        providerUserId: identity.providerUserId,
      })
      if (!currentBinding.ok) {
        await markProviderEvent({ ...eventRef, result: 'forbidden' })
        return {
          ok: false,
          status: currentBinding.error === 'unsupported_chat_type' ? 400 : 403,
          error: currentBinding.error,
        }
      }
    }

    const access = await resolveProviderDecisionAccess({
      db,
      approvalRequestId: input.approvalRequestId,
      userId: account.userId,
      caller: input.caller,
    })
    if (!access.ok) {
      await markProviderEvent({ ...eventRef, result: access.eventResult })
      return { ok: false, status: access.status, error: access.error }
    }

    let result: Awaited<ReturnType<typeof recordDecision>>
    try {
      result = await recordDecision(
        input.approvalRequestId,
        input.decision,
        {
          userId: account.userId,
          ...(access.teamId ? { teamId: access.teamId } : {}),
        },
        input.note ?? undefined,
        {
          correlationId: providerEventId,
          userAgent: `${identity.medium}:channel-reader`,
        },
        db
      )
    } catch (err) {
      if (err instanceof ApprovalConsumeError) {
        await markProviderEvent({ ...eventRef, result: err.code })
        const status =
          err.code === 'approval_expired' || err.code === 'approval_status_not_consumable'
            ? 409
            : err.code === 'approval_request_not_found'
              ? 404
              : 403
        return { ok: false, status, error: err.code }
      }
      if (err instanceof ApprovalTriggerRunIdempotencyConflictError) {
        await markProviderEvent({ ...eventRef, result: 'idempotency_key_payload_mismatch' })
        return { ok: false, status: 409, error: 'idempotency_key_payload_mismatch' }
      }
      throw err
    }

    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409
      await markProviderEvent({ ...eventRef, result: result.error ?? 'decision_failed' })
      return { ok: false, status, error: result.error ?? 'decision_failed' }
    }

    await markProviderEvent({ ...eventRef, result: 'decided' })
    return {
      ok: true,
      duplicate: false,
      ...(result.workflowRun ? { run: mapDbRun(result.workflowRun.row) } : {}),
    }
  })
  if (result.ok) enqueueWorkflowApprovalTraceProjection(input.approvalRequestId)
  return result
}
