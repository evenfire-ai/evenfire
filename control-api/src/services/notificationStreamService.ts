import type { PoolClient } from 'pg'
import { config } from '../config.js'
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { notificationStreamEventsFilteredTotal } from '../observability/metrics.js'
import type {
  ApprovalCorrelation,
  ApprovalPayload,
  PendingApprovalSummary,
} from './userApprovalRequestService.js'

// Emit the desktop-first suppression warning at most once per process so the
// observability signal is visible without flooding the audit log on every
// stream poll.
let warnedDesktopFirstDisabled = false

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const APPROVAL_NOTIFICATION_VISIBILITY_SQL = `
        AND (
          (
            war.target_user_id = $1
            AND EXISTS (
              SELECT 1
                FROM user_workflow_triggers uwt
               WHERE uwt.recipe_namespace = war.recipe_namespace
                 AND uwt.recipe_name = war.recipe_name
                 AND uwt.user_id = $1
            )
          )
          OR (
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
        )`

export type NotificationCursor = {
  createdAt: string
  id: string
}

export type ApprovalNotificationEvent = {
  id: string
  eventType: 'approval.requested'
  cursor: string
  approval: PendingApprovalSummary
}

export type ApprovalNotificationUpdatedEvent = {
  id: string
  eventType: 'approval.updated'
  cursor: string
  approvalRequestId: string
  status: 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed'
}

export type WorkflowRunCompletedNotificationEvent = {
  id: string
  eventType: 'workflow.run.completed'
  cursor: string
  workflowRun: {
    workflowRunId: string
    approvalRequestId: string
    recipeNamespace: string
    recipeName: string
    phase: 'Succeeded' | 'Failed' | 'Canceled'
    completedAt: string
    message: string | null
    target: {
      userId: string | null
      teamId: string | null
      teamName: string | null
    }
  }
}

