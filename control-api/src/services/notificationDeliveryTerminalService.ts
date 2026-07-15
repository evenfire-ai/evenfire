import { type DbClient, pool } from '../db.js'
import { markSdkNotificationDelivered } from './pluginWorkloadSdkInvocationAuditor.js'

const SDK_NOTIFICATION_EVENT_TYPE = 'plugin_workload_sdk.notification'

type NotificationDeliveryMedium = 'telegram' | 'slack' | 'teams'

export type ResolvePendingWorkflowApprovalDeliveryResult =
  | { status: 'found'; approvalRequestId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous' }

const SUPPORTED_DELIVERY_MEDIA = new Set(['telegram', 'slack', 'teams'])

function normalizeMedium(value: unknown): NotificationDeliveryMedium | null {
  const medium = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SUPPORTED_DELIVERY_MEDIA.has(medium) ? (medium as NotificationDeliveryMedium) : null
}

function normalizeHostRef(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeProviderWorkspaceId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized ? normalized : null
}

export async function acknowledgeNotificationDelivery(
  params: {
    id: string
    medium: unknown
    providerUserId?: unknown
    providerChannelId?: unknown
    providerWorkspaceId?: unknown
    hostRef?: unknown
  },
  db: DbClient = pool
): Promise<boolean> {
  // Record which channel actually delivered the notification. Only a successful
  // terminal 'sent' is a real delivery, so delivered_medium is written here and
  // never in failNotificationDelivery's retry/failed path. $2 is the resolved
  // medium ('telegram' | 'slack') from normalizeTerminalParams. This mirrors the
  // desktop ACK path (notificationAckService sets delivered_medium = 'desktop')
  // and applies to every channel delivery (approvals + SDK) for uniform medium
  // attribution — the column is nullable TEXT with no CHECK, so this is additive.
  const result = await updateTerminalNotificationDelivery(
    params,
    "status = 'sent', delivered_medium = $2",
    db
  )
  // Close the clientNotifications lifecycle: a delivered SDK notification moves
  // its invocation accepted → delivered. The invocation id equals the delivery
  // payload's notificationId. Guarded + idempotent across the desktop/channel
  // terminal paths; a no-op for non-SDK deliveries.
  if (result.updated && result.eventType === SDK_NOTIFICATION_EVENT_TYPE && result.notificationId) {
    await markSdkNotificationDelivered(result.notificationId)
  }
  return result.updated
}

export async function failNotificationDelivery(
  params: {
    id: string
    medium: unknown
    providerUserId?: unknown
    providerChannelId?: unknown
    providerWorkspaceId?: unknown
    hostRef?: unknown
  },
  db: DbClient = pool
): Promise<boolean> {
  // A failed/retrying delivery is not a real delivery: do not write
  // delivered_medium and do not transition the SDK invocation to 'delivered'.
  const result = await updateTerminalNotificationDelivery(
    params,
    "status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'retrying' END,\n            next_attempt_at = NOW() + INTERVAL '60 seconds'",
    db
  )
  return result.updated
}

export async function resolvePendingWorkflowApprovalDelivery(params: {
  medium: unknown
  providerUserId?: unknown
  providerChannelId?: unknown
  providerWorkspaceId?: unknown
  hostRef?: unknown
  recipeName?: unknown
  db?: DbClient
}): Promise<ResolvePendingWorkflowApprovalDeliveryResult> {
  const [medium, providerChannelId, hostRef, providerWorkspaceId] =
    normalizeDeliveryBindingParams(params)
  const providerUserId = normalizeProviderUserId(params.providerUserId)
  const recipeName = typeof params.recipeName === 'string' ? params.recipeName.trim() : ''
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(recipeName)) {
    throw new Error('recipe_name_required')
  }

  const db = params.db ?? pool
  const result = await db.query(
    `SELECT war.id
       FROM notification_deliveries nd
       JOIN workflow_approval_requests war
         ON war.id::text = nd.payload->>'approvalRequestId'
       JOIN workflow_approval_medium_accounts wama
         ON (
              wama.user_id::text = nd.audience->>'userId'
              OR EXISTS (
                SELECT 1
                  FROM team_members tm
                 WHERE tm.team_id::text = nd.audience->>'teamId'
                   AND tm.user_id = wama.user_id
                   AND tm.status = 'active'
              )
            )
        AND wama.medium = $1
        AND ($4::text IS NULL OR wama.provider_workspace_id = $4)
        AND wama.disabled_at IS NULL
        AND (
              (
                $1 = 'telegram'
                AND nd.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = 'telegram'
                AND nd.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $2
              )
              OR (
                -- Case 2: telegram approval without a binding was delivered to
                -- the user's account channel; match the response there.
                $1 = 'telegram'
                AND nd.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' IS NULL
                AND wama.provider_channel_id = $2
              )
              OR (
                $1 <> 'telegram'
                AND wama.provider_channel_id = $2
              )
            )
       JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = war.id
        AND wati.trigger_caller_key = $3
      WHERE nd.event_type = 'approval.requested'
        AND nd.status = 'sent'
        AND war.status = 'pending'
        AND war.expires_at > NOW()
        AND war.recipe_name = $5
        AND wama.provider_user_id = $6
      ORDER BY nd.created_at DESC
      LIMIT 2`,
    [medium, providerChannelId, hostRef, providerWorkspaceId, recipeName, providerUserId]
  )
  if ((result.rowCount ?? 0) === 0) return { status: 'not_found' }
  if ((result.rowCount ?? 0) > 1) return { status: 'ambiguous' }
  const row = result.rows[0] as { id?: string } | undefined
  return { status: 'found', approvalRequestId: String(row?.id ?? '') }
}

