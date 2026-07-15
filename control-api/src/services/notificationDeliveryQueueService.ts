import { type DbClient, pool, withTransaction } from '../db.js'

type NotificationDeliveryMedium = 'telegram' | 'slack' | 'teams'

type ClaimedNotificationDeliveryBase = {
  id: string
  medium: NotificationDeliveryMedium
  providerUserId: string
  providerWorkspaceId: string | null
  providerChannelId: string
  attempts: number
  // Figure D multi-bot: the CommunicationChannel ("namespace/name") this
  // verified account is bound to. NULL for legacy/non-wama rows; the delivery
  // worker resolves the per-channel bot from it and skips delivery when absent.
  communicationChannelRef: string | null
}

export type ApprovalRequestedNotificationDelivery = ClaimedNotificationDeliveryBase & {
  eventType: 'approval.requested'
  payload: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    title: string
    body: string
    actions?: Array<{ id: string; label: string }>
    metadata?: Record<string, unknown> | null
  }
}

export type ApprovalUpdatedNotificationDelivery = ClaimedNotificationDeliveryBase & {
  eventType: 'approval.updated'
  payload: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    status: 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed'
  }
}

export type WorkflowRunCompletedNotificationDelivery = ClaimedNotificationDeliveryBase & {
  eventType: 'workflow.run.completed'
  payload: {
    workflowRunId: string
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    phase: 'Succeeded' | 'Failed' | 'Canceled'
    providerMedium: NotificationDeliveryMedium
    providerChannelId: string
    providerWorkspaceId?: string | null
    providerThreadId?: string | null
    hasDownloadableItems?: boolean
    completedAt?: string
    message?: string
  }
}

export type PluginWorkloadSdkNotificationDelivery = ClaimedNotificationDeliveryBase & {
  eventType: 'plugin_workload_sdk.notification'
  payload: {
    notificationId: string
    origin: 'plugin_workload_sdk'
    recipeNamespace: string
    recipeName: string
    callerRef: string
    eventType: string
    title: string
    body: string
    data: Record<string, unknown>
    actionRef: { type: string; id: string; urlRef?: string } | null
    deliveryPolicyRef: string | null
  }
}

export type ClaimedNotificationDelivery =
  | ApprovalRequestedNotificationDelivery
  | ApprovalUpdatedNotificationDelivery
  | WorkflowRunCompletedNotificationDelivery
  | PluginWorkloadSdkNotificationDelivery

export type UserBoundNotificationDelivery = ClaimedNotificationDelivery & {
  mcpHostRef: string
}

export type WorkflowApprovalUserBoundNotificationDelivery = (
  | ApprovalRequestedNotificationDelivery
  | ApprovalUpdatedNotificationDelivery
  | WorkflowRunCompletedNotificationDelivery
) & {
  mcpHostRef: string
}

const SUPPORTED_DELIVERY_MEDIA = new Set(['telegram', 'slack', 'teams'])
const MAX_PROVIDER_CHANNEL_IDS = 100

function normalizeMedium(value: unknown): NotificationDeliveryMedium | null {
  const medium = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SUPPORTED_DELIVERY_MEDIA.has(medium) ? (medium as NotificationDeliveryMedium) : null
}

function normalizeProviderChannelIds(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const unique = Array.from(
    new Set(
      values
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(value => value.length > 0)
    )
  )
  if (unique.length > MAX_PROVIDER_CHANNEL_IDS) {
    throw new Error('provider_channel_id_limit_exceeded')
  }
  return unique
}

function normalizeHostRef(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeProviderWorkspaceId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized ? normalized : null
}

function normalizeLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 10
  return Math.max(1, Math.min(50, Math.floor(parsed)))
}