export type SdkNotificationSummary = {
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

export type SdkNotificationEvent = {
  id: string
  eventType: 'sdk.notification'
  cursor: string
  notification: SdkNotificationSummary
}

export type WorkflowApprovalNotificationEvent =
  | ApprovalNotificationEvent
  | ApprovalNotificationUpdatedEvent
  | WorkflowRunCompletedNotificationEvent

export type UserNotificationStreamEvent = WorkflowApprovalNotificationEvent | SdkNotificationEvent

type ApprovalNotificationRow = {
  notificationId: string
  notificationCreatedAt: string | Date
  approvalRequestId: string
  recipeNamespace: string
  recipeName: string
  requestedAt: string | Date
  expiresAt: string | Date
  payload: ApprovalPayload
  correlation: ApprovalCorrelation | null
  targetUserId: string | null
  targetTeamId: string | null
  targetTeamName: string | null
}

type ApprovalNotificationUpdatedRow = {
  notificationId: string
  notificationCreatedAt: string | Date
  approvalRequestId: string
  status: ApprovalNotificationUpdatedEvent['status']
}

type SdkNotificationRow = {
  notificationId: string
  notificationCreatedAt: string | Date
  notificationPayload: Record<string, unknown> | null
}

type WorkflowRunCompletedNotificationRow = {
  notificationId: string
  notificationCreatedAt: string | Date
  approvalRequestId: string
  recipeNamespace: string
  recipeName: string
  targetUserId: string | null
  targetTeamId: string | null
  targetTeamName: string | null
  workflowRunId: string
  phase: WorkflowRunCompletedNotificationEvent['workflowRun']['phase']
  completedAt: string | Date
  notificationPayload: Record<string, unknown> | null
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapApprovalUpdatedNotification(
  row: ApprovalNotificationUpdatedRow
): ApprovalNotificationUpdatedEvent {
  return {
    id: row.notificationId,
    eventType: 'approval.updated',
    cursor: encodeNotificationCursor({
      createdAt: toIso(row.notificationCreatedAt),
      id: row.notificationId,
    }),
    approvalRequestId: row.approvalRequestId,
    status: row.status,
  }
}

function mapWorkflowRunCompletedNotification(
  row: WorkflowRunCompletedNotificationRow
): WorkflowRunCompletedNotificationEvent {
  const payload =
    row.notificationPayload && typeof row.notificationPayload === 'object'
      ? row.notificationPayload
      : {}
  return {
    id: row.notificationId,
    eventType: 'workflow.run.completed',
    cursor: encodeNotificationCursor({
      createdAt: toIso(row.notificationCreatedAt),
      id: row.notificationId,
    }),
    workflowRun: {
      workflowRunId: row.workflowRunId,
      approvalRequestId: row.approvalRequestId,
      recipeNamespace: row.recipeNamespace,
      recipeName: row.recipeName,
      phase: row.phase,
      completedAt: toIso(row.completedAt),
      message: typeof payload.message === 'string' ? payload.message : null,
      target: {
        userId: row.targetUserId,
        teamId: row.targetTeamId,
        teamName: row.targetTeamName,
      },
    },
  }
}

function encodeNotificationCursor(cursor: NotificationCursor): string {
  return `${new Date(cursor.createdAt).toISOString()}::${cursor.id}`
}

export function parseNotificationCursor(raw: unknown): NotificationCursor | null {
  const value = String(raw || '').trim()
  if (!value) return null
  const [createdAt, id, ...rest] = value.split('::')
  if (rest.length || !createdAt || !id || !UUID_RE.test(id)) return null
  const parsed = new Date(createdAt)
  if (!Number.isFinite(parsed.getTime())) return null
  return { createdAt: parsed.toISOString(), id }
}

export function cursorPredicateSql(
  after: NotificationCursor | null | undefined,
  startIndex: number
): { sql: string; params: unknown[] } {
  if (!after) {
    return { sql: '', params: [] }
  }
  return {
    sql: `
        AND (
          nd.created_at > $${startIndex}::timestamptz
          OR (nd.created_at = $${startIndex}::timestamptz AND nd.id::text > $${startIndex + 1})
        )`,
    params: [after.createdAt, after.id],
  }
}

function mapSdkNotification(row: SdkNotificationRow): SdkNotificationEvent | null {
  const payload =
    row.notificationPayload && typeof row.notificationPayload === 'object'
      ? row.notificationPayload
      : null
  if (!payload) return null
  const title = typeof payload.title === 'string' ? payload.title : ''
  const body = typeof payload.body === 'string' ? payload.body : ''
  if (!title && !body) return null
  const actionRef =
    payload.actionRef && typeof payload.actionRef === 'object'
      ? (payload.actionRef as SdkNotificationSummary['actionRef'])
      : null
  const data =
    payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {}
  return {
    id: row.notificationId,
    eventType: 'sdk.notification',
    cursor: encodeNotificationCursor({
      createdAt: toIso(row.notificationCreatedAt),
      id: row.notificationId,
    }),
    notification: {
      notificationId:
        typeof payload.notificationId === 'string' ? payload.notificationId : row.notificationId,
      origin: 'plugin_workload_sdk',
      recipeNamespace:
        typeof payload.recipeNamespace === 'string' ? payload.recipeNamespace : 'unknown',
      recipeName: typeof payload.recipeName === 'string' ? payload.recipeName : 'unknown',
      callerRef: typeof payload.callerRef === 'string' ? payload.callerRef : 'unknown',
      eventType: typeof payload.eventType === 'string' ? payload.eventType : 'notification',
      title,
      body,
      data,
      actionRef,
      deliveryPolicyRef:
        typeof payload.deliveryPolicyRef === 'string' ? payload.deliveryPolicyRef : null,
    },
  }
}

function compareNotificationCursors(left: string, right: string): number {
  const parsedLeft = parseNotificationCursor(left)
  const parsedRight = parseNotificationCursor(right)
  if (!parsedLeft || !parsedRight) return left.localeCompare(right)
  const createdAtCompare = parsedLeft.createdAt.localeCompare(parsedRight.createdAt)
  if (createdAtCompare !== 0) return createdAtCompare
  return parsedLeft.id.localeCompare(parsedRight.id)
}

function mergeNotificationStreamEvents(
  events: UserNotificationStreamEvent[],
  limit = 50
): UserNotificationStreamEvent[] {
  return [...events]
    .sort((left, right) => compareNotificationCursors(left.cursor, right.cursor))
    .slice(0, limit)
}

function mapApprovalNotification(row: ApprovalNotificationRow): ApprovalNotificationEvent {
  const cursor = encodeNotificationCursor({
    createdAt: toIso(row.notificationCreatedAt),
    id: row.notificationId,
  })
  return {
    id: row.notificationId,
    eventType: 'approval.requested',
    cursor,
    approval: {
      id: row.approvalRequestId,
      recipeNamespace: row.recipeNamespace,
      recipeName: row.recipeName,
      requestedAt: toIso(row.requestedAt),
      expiresAt: toIso(row.expiresAt),
      payload: row.payload,
      correlation: row.correlation,
      target: {
        userId: row.targetUserId,
        teamId: row.targetTeamId,
        teamName: row.targetTeamName,
      },
    },
  }
}

export function newestNotificationCursor(
  events: Array<{ cursor: string }>,
  fallback: string | null = null
): string | null {
  return events.length ? events[events.length - 1]!.cursor : fallback
}

export async function listActiveApprovalNotificationsForUser(
  userId: string,
  options: { limit?: number; after?: NotificationCursor | null } = {}
): Promise<ApprovalNotificationEvent[]> {
  const safeLimit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit!)))
    : 50
  const after = options.after ?? null
  const values: unknown[] = [userId, safeLimit]
  const { sql: cursorPredicate, params: cursorParams } = cursorPredicateSql(after, 3)
  values.push(...cursorParams)

  const result = await pool.query(
    `SELECT nd.id AS "notificationId",
            nd.created_at AS "notificationCreatedAt",
            war.id AS "approvalRequestId",
            war.recipe_namespace AS "recipeNamespace",
            war.recipe_name AS "recipeName",
            war.requested_at AS "requestedAt",
            war.expires_at AS "expiresAt",
            war.payload,
            war.correlation,
            war.target_user_id AS "targetUserId",
            war.target_team_id AS "targetTeamId",
            t.name AS "targetTeamName"
       FROM notification_deliveries nd
       JOIN workflow_approval_requests war
         ON war.id::text = nd.payload->>'approvalRequestId'
  LEFT JOIN teams t
         ON t.id = war.target_team_id
      WHERE nd.event_type = 'approval.requested'
        AND nd.expires_at > NOW()
        AND war.status = 'pending'
        AND war.expires_at > NOW()
        ${APPROVAL_NOTIFICATION_VISIBILITY_SQL}
        ${cursorPredicate}
      ORDER BY nd.created_at ASC, nd.id ASC
      LIMIT $2`,
    values
  )

  return (result.rows as ApprovalNotificationRow[]).map(mapApprovalNotification)
}

