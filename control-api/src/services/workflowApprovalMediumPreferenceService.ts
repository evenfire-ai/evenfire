import { pool } from '../db.js'
import type { VerifiedMediumAccount } from './workflowApprovalMediumIdentityService.js'

export type PreferredMediumAccount = VerifiedMediumAccount & {
  isPreferred: boolean
}

export async function listVerifiedMediumAccountsWithPreference(
  userId: string,
  options: { includeDisabled?: boolean } = {}
): Promise<PreferredMediumAccount[]> {
  const result = await pool.query(
    `SELECT id,
            user_id AS "userId",
            medium,
            provider_user_id AS "providerUserId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "providerChannelId",
            communication_channel_ref AS "communicationChannelRef",
            disabled_at AS "disabledAt",
            ROW_NUMBER() OVER (
              ORDER BY updated_at DESC, created_at DESC, id
            ) = 1 AS "isPreferred"
       FROM workflow_approval_medium_accounts
      WHERE user_id = $1
        AND ($2::boolean OR disabled_at IS NULL)
      ORDER BY medium, "isPreferred" DESC, provider_user_id`,
    [userId, options.includeDisabled === true]
  )
  return result.rows as PreferredMediumAccount[]
}

export async function preferVerifiedMediumAccount(params: {
  userId: string
  accountId: string
}): Promise<PreferredMediumAccount | null> {
  const result = await pool.query(
    `UPDATE workflow_approval_medium_accounts
        SET updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL
      RETURNING id,
                user_id AS "userId",
                medium,
                provider_user_id AS "providerUserId",
                provider_workspace_id AS "providerWorkspaceId",
                provider_channel_id AS "providerChannelId",
                communication_channel_ref AS "communicationChannelRef",
                disabled_at AS "disabledAt",
                true AS "isPreferred"`,
    [params.accountId, params.userId]
  )
  return (result.rows[0] as PreferredMediumAccount | undefined) ?? null
}
