import { type DbClient, pool } from '../db.js'
import { markSdkNotificationDelivered } from './pluginWorkloadSdkInvocationAuditor.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AcknowledgeDesktopNotificationResult =
  | { status: 'acked' }
  | { status: 'already_terminal' }
  | { status: 'not_found' }

export async function acknowledgeDesktopNotificationDelivery(
  userId: string,
  notificationId: string,
  db: DbClient = pool
): Promise<AcknowledgeDesktopNotificationResult> {
  const normalizedId = String(notificationId || '').trim()
  if (!UUID_RE.test(normalizedId)) {
    return { status: 'not_found' }
  }

  const updated = await db.query(
    `UPDATE notification_deliveries
        SET status = 'sent',
            delivered_medium = 'desktop'
      WHERE id = $1::uuid
        AND event_type = 'plugin_workload_sdk.notification'
        AND audience->>'userId' = $2
        AND status IN ('queued', 'retrying')
      RETURNING payload->>'notificationId' AS "invocationId"`,
    [normalizedId, userId]
  )
  if ((updated.rowCount ?? 0) > 0) {
    // Close the clientNotifications lifecycle on desktop delivery: the
    // invocation (id = payload notificationId) moves accepted → delivered.
    // Guarded + idempotent; mirrors the channel terminal path.
    const invocationId = (updated.rows[0] as { invocationId?: string } | undefined)?.invocationId
    if (invocationId) {
      await markSdkNotificationDelivered(invocationId)
    }
    return { status: 'acked' }
  }

  const existing = await db.query(
    `SELECT status
       FROM notification_deliveries
      WHERE id = $1::uuid
        AND event_type = 'plugin_workload_sdk.notification'
        AND audience->>'userId' = $2`,
    [normalizedId, userId]
  )
  const existingRows = existing.rows as Array<{ status: string | null }>
  if (!existingRows.length) {
    return { status: 'not_found' }
  }
  const status = String(existingRows[0]?.status || '')
  if (status === 'sent' || status === 'failed' || status === 'cancelled') {
    return { status: 'already_terminal' }
  }
  return { status: 'not_found' }
}