export async function claimUserBoundNotificationDeliveries(params: {
  medium: unknown
  providerWorkspaceId?: unknown
  limit?: unknown
  db?: DbClient
}): Promise<WorkflowApprovalUserBoundNotificationDelivery[]> {
  const medium = normalizeMedium(params.medium)
  if (!medium) {
    throw new Error('unsupported_notification_medium')
  }
  const providerWorkspaceId = normalizeProviderWorkspaceId(params.providerWorkspaceId)
  const limit = normalizeLimit(params.limit)

  const run = async (db: DbClient) => {
    const result = await db.query(
      `WITH bound_accounts AS (
         SELECT wama.user_id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                wama.provider_channel_id,
                wama.communication_channel_ref
           FROM workflow_approval_medium_accounts wama
          WHERE wama.medium = $1
            AND wama.disabled_at IS NULL
            AND wama.provider_channel_id IS NOT NULL
            AND wama.provider_channel_id <> ''
            AND ($3::text IS NULL OR wama.provider_workspace_id = $3)
            AND NOT EXISTS (
                  SELECT 1
                    FROM workflow_approval_medium_accounts preferred
                   WHERE preferred.user_id = wama.user_id
                     AND preferred.disabled_at IS NULL
                     AND (
                          preferred.updated_at > wama.updated_at
                          OR (
                            preferred.updated_at = wama.updated_at
                            AND preferred.created_at > wama.created_at
                          )
                          OR (
                            preferred.updated_at = wama.updated_at
                            AND preferred.created_at = wama.created_at
                            AND preferred.id < wama.id
                          )
                     )
                )
       ),
       candidates AS (
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                wama.provider_channel_id,
                wama.communication_channel_ref,
                COALESCE(
                  NULLIF(war.payload #>> '{metadata,runtimeMcpHostRef}', ''),
                  wati.trigger_caller_key,
                  war.recipe_namespace || '/' || war.recipe_name
                ) AS mcp_host_ref,
                CASE WHEN nd.priority = 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
           JOIN workflow_approval_requests war
             ON war.id::text = nd.payload->>'approvalRequestId'
            AND war.status = 'pending'
            AND (war.expires_at IS NULL OR war.expires_at > NOW())
            AND NULLIF(war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}', '') IS NULL
           LEFT JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id = war.id
           JOIN bound_accounts wama
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
          WHERE nd.event_type = 'approval.requested'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND COALESCE(
                  NULLIF(war.payload #>> '{metadata,runtimeMcpHostRef}', ''),
                  wati.trigger_caller_key,
                  war.recipe_namespace || '/' || war.recipe_name
                ) ~ '^sandbox-recipes/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
        UNION ALL
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                wama.provider_channel_id,
                wama.communication_channel_ref,
                COALESCE(
                  NULLIF(war.payload #>> '{metadata,runtimeMcpHostRef}', ''),
                  wati.trigger_caller_key,
                  war.recipe_namespace || '/' || war.recipe_name
                ) AS mcp_host_ref,
                CASE WHEN nd.priority = 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
           JOIN workflow_approval_requests war
             ON war.id::text = nd.payload->>'approvalRequestId'
            AND war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
            AND NULLIF(war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}', '') IS NULL
           LEFT JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id = war.id
           JOIN bound_accounts wama
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
          WHERE nd.event_type = 'approval.updated'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND nd.payload->>'status' IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
            AND COALESCE(
                  NULLIF(war.payload #>> '{metadata,runtimeMcpHostRef}', ''),
                  wati.trigger_caller_key,
                  war.recipe_namespace || '/' || war.recipe_name
                ) ~ '^sandbox-recipes/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
        UNION ALL
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                wama.provider_channel_id,
                wama.communication_channel_ref,
                COALESCE(wati.trigger_caller_key, wr.recipe_namespace || '/' || wr.recipe_name) AS mcp_host_ref,
                CASE WHEN nd.priority = 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
           JOIN workflow_runs wr
             ON wr.run_id::text = nd.payload->>'workflowRunId'
            AND wr.approval_request_id::text = nd.payload->>'approvalRequestId'
            AND wr.phase = nd.payload->>'phase'
           LEFT JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id::text = nd.payload->>'approvalRequestId'
           JOIN bound_accounts wama
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
          WHERE nd.event_type = 'workflow.run.completed'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND wr.phase IN ('Succeeded', 'Failed', 'Canceled')
            AND NULLIF(nd.payload->>'providerMedium', '') IS NULL
            AND COALESCE(wati.trigger_caller_key, wr.recipe_namespace || '/' || wr.recipe_name) LIKE 'sandbox-recipes/%'
       ),
       locked AS (
         SELECT nd.id,
                c.medium,
                c.provider_user_id,
                c.provider_workspace_id,
                c.provider_channel_id,
                c.communication_channel_ref,
                c.mcp_host_ref
           FROM notification_deliveries nd
           JOIN candidates c ON c.id = nd.id
          ORDER BY c.sort_priority ASC,
                   c.created_at ASC,
                   nd.id ASC
          LIMIT $2
          FOR UPDATE OF nd SKIP LOCKED
       ),
       claimed AS (
         UPDATE notification_deliveries nd
            SET status = 'retrying',
                attempts = nd.attempts + 1,
                next_attempt_at = NOW() + INTERVAL '30 seconds'
           FROM locked c
          WHERE nd.id = c.id
      RETURNING nd.id,
                nd.event_type AS "eventType",
                nd.payload,
                nd.attempts,
                c.medium,
                c.provider_user_id AS "providerUserId",
                c.provider_workspace_id AS "providerWorkspaceId",
                c.provider_channel_id AS "providerChannelId",
                c.communication_channel_ref AS "communicationChannelRef",
                c.mcp_host_ref AS "mcpHostRef"
       )
       SELECT *
         FROM claimed
        ORDER BY attempts ASC`,
      [medium, limit, providerWorkspaceId]
    )
    return result.rows as WorkflowApprovalUserBoundNotificationDelivery[]
  }

  return params.db ? run(params.db) : withTransaction(run)
}

