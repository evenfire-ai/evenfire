import type { DbClient } from '../db.js'

export type TelegramIdentity = {
  providerUserId: string
  providerChannelId: string
}

export async function upsertVerifiedTelegramAccount(
  db: DbClient,
  userId: string,
  identity: TelegramIdentity,
  // Figure D multi-bot: the CommunicationChannel ("namespace/name") this
  // verification ran through. Required so the cross-bot authz filter and the
  // per-channel delivery bot can be resolved later.
  communicationChannelRef: string | null
): Promise<
  { ok: true; accountId: string } | { ok: false; error: 'telegram_identity_already_verified' }
> {
  if (!communicationChannelRef?.trim()) {
    throw new Error('telegram_channel_ref_required')
  }
  let account = await db.query(
    `UPDATE workflow_approval_medium_accounts
        SET verified_at = NOW(),
            communication_channel_ref = $4,
            updated_at = NOW()
      WHERE user_id = $1
        AND medium = 'telegram'
        AND provider_user_id = $2
        AND provider_workspace_id IS NULL
        AND provider_channel_id = $3
        AND disabled_at IS NULL
    RETURNING id`,
    [userId, identity.providerUserId, identity.providerChannelId, communicationChannelRef]
  )
  if ((account.rowCount ?? 0) > 0) {
    return { ok: true, accountId: String((account.rows[0] as { id: string }).id) }
  }

  const existing = await db.query(
    `SELECT id, user_id
       FROM workflow_approval_medium_accounts
      WHERE medium = 'telegram'
        AND provider_user_id = $1
        AND provider_workspace_id IS NULL
        AND provider_channel_id = $2
        AND disabled_at IS NULL
      FOR UPDATE`,
    [identity.providerUserId, identity.providerChannelId]
  )
  if ((existing.rowCount ?? 0) > 0) {
    const row = existing.rows[0] as { id: string; user_id: string }
    if (String(row.user_id) === userId) {
      return { ok: true, accountId: String(row.id) }
    }
    return { ok: false, error: 'telegram_identity_already_verified' }
  }

  account = await db.query(
    `UPDATE workflow_approval_medium_accounts
        SET verified_at = NOW(),
            disabled_at = NULL,
            communication_channel_ref = $4,
            updated_at = NOW()
      WHERE id = (
        SELECT id
          FROM workflow_approval_medium_accounts
         WHERE user_id = $1
           AND medium = 'telegram'
           AND provider_user_id = $2
           AND provider_workspace_id IS NULL
           AND provider_channel_id = $3
           AND disabled_at IS NOT NULL
         ORDER BY disabled_at DESC NULLS LAST, updated_at DESC
         LIMIT 1
         FOR UPDATE
      )
    RETURNING id`,
    [userId, identity.providerUserId, identity.providerChannelId, communicationChannelRef]
  )
  if ((account.rowCount ?? 0) > 0) {
    return { ok: true, accountId: String((account.rows[0] as { id: string }).id) }
  }

  account = await db.query(
    `INSERT INTO workflow_approval_medium_accounts
       (user_id, medium, provider_user_id, provider_workspace_id, provider_channel_id, communication_channel_ref, verified_at)
     VALUES ($1, 'telegram', $2, NULL, $3, $4, NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, identity.providerUserId, identity.providerChannelId, communicationChannelRef]
  )
  if ((account.rowCount ?? 0) > 0) {
    return { ok: true, accountId: String((account.rows[0] as { id: string }).id) }
  }

  const conflicted = await db.query(
    `SELECT id, user_id
       FROM workflow_approval_medium_accounts
      WHERE medium = 'telegram'
        AND provider_user_id = $1
        AND provider_workspace_id IS NULL
        AND provider_channel_id = $2
        AND disabled_at IS NULL
      FOR UPDATE`,
    [identity.providerUserId, identity.providerChannelId]
  )
  if ((conflicted.rowCount ?? 0) > 0) {
    const row = conflicted.rows[0] as { id: string; user_id: string }
    if (String(row.user_id) === userId) {
      return { ok: true, accountId: String(row.id) }
    }
    return { ok: false, error: 'telegram_identity_already_verified' }
  }
  throw new Error('telegram_identity_conflict_unresolved')
}