export async function listSdkNotificationEventsForUser(
  userId: string,
  options: { limit?: number; after?: NotificationCursor | null } = {}
): Promise<SdkNotificationEvent[]> {
  if (!config.notificationsDesktopFirstEnabled) {
    // Feature flag is suppressing ALL SDK notification delivery. Surface this
    // so an operator can tell deliberate-disable apart from silent data loss.
    notificationStreamEventsFilteredTotal.inc({ reason: 'desktop_first_disabled' }, 1)
    if (!warnedDesktopFirstDisabled) {
      warnedDesktopFirstDisabled = true
      rootLogger.warn(
        { event: 'sdk_notifications_suppressed_by_feature_flag' },
        'NOTIFICATIONS_DESKTOP_FIRST_ENABLED is false — all plugin-workload-sdk notifications are being suppressed (not delivered)'
      )
    }
    return []
  }

  const safeLimit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit!)))
    : 50
  const after = options.after ?? null
  const values: unknown[] = [userId, safeLimit]
  const { sql: cursorPredicate, params: cursorParams } = cursorPredicateSql(after, 3)
  values.push(...cursorParams)

  const result = await pool.query(
    // Two audience shapes are deliverable to a user:
    //   1. audience.userId — the notification was enqueued with a resolved
    //      control-plane user id (userRef path).
    //   2. audience.targetRef — an opaque provider identity (targetRef path).
    //      Without this OR clause, targetRef-addressed rows stay 'queued'
    //      forever (DATA LOSS). We resolve them here against the user's active
    //      verified medium accounts: a targetRef matching one of the user's
    //      provider_user_id values is delivered to that user.
    `SELECT nd.id AS "notificationId",
            nd.created_at AS "notificationCreatedAt",
            nd.payload AS "notificationPayload"
       FROM notification_deliveries nd
      WHERE nd.event_type = 'plugin_workload_sdk.notification'
        AND (
          nd.audience->>'userId' = $1
          OR (
            nd.audience->>'targetRef' IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM workflow_approval_medium_accounts wama
               WHERE wama.user_id = $1::uuid
                 AND wama.disabled_at IS NULL
                 AND wama.provider_user_id = nd.audience->>'targetRef'
            )
          )
        )
        AND nd.status IN ('queued', 'retrying')
        AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
        ${cursorPredicate}
      ORDER BY nd.created_at ASC, nd.id ASC
      LIMIT $2`,
    values
  )

  return (result.rows as SdkNotificationRow[])
    .map(mapSdkNotification)
    .filter((event): event is SdkNotificationEvent => event !== null)
}