export async function claimNotificationDeliveries(params: {
  medium: unknown
  hostRef?: unknown
  providerChannelIds?: unknown
  providerWorkspaceId?: unknown
  limit?: unknown
  db?: DbClient
}): Promise<ClaimedNotificationDelivery[]> {
  const medium = normalizeMedium(params.medium)
  if (!medium) {
    throw new Error('unsupported_notification_medium')
  }
  const providerChannelIds = normalizeProviderChannelIds(params.providerChannelIds)
  if (providerChannelIds.length === 0) {
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
  const limit = normalizeLimit(params.limit)

  const run = async (db: DbClient) => {
    const result = await db.query(
      `WITH candidates AS (
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' AS provider_channel_id,
                CASE nd.priority WHEN 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
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
            AND wama.disabled_at IS NULL
            AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
           JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id::text = nd.payload->>'approvalRequestId'
            AND wati.trigger_caller_key = $3
           JOIN workflow_approval_requests war
             ON war.id::text = nd.payload->>'approvalRequestId'
            AND war.status = 'pending'
            AND (war.expires_at IS NULL OR war.expires_at > NOW())
          WHERE nd.event_type = 'approval.requested'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = $1
            AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = ANY($2::text[])
            AND (
                  $1 = 'telegram'
                  OR war.payload #>> '{metadata,workflowTrigger,providerBinding,providerWorkspaceId}' = $5
                )
            AND (
                  $1 = 'telegram'
                  OR wama.provider_channel_id = war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}'
                )
        UNION ALL
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                CASE WHEN $1 = 'telegram'
                  THEN nd.payload->>'providerChannelId'
                  ELSE wama.provider_channel_id
                END AS provider_channel_id,
                CASE nd.priority WHEN 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
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
            AND wama.disabled_at IS NULL
            AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
           JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id::text = nd.payload->>'approvalRequestId'
            AND wati.trigger_caller_key = $3
           JOIN workflow_runs wr
             ON wr.run_id::text = nd.payload->>'workflowRunId'
            AND wr.approval_request_id::text = nd.payload->>'approvalRequestId'
            AND wr.phase = nd.payload->>'phase'
          WHERE nd.event_type = 'workflow.run.completed'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND wr.phase IN ('Succeeded', 'Failed', 'Canceled')
            AND nd.payload->>'providerMedium' = wama.medium
            AND (
                  NULLIF(nd.payload->>'providerWorkspaceId', '') IS NULL
                  OR wama.provider_workspace_id = nd.payload->>'providerWorkspaceId'
                )
            AND (
                  (
                    $1 = 'telegram'
                    AND nd.payload->>'providerChannelId' = ANY($2::text[])
                  )
                  OR (
                    $1 <> 'telegram'
                    AND nd.payload->>'providerChannelId' = wama.provider_channel_id
                    AND wama.provider_channel_id IS NOT NULL
                    AND wama.provider_channel_id = ANY($2::text[])
                  )
                )
        UNION ALL
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' AS provider_channel_id,
                CASE nd.priority WHEN 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
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
            AND wama.disabled_at IS NULL
            AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
           JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id::text = nd.payload->>'approvalRequestId'
            AND wati.trigger_caller_key = $3
          WHERE nd.event_type = 'approval.updated'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
            AND nd.payload->>'status' IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
            AND war.payload #>> '{metadata,workflowTrigger,providerBinding,medium}' = $1
            AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' = ANY($2::text[])
            AND (
                  $1 = 'telegram'
                  OR war.payload #>> '{metadata,workflowTrigger,providerBinding,providerWorkspaceId}' = $5
                )
            AND (
                  $1 = 'telegram'
                  OR wama.provider_channel_id = war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}'
                )
        UNION ALL
         -- Case 2: workflow-recipe approval WITHOUT a conversational origin
         -- channel (no providerBinding) — e.g. a recipe triggered by schedule
         -- or UI that requests approval mid-run. Routes to the user's preferred
         -- delivery instance (strict) or the most-recently-verified default.
         -- Telegram-only: Slack routing is not fully developed yet, and a
         -- Telegram approval WITHOUT a binding matches no other branch, so this
         -- does not overlap or change the conversational case 1.
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                wama.provider_channel_id AS provider_channel_id,
                CASE nd.priority WHEN 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
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
            AND wama.disabled_at IS NULL
           JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id::text = nd.payload->>'approvalRequestId'
            AND wati.trigger_caller_key = $3
           JOIN workflow_approval_requests war
             ON war.id::text = nd.payload->>'approvalRequestId'
            AND war.status = 'pending'
            AND (war.expires_at IS NULL OR war.expires_at > NOW())
           LEFT JOIN user_notification_preferences unp
             ON unp.user_id = wama.user_id
          WHERE nd.event_type = 'approval.requested'
            AND $1 = 'telegram'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' IS NULL
            AND wama.provider_channel_id IS NOT NULL
            AND wama.provider_channel_id = ANY($2::text[])
            AND (
              CASE
                WHEN unp.preferred_account_id IS NOT NULL
                  THEN wama.id = unp.preferred_account_id
                ELSE wama.medium = COALESCE(
                  unp.preferred_medium,
                  (
                    SELECT wama2.medium
                      FROM workflow_approval_medium_accounts wama2
                     WHERE wama2.user_id = wama.user_id
                       AND wama2.disabled_at IS NULL
                     ORDER BY wama2.verified_at DESC
                     LIMIT 1
                  )
                )
              END
            )
        UNION ALL
         -- Case 2 (continued): approval.updated for a non-conversational
         -- workflow-recipe approval. Same Telegram-only, no-binding routing.
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                wama.provider_channel_id AS provider_channel_id,
                CASE nd.priority WHEN 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
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
            AND wama.disabled_at IS NULL
           JOIN workflow_approval_trigger_intents wati
             ON wati.approval_request_id::text = nd.payload->>'approvalRequestId'
            AND wati.trigger_caller_key = $3
           JOIN workflow_approval_requests war
             ON war.id::text = nd.payload->>'approvalRequestId'
          LEFT JOIN user_notification_preferences unp
             ON unp.user_id = wama.user_id
          WHERE nd.event_type = 'approval.updated'
            AND $1 = 'telegram'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
            AND nd.payload->>'status' IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
            AND war.payload #>> '{metadata,workflowTrigger,providerBinding,providerChannelId}' IS NULL
            AND wama.provider_channel_id IS NOT NULL
            AND wama.provider_channel_id = ANY($2::text[])
            AND (
              CASE
                WHEN unp.preferred_account_id IS NOT NULL
                  THEN wama.id = unp.preferred_account_id
                ELSE wama.medium = COALESCE(
                  unp.preferred_medium,
                  (
                    SELECT wama2.medium
                      FROM workflow_approval_medium_accounts wama2
                     WHERE wama2.user_id = wama.user_id
                       AND wama2.disabled_at IS NULL
                     ORDER BY wama2.verified_at DESC
                     LIMIT 1
                  )
                )
              END
            )
        UNION ALL
         -- Plugin Workload SDK notifications: channel fallback after the
         -- desktop grace window. Honors the per-user preferred delivery
         -- instance, and can be disabled entirely via user_notification_preferences.
         SELECT nd.id,
                wama.medium,
                wama.provider_user_id,
                wama.provider_workspace_id,
                wama.provider_channel_id AS provider_channel_id,
                CASE nd.priority WHEN 'high' THEN 0 ELSE 1 END AS sort_priority,
                nd.created_at
           FROM notification_deliveries nd
           JOIN workflow_approval_medium_accounts wama
             ON wama.user_id::text = nd.audience->>'userId'
            AND wama.medium = $1
            AND wama.disabled_at IS NULL
            AND ($5::text IS NULL OR wama.provider_workspace_id = $5)
           LEFT JOIN user_notification_preferences unp
             ON unp.user_id = wama.user_id
          WHERE nd.event_type = 'plugin_workload_sdk.notification'
            AND nd.status IN ('queued', 'retrying')
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND COALESCE(unp.channel_fallback_enabled, true) = true
            AND wama.provider_channel_id IS NOT NULL
            AND wama.provider_channel_id = ANY($2::text[])
            -- Preference precedence: a preferred instance (account id) wins and
            -- is STRICT — only that account matches; if it is disabled the
            -- disabled_at filter above drops every row (no fallback). Otherwise
            -- fall back to preferred medium, then the most-recently-verified.
            AND (
              CASE
                WHEN unp.preferred_account_id IS NOT NULL
                  THEN wama.id = unp.preferred_account_id
                ELSE wama.medium = COALESCE(
                  unp.preferred_medium,
                  (
                    SELECT wama2.medium
                      FROM workflow_approval_medium_accounts wama2
                     WHERE wama2.user_id = wama.user_id
                       AND wama2.disabled_at IS NULL
                     ORDER BY wama2.verified_at DESC
                     LIMIT 1
                  )
                )
              END
            )
       ),
       locked AS (
         SELECT nd.id,
                c.medium,
                c.provider_user_id,
                c.provider_workspace_id,
                c.provider_channel_id
           FROM notification_deliveries nd
           JOIN candidates c ON c.id = nd.id
          ORDER BY c.sort_priority ASC,
                   c.created_at ASC,
                   nd.id ASC
          LIMIT $4
          FOR UPDATE OF nd SKIP LOCKED
       ),
       claimed AS (
         UPDATE notification_deliveries nd
            SET status = 'retrying',
                attempts = nd.attempts + 1,
                next_attempt_at = NOW() + INTERVAL '30 seconds'
           FROM locked c
          WHERE nd.id = c.id
      RETURNING nd.id,
                nd.event_type AS "eventType",
                nd.payload,
                nd.attempts,
                c.medium,
                c.provider_user_id AS "providerUserId",
                c.provider_workspace_id AS "providerWorkspaceId",
                c.provider_channel_id AS "providerChannelId"
       )
       SELECT *
         FROM claimed
        ORDER BY attempts ASC`,
      [medium, providerChannelIds, hostRef, limit, providerWorkspaceId]
    )
    return result.rows as ClaimedNotificationDelivery[]
  }

  return params.db ? run(params.db) : withTransaction(run)
}

export async function markUserBoundNotificationDeliverySent(
  id: string,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query(
    `UPDATE notification_deliveries
        SET status = 'sent'
      WHERE id = $1
        AND event_type IN ('approval.requested', 'approval.updated', 'workflow.run.completed')
        AND status IN ('queued', 'retrying')
      RETURNING id`,
    [id]
  )
  return (result.rowCount ?? 0) > 0
}

export async function markUserBoundNotificationDeliveryFailed(
  id: string,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query(
    `UPDATE notification_deliveries
        SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'retrying' END,
            next_attempt_at = NOW() + INTERVAL '60 seconds'
      WHERE id = $1
        AND event_type IN ('approval.requested', 'approval.updated', 'workflow.run.completed')
        AND status IN ('queued', 'retrying')
      RETURNING id`,
    [id]
  )
  return (result.rowCount ?? 0) > 0
}

// Figure D multi-bot: terminal outcome when no bot credential can be resolved
// for the delivery's CommunicationChannel (Secret/CC absent). NOT `sent` (the
// message never left) and NOT `retrying`/`failed` (retrying is pointless — the
// channel simply has no bot configured). A distinct `skipped_no_bot` status
// makes suppressed deliveries auditable (vs being indistinguishable from a
// provider failure). The worker also emits a metric + structured log.
export async function markUserBoundNotificationDeliverySkippedNoBot(
  id: string,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query(
    `UPDATE notification_deliveries
        SET status = 'skipped_no_bot'
      WHERE id = $1
        AND event_type IN ('approval.requested', 'approval.updated', 'workflow.run.completed')
        AND status IN ('queued', 'retrying')
      RETURNING id`,
    [id]
  )
  return (result.rowCount ?? 0) > 0
}

export {
  acknowledgeNotificationDelivery,
  failNotificationDelivery,
  resolvePendingWorkflowApprovalDelivery,
  type ResolvePendingWorkflowApprovalDeliveryResult,
} from './notificationDeliveryTerminalService.js'