async function updateTerminalNotificationDelivery(
  params: {
    id: string
    medium: unknown
    providerUserId?: unknown
    providerChannelId?: unknown
    providerWorkspaceId?: unknown
    hostRef?: unknown
  },
  setClause: string,
  db: DbClient
): Promise<{ updated: boolean; eventType: string | null; notificationId: string | null }> {
  const terminalParams = normalizeTerminalParams(params)
  const result = await db.query(
    `UPDATE notification_deliveries
        SET ${setClause}
      WHERE id = $1
        AND event_type IN (
          'approval.requested',
          'approval.updated',
          'workflow.run.completed',
          'plugin_workload_sdk.notification'
        )
        AND status IN ('queued', 'retrying')
        AND (
          (
            event_type = 'approval.requested'
            AND EXISTS (
              SELECT 1
                FROM workflow_approval_medium_accounts wama
                JOIN workflow_approval_trigger_intents wati
                  ON wati.approval_request_id::text = notification_deliveries.payload->>'approvalRequestId'
                 AND wati.trigger_caller_key = $4
               WHERE (
                      wama.user_id::text = notification_deliveries.audience->>'userId'
                      OR EXISTS (
                        SELECT 1
                          FROM team_members tm
                         WHERE tm.team_id::text = notification_deliveries.audience->>'teamId'
                           AND tm.user_id = wama.user_id
                           AND tm.status = 'active'
                      )
                    )
                 AND wama.medium = $2
                 AND wama.provider_user_id = $6
                 AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
                 AND wama.disabled_at IS NULL
                 AND (
                       (
                         $2 = 'telegram'
                         AND notification_deliveries.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = 'telegram'
                         AND notification_deliveries.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $3
                       )
                       OR (
                         -- Case 2: telegram approval without a binding, delivered
                         -- to the user's preferred/default account channel.
                         $2 = 'telegram'
                         AND notification_deliveries.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' IS NULL
                         AND wama.provider_channel_id = $3
                       )
                       OR (
                         $2 <> 'telegram'
                         AND notification_deliveries.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = $2
                         AND notification_deliveries.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $3
                         AND notification_deliveries.payload #>> '{metadata,workflowTrigger,providerBinding,providerWorkspaceId}' = $5
                         AND wama.provider_channel_id = $3
                       )
                     )
            )
          )
          OR (
            event_type = 'approval.updated'
            AND EXISTS (
              SELECT 1
                FROM workflow_approval_requests war
                JOIN workflow_approval_medium_accounts wama
                  ON (
                       wama.user_id::text = notification_deliveries.audience->>'userId'
                       OR EXISTS (
                         SELECT 1
                           FROM team_members tm
                          WHERE tm.team_id::text = notification_deliveries.audience->>'teamId'
                            AND tm.user_id = wama.user_id
                            AND tm.status = 'active'
                       )
                     )
                 AND wama.medium = $2
                 AND wama.provider_user_id = $6
                 AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
                 AND wama.disabled_at IS NULL
                JOIN workflow_approval_trigger_intents wati
                  ON wati.approval_request_id = war.id
                 AND wati.trigger_caller_key = $4
               WHERE war.id::text = notification_deliveries.payload->>'approvalRequestId'
                 AND war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
                 AND notification_deliveries.payload->>'status' IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
                 AND (
                       (
                         $2 = 'telegram'
                         AND war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = 'telegram'
                         AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $3
                       )
                       OR (
                         -- Case 2: telegram approval.updated without a binding,
                         -- delivered to the user's preferred/default account channel.
                         $2 = 'telegram'
                         AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' IS NULL
                         AND wama.provider_channel_id = $3
                       )
                       OR (
                         $2 <> 'telegram'
                         AND war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = $2
                         AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = $3
                         AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerWorkspaceId}' = $5
                         AND wama.provider_channel_id = $3
                       )
                     )
            )
          )
          OR (
            event_type = 'workflow.run.completed'
            AND EXISTS (
              SELECT 1
                FROM workflow_approval_medium_accounts wama
                JOIN workflow_approval_trigger_intents wati
                  ON wati.approval_request_id::text = notification_deliveries.payload->>'approvalRequestId'
                 AND wati.trigger_caller_key = $4
                JOIN workflow_runs wr
                  ON wr.run_id::text = notification_deliveries.payload->>'workflowRunId'
                 AND wr.approval_request_id::text = notification_deliveries.payload->>'approvalRequestId'
                 AND wr.phase = notification_deliveries.payload->>'phase'
               WHERE (
                      wama.user_id::text = notification_deliveries.audience->>'userId'
                      OR EXISTS (
                        SELECT 1
                          FROM team_members tm
                         WHERE tm.team_id::text = notification_deliveries.audience->>'teamId'
                           AND tm.user_id = wama.user_id
                           AND tm.status = 'active'
                      )
                    )
                 AND wama.medium = $2
                 AND wama.provider_user_id = $6
                 AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
                 AND wama.disabled_at IS NULL
                 AND wr.phase IN ('Succeeded', 'Failed', 'Canceled')
                 AND notification_deliveries.payload->>'providerMedium' = wama.medium
                 AND (
                       NULLIF(notification_deliveries.payload->>'providerWorkspaceId', '') IS NULL
                       OR wama.provider_workspace_id = notification_deliveries.payload->>'providerWorkspaceId'
                     )
                 AND (
                       (
                         $2 = 'telegram'
                         AND notification_deliveries.payload->>'providerChannelId' = $3
                       )
                       OR (
                         $2 <> 'telegram'
                         AND notification_deliveries.payload->>'providerChannelId' = wama.provider_channel_id
                         AND wama.provider_channel_id = $3
                       )
                     )
            )
          )
          OR (
            event_type = 'plugin_workload_sdk.notification'
            AND EXISTS (
              SELECT 1
                FROM workflow_approval_medium_accounts wama
               WHERE wama.user_id::text = notification_deliveries.audience->>'userId'
                 AND wama.medium = $2
                 AND wama.provider_user_id = $6
                 AND wama.provider_channel_id = $3
                 AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
                 AND wama.disabled_at IS NULL
            )
          )
        )
      RETURNING id, event_type AS "eventType", payload->>'notificationId' AS "notificationId"`,
    terminalParams
  )
  const row = result.rows[0] as { eventType?: string; notificationId?: string } | undefined
  return {
    updated: (result.rowCount ?? 0) > 0,
    eventType: row?.eventType ?? null,
    notificationId: row?.notificationId ?? null,
  }
}