export async function listNotificationStreamEventsForUser(
  userId: string,
  options: { limit?: number; after?: NotificationCursor | null } = {}
): Promise<UserNotificationStreamEvent[]> {
  const safeLimit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit!)))
    : 50
  const [approvalEvents, sdkEvents] = await Promise.all([
    listApprovalNotificationEventsForUser(userId, { ...options, limit: safeLimit }),
    listSdkNotificationEventsForUser(userId, { ...options, limit: safeLimit }),
  ])
  return mergeNotificationStreamEvents([...approvalEvents, ...sdkEvents], safeLimit)
}

export async function listApprovalNotificationEventsForUser(
  userId: string,
  options: { limit?: number; after?: NotificationCursor | null } = {}
): Promise<WorkflowApprovalNotificationEvent[]> {
  const safeLimit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit!)))
    : 50
  const after = options.after ?? null
  const values: unknown[] = [userId, safeLimit]
  const { sql: cursorPredicate, params: cursorParams } = cursorPredicateSql(after, 3)
  values.push(...cursorParams)

  const result = await pool.query(
    `SELECT nd.id AS "notificationId",
            nd.event_type AS "eventType",
            nd.created_at AS "notificationCreatedAt",
            war.id AS "approvalRequestId",
            war.recipe_namespace AS "recipeNamespace",
            war.recipe_name AS "recipeName",
            war.requested_at AS "requestedAt",
            war.expires_at AS "expiresAt",
            war.payload,
            war.correlation,
            war.target_user_id AS "targetUserId",
            war.target_team_id AS "targetTeamId",
            t.name AS "targetTeamName",
            nd.payload->>'status' AS "status",
            wr.run_id AS "workflowRunId",
            wr.phase AS "phase",
            COALESCE(wr.completed_at, wr.updated_at, nd.created_at) AS "completedAt",
            nd.payload AS "notificationPayload"
       FROM notification_deliveries nd
       JOIN workflow_approval_requests war
         ON war.id::text = nd.payload->>'approvalRequestId'
  LEFT JOIN workflow_runs wr
         ON nd.event_type = 'workflow.run.completed'
        AND wr.run_id::text = nd.payload->>'workflowRunId'
        AND wr.approval_request_id::text = nd.payload->>'approvalRequestId'
        AND wr.phase = nd.payload->>'phase'
  LEFT JOIN teams t
         ON t.id = war.target_team_id
      WHERE nd.event_type IN ('approval.requested', 'approval.updated', 'workflow.run.completed')
        AND nd.expires_at > NOW()
        AND (
          (
            nd.event_type = 'approval.requested'
            AND war.status = 'pending'
            AND war.expires_at > NOW()
          )
          OR (
            nd.event_type = 'approval.updated'
            AND war.status IN ('approved', 'denied', 'cancelled', 'expired', 'consumed')
          )
          OR (
            nd.event_type = 'workflow.run.completed'
            AND wr.phase IN ('Succeeded', 'Failed', 'Canceled')
          )
        )
        ${APPROVAL_NOTIFICATION_VISIBILITY_SQL}
        ${cursorPredicate}
      ORDER BY nd.created_at ASC, nd.id ASC
      LIMIT $2`,
    values
  )

  return result.rows
    .map(row => {
      const typed = row as ApprovalNotificationRow &
        ApprovalNotificationUpdatedRow &
        WorkflowRunCompletedNotificationRow & { eventType: string }
      if (typed.eventType === 'approval.requested') {
        return mapApprovalNotification(typed)
      }
      if (
        typed.eventType === 'approval.updated' &&
        ['approved', 'denied', 'cancelled', 'expired', 'consumed'].includes(typed.status)
      ) {
        return mapApprovalUpdatedNotification(typed)
      }
      if (
        typed.eventType === 'workflow.run.completed' &&
        ['Succeeded', 'Failed', 'Canceled'].includes(String(typed.phase || '')) &&
        typeof typed.workflowRunId === 'string'
      ) {
        return mapWorkflowRunCompletedNotification(typed)
      }
      return null
    })
    .filter((event): event is WorkflowApprovalNotificationEvent => event !== null)
}

export async function openNotificationQueueListener(): Promise<PoolClient> {
  const client = await pool.connect()
  await client.query('LISTEN notification_queued')
  return client
}
