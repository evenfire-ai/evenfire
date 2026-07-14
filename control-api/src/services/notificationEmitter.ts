import { config } from '../config.js'
import { type DbClient, pool } from '../db.js'
import {
  notificationEventsEnqueuedTotal,
  notificationOutboxEnqueueFailuresTotal,
} from '../observability/metrics.js'

export type ApprovalRequestedNotificationPayload = {
  approvalRequestId: string
  recipeNamespace: string
  recipeName: string
  title: string
  body: string
  actions: Array<{ id: string; decision: 'approve' | 'deny'; label: string }>
  metadata: unknown
}

function notificationAudience(params: {
  targetUserId?: string | null
  targetTeamId?: string | null
}) {
  return params.targetUserId ? { userId: params.targetUserId } : { teamId: params.targetTeamId }
}

function createApprovalActions(
  approvalRequestId: string
): ApprovalRequestedNotificationPayload['actions'] {
  return [
    { id: `approve:${approvalRequestId}`, decision: 'approve', label: 'Approve' },
    { id: `deny:${approvalRequestId}`, decision: 'deny', label: 'Deny' },
  ]
}

export async function emitNotification(
  params: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    targetUserId?: string
    targetTeamId?: string
    payload: { message: string; options?: string[]; metadata?: unknown }
    expiresAt: string
  },
  options?: { db?: DbClient }
): Promise<void> {
  await enqueueApprovalRequestedNotification(options?.db ?? pool, params)
}

export async function enqueueApprovalRequestedNotification(
  db: DbClient,
  params: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    targetUserId?: string
    targetTeamId?: string
    payload: { message: string; options?: string[]; metadata?: unknown }
    expiresAt: string
  }
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO notification_deliveries
         (event_type, dedupe_key, audience, payload, priority, status, expires_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'queued', $6)`,
      [
        'approval.requested',
        `${params.approvalRequestId}:approval.requested`,
        JSON.stringify(notificationAudience(params)),
        JSON.stringify({
          approvalRequestId: params.approvalRequestId,
          recipeNamespace: params.recipeNamespace,
          recipeName: params.recipeName,
          title: params.payload.message,
          body: `Approval requested for ${params.recipeNamespace}/${params.recipeName}`,
          actions: createApprovalActions(params.approvalRequestId),
          metadata: params.payload.metadata ?? {},
        }),
        'normal',
        params.expiresAt,
      ]
    )
    notificationEventsEnqueuedTotal.inc({ event_type: 'approval.requested' }, 1)
  } catch (error) {
    notificationOutboxEnqueueFailuresTotal.inc({ event_type: 'approval.requested' }, 1)
    throw error
  }
}

/**
 * Plugin Workload SDK notification intent (plan §4.2). Enqueued only AFTER
 * the authorizer accepted the intent and the invocation audit record exists.
 * Records carry origin/recipe/caller so delivery workers and the audit UI
 * can attribute them without reinterpretation.
 *
 * Audience resolution (v1): userRef maps to audience.userId (the existing
 * medium-account join resolves the delivery channel). targetRef audiences
 * are persisted verbatim — claimable delivery for opaque target refs lands
 * with deliveryPolicyRef resolution (v1.1+); until then they remain queued
 * until expiry, while the intent stays fully audited.
 */
export async function enqueuePluginWorkloadSdkNotification(
  db: DbClient,
  params: {
    notificationId: string
    recipeNamespace: string
    recipeName: string
    callerRef: string
    eventType: string
    userRef?: string
    targetRef?: string
    title: string
    body: string
    data?: Record<string, unknown>
    actionRef?: { type: string; id: string; urlRef?: string }
    deliveryPolicyRef?: string
  }
): Promise<void> {
  const deliveryEventType = 'plugin_workload_sdk.notification'
  const audience = params.userRef ? { userId: params.userRef } : { targetRef: params.targetRef }
  const desktopFirst = Boolean(
    config.notificationsDesktopFirstEnabled && typeof params.userRef === 'string' && params.userRef
  )
  // Defensive: config already sanitizes this, but guard against a non-finite
  // value ever reaching the SQL make_interval($7::int) bind.
  const rawGrace = config.notificationDesktopGraceSeconds
  const graceSeconds = Number.isFinite(rawGrace) ? Math.max(0, Math.floor(rawGrace)) : 90
  try {
    await db.query(
      `INSERT INTO notification_deliveries
         (event_type, dedupe_key, audience, payload, priority, status, next_attempt_at, expires_at)
       VALUES (
         $1,
         $2,
         $3::jsonb,
         $4::jsonb,
         $5,
         'queued',
         CASE
           WHEN $6::boolean THEN NOW() + make_interval(secs => $7::int)
           ELSE NOW()
         END,
         NOW() + INTERVAL '72 hours'
       )
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        deliveryEventType,
        `${params.notificationId}:${deliveryEventType}`,
        JSON.stringify(audience),
        JSON.stringify({
          notificationId: params.notificationId,
          origin: 'plugin_workload_sdk',
          recipeNamespace: params.recipeNamespace,
          recipeName: params.recipeName,
          callerRef: params.callerRef,
          eventType: params.eventType,
          title: params.title,
          body: params.body,
          data: params.data ?? {},
          actionRef: params.actionRef ?? null,
          deliveryPolicyRef: params.deliveryPolicyRef ?? null,
        }),
        'normal',
        desktopFirst,
        graceSeconds,
      ]
    )
    notificationEventsEnqueuedTotal.inc({ event_type: deliveryEventType }, 1)
  } catch (error) {
    notificationOutboxEnqueueFailuresTotal.inc({ event_type: deliveryEventType }, 1)
    throw error
  }
}

export async function enqueueApprovalUpdatedNotification(
  db: DbClient,
  params: {
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    targetUserId?: string | null
    targetTeamId?: string | null
    status: 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed'
  }
): Promise<void> {
  const eventType = 'approval.updated'
  try {
    await db.query(
      `INSERT INTO notification_deliveries
         (event_type, dedupe_key, audience, payload, priority, status, expires_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'queued', NOW() + INTERVAL '5 minutes')
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        eventType,
        `${params.approvalRequestId}:approval.updated:${params.status}`,
        JSON.stringify(notificationAudience(params)),
        JSON.stringify({
          approvalRequestId: params.approvalRequestId,
          recipeNamespace: params.recipeNamespace,
          recipeName: params.recipeName,
          status: params.status,
        }),
        'normal',
      ]
    )
    notificationEventsEnqueuedTotal.inc({ event_type: eventType }, 1)
  } catch (error) {
    notificationOutboxEnqueueFailuresTotal.inc({ event_type: eventType }, 1)
    throw error
  }
}