function normalizeDeliveryBindingParams(params: {
  medium: unknown
  providerChannelId?: unknown
  providerWorkspaceId?: unknown
  hostRef?: unknown
}): [NotificationDeliveryMedium, string, string, string | null] {
  const medium = normalizeMedium(params.medium)
  if (!medium) {
    throw new Error('unsupported_notification_medium')
  }
  const providerChannelId =
    typeof params.providerChannelId === 'string' ? params.providerChannelId.trim() : ''
  if (!providerChannelId) {
    throw new Error('provider_channel_id_required')
  }
  const hostRef = normalizeHostRef(params.hostRef)
  if (!hostRef) {
    throw new Error('host_ref_required')
  }
  const providerWorkspaceId = normalizeProviderWorkspaceId(params.providerWorkspaceId)
  if (medium !== 'telegram' && !providerWorkspaceId) {
    throw new Error('provider_workspace_id_required')
  }
  return [medium, providerChannelId, hostRef, providerWorkspaceId]
}

function normalizeProviderUserId(value: unknown): string {
  const providerUserId = typeof value === 'string' ? value.trim() : ''
  if (!providerUserId) {
    throw new Error('provider_user_id_required')
  }
  return providerUserId
}

function normalizeTerminalParams(params: {
  id: string
  medium: unknown
  providerUserId?: unknown
  providerChannelId?: unknown
  providerWorkspaceId?: unknown
  hostRef?: unknown
}): [string, NotificationDeliveryMedium, string, string, string | null, string] {
  const [medium, providerChannelId, hostRef, providerWorkspaceId] =
    normalizeDeliveryBindingParams(params)
  const providerUserId = normalizeProviderUserId(params.providerUserId)
  return [params.id, medium, providerChannelId, hostRef, providerWorkspaceId, providerUserId]
}
