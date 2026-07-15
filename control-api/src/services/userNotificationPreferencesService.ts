import { type DbClient, pool } from '../db.js'
import { getVerifiedMediumAccountById } from './workflowApprovalMediumIdentityService.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type WorkflowApprovalNotificationMedium = 'telegram' | 'slack' | 'teams'

export type UserNotificationPreferences = {
  preferredMedium: WorkflowApprovalNotificationMedium | null
  preferredAccountId: string | null
  channelFallbackEnabled: boolean
  verifiedMedia: WorkflowApprovalNotificationMedium[]
}

function normalizePreferredMedium(value: unknown): WorkflowApprovalNotificationMedium | null {
  const medium = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (medium === 'telegram' || medium === 'slack' || medium === 'teams') return medium
  return null
}

export async function getUserNotificationPreferences(
  userId: string,
  db: DbClient = pool
): Promise<UserNotificationPreferences> {
  const [prefsResult, mediaResult] = await Promise.all([
    db.query(
      `SELECT preferred_medium AS "preferredMedium",
              preferred_account_id AS "preferredAccountId",
              channel_fallback_enabled AS "channelFallbackEnabled"
         FROM user_notification_preferences
        WHERE user_id = $1`,
      [userId]
    ),
    db.query(
      `SELECT DISTINCT medium
         FROM workflow_approval_medium_accounts
        WHERE user_id = $1
          AND disabled_at IS NULL
        ORDER BY medium`,
      [userId]
    ),
  ])

  const prefsRow = prefsResult.rows[0] as
    | {
        preferredMedium: string | null
        preferredAccountId: string | null
        channelFallbackEnabled: boolean
      }
    | undefined
  const verifiedMedia = (mediaResult.rows as Array<{ medium: string | null }>)
    .map(row => normalizePreferredMedium(row.medium))
    .filter((medium): medium is WorkflowApprovalNotificationMedium => medium !== null)

  return {
    preferredMedium: normalizePreferredMedium(prefsRow?.preferredMedium),
    preferredAccountId: prefsRow?.preferredAccountId ?? null,
    channelFallbackEnabled: prefsRow?.channelFallbackEnabled ?? true,
    verifiedMedia,
  }
}

export async function upsertUserNotificationPreferences(
  userId: string,
  input: {
    preferredMedium?: unknown
    preferredAccountId?: unknown
    channelFallbackEnabled?: unknown
  },
  db: DbClient = pool
): Promise<UserNotificationPreferences> {
  // Strict PUT semantics: preferredMedium must be explicitly provided (a valid medium or null).
  if (input.preferredMedium === undefined) {
    throw new Error('invalid_preferred_medium')
  }
  const preferredMedium =
    input.preferredMedium === null ? null : normalizePreferredMedium(input.preferredMedium)
  if (input.preferredMedium !== null && !preferredMedium) {
    throw new Error('invalid_preferred_medium')
  }

  if (typeof input.channelFallbackEnabled !== 'boolean') {
    throw new Error('invalid_channel_fallback_enabled')
  }
  const channelFallbackEnabled = input.channelFallbackEnabled

  // preferredAccountId is OPTIONAL (backward-compatible): undefined preserves the
  // stored value; null clears it; a UUID is validated for ownership + active state.
  const accountProvided = input.preferredAccountId !== undefined
  let preferredAccountId: string | null = null
  if (accountProvided && input.preferredAccountId !== null) {
    if (typeof input.preferredAccountId !== 'string' || !UUID_RE.test(input.preferredAccountId)) {
      throw new Error('preferred_account_not_found')
    }
    const account = await getVerifiedMediumAccountById(userId, input.preferredAccountId, db)
    if (!account) {
      throw new Error('preferred_account_not_found')
    }
    preferredAccountId = account.id
  }

  if (preferredMedium) {
    const verified = await db.query(
      `SELECT 1
         FROM workflow_approval_medium_accounts
        WHERE user_id = $1
          AND medium = $2
          AND disabled_at IS NULL
        LIMIT 1`,
      [userId, preferredMedium]
    )
    if (!verified.rows.length) {
      throw new Error('preferred_medium_not_verified')
    }
  }

  await db.query(
    `INSERT INTO user_notification_preferences
       (user_id, preferred_medium, preferred_account_id, channel_fallback_enabled, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET preferred_medium = EXCLUDED.preferred_medium,
           preferred_account_id = CASE
             WHEN $5::boolean THEN EXCLUDED.preferred_account_id
             ELSE user_notification_preferences.preferred_account_id
           END,
           channel_fallback_enabled = EXCLUDED.channel_fallback_enabled,
           updated_at = NOW()`,
    [userId, preferredMedium, preferredAccountId, channelFallbackEnabled, accountProvided]
  )

  return getUserNotificationPreferences(userId, db)
}
