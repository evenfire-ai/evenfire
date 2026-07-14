import { createHash } from 'node:crypto'
import { type DbClient, pool } from '../db.js'
import {
  type MediumIdentityInput,
  type VerifiedMediumAccount,
  findVerifiedMediumAccount,
  normalizeMediumIdentity,
} from './workflowApprovalMediumIdentityService.js'

export type TelegramProviderChatType = 'private' | 'group' | 'supergroup' | 'channel'

export type ProviderTargetBindingInput = {
  hostRef?: string | null
  communicationChannelNamespace?: string | null
  communicationChannelName?: string | null
  // Figure D: 8-byte hash of communication_channel_ref, carried inside the
  // provider action value by the reader. Present when the decision arrived via
  // the reader path (DM private); absent on the channel-reader path (Figure C),
  // which carries ns/name directly.
  communicationChannelAlias?: string | null
  providerBotId?: string | null
  providerBotUsername?: string | null
}

// Must match CHANNEL_ALIAS_LEN in workflowApprovalNotificationDeliveryWorker.ts
// (16 hex / 64-bit). Kept local (not shared) to avoid a cross-module dependency
// for a single int.
const CHANNEL_ALIAS_LEN = 16

export type OperationalMediumIdentityInput = MediumIdentityInput & {
  providerChannelType?: string | null
  providerTarget?: ProviderTargetBindingInput | null
}

export function normalizeTelegramProviderChannelType(
  value: unknown
): TelegramProviderChatType | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (
    normalized === 'private' ||
    normalized === 'group' ||
    normalized === 'supergroup' ||
    normalized === 'channel'
  ) {
    return normalized
  }
  return null
}

// Figure D: resolve a provider action channelAlias (8-byte sha256 of the ref)
// back to the full "namespace/name" ref by scanning the user's active accounts
// (typically 1–2 per user). The alias is a public hash carried in a
// provider-signed action payload, so a plain equality check suffices.
async function resolveChannelRefByAlias(
  db: DbClient,
  identity: ReturnType<typeof normalizeMediumIdentity>,
  alias: string
): Promise<string | null> {
  const result = await db.query(
    `SELECT communication_channel_ref AS "communicationChannelRef"
      FROM workflow_approval_medium_accounts
      WHERE medium = $1
        AND provider_user_id = $2
        AND COALESCE(provider_workspace_id, '') = COALESCE($3, '')
        AND ($4::text IS NULL OR provider_channel_id = $4)
        AND communication_channel_ref IS NOT NULL
        AND disabled_at IS NULL`,
    [
      identity.medium,
      identity.providerUserId,
      identity.providerWorkspaceId,
      identity.providerChannelId,
    ]
  )
  // candidate is lowercase sha256 hex; the alias arrives lowercased from the
  // reader, but normalize defensively so a mixed-case alias never causes a
  // false medium_identity_not_verified rejection (lockout of a legit user).
  const normalizedAlias = alias.trim().toLowerCase()
  for (const row of result.rows as Array<{ communicationChannelRef: string }>) {
    const candidate = createHash('sha256')
      .update(row.communicationChannelRef)
      .digest('hex')
      .slice(0, CHANNEL_ALIAS_LEN)
    if (candidate === normalizedAlias) return row.communicationChannelRef
  }
  return null
}

// Channel-binding mode for the operational provider lookup.
//  - 'strict' (default): bind to the decision's CommunicationChannel
//    (cross-bot block). A null/unresolved ref matches NO row.
//  - 'identity-only': resolve by provider identity alone, no channel-ref
//    filter. Used by the workflow-access resolve path, which has no channel
//    context (mcp-host sends no providerTarget).
// The mode is an EXPLICIT caller intent — never inferred from "channelRef is
// null". Inferring it would let a failed alias resolution on the approval path
// silently fall through to an unbound match, reopening the cross-bot hole.
export type OperationalMediumChannelBinding = 'strict' | 'identity-only'

export async function findVerifiedOperationalMediumAccount(
  identityInput: OperationalMediumIdentityInput,
  db: DbClient = pool,
  options: { channelBinding?: OperationalMediumChannelBinding } = {}
): Promise<VerifiedMediumAccount | null> {
  const identity = normalizeMediumIdentity(identityInput)
  if (identity.medium !== 'telegram' && identity.medium !== 'slack') {
    return findVerifiedMediumAccount(identity, db)
  }
  if (identity.medium === 'telegram' && identity.providerWorkspaceId) {
    return null
  }
  const enforceChannelBinding = options.channelBinding !== 'identity-only'
  const providerChannelType = normalizeTelegramProviderChannelType(
    identityInput.providerChannelType
  )
  const privateProviderChannelId =
    providerChannelType === 'private' && identity.providerChannelId
      ? identity.providerChannelId
      : null
  // identity-only mode (workflow-access /resolve): match by provider identity,
  // no channel-ref binding. Skip alias resolution entirely. This restores the
  // pre-PR#547 behaviour for the path that has no channel context; the strict
  // cross-bot binding below still governs the approval-decision path.
  if (!enforceChannelBinding) {
    const identityOnlyProviderChannelId =
      identity.medium === 'telegram' ? privateProviderChannelId : identity.providerChannelId
    const result = await db.query(
      `SELECT id,
              user_id AS "userId",
              medium,
              provider_user_id AS "providerUserId",
              provider_workspace_id AS "providerWorkspaceId",
              provider_channel_id AS "providerChannelId",
              communication_channel_ref AS "communicationChannelRef",
              disabled_at AS "disabledAt"
         FROM workflow_approval_medium_accounts
        WHERE medium = $1
          AND provider_user_id = $2
          AND COALESCE(provider_workspace_id, '') = COALESCE($3, '')
          AND ($4::text IS NULL OR provider_channel_id = $4)
          AND disabled_at IS NULL
        LIMIT 1`,
      [
        identity.medium,
        identity.providerUserId,
        identity.providerWorkspaceId,
        identityOnlyProviderChannelId,
      ]
    )
    return (result.rows[0] as VerifiedMediumAccount | undefined) ?? null
  }
  // Figure D cross-bot fix (HIGH): provider user ids are not enough when the
  // same user is verified through different CommunicationChannels. Bind the
  // lookup to the CommunicationChannel of the decision context. The filter is
  // STRICT (owner decision).
  //
  // Two provenance paths for the channel ref:
  //  - Figure C (channel-reader): providerTarget carries ns/name directly.
  //  - Figure D (reader + provider action): providerTarget carries a signed
  //    channelAlias (8-byte sha256 of the ref); resolve it before filtering.
  //
  // When no ref resolves, `communication_channel_ref = NULL` matches no row →
  // the decision is rejected. Post-migration every active approval account has
  // a non-null channel ref, so the real flows are unaffected.
  const directChannelRef =
    identityInput.providerTarget?.communicationChannelNamespace &&
    identityInput.providerTarget?.communicationChannelName
      ? `${identityInput.providerTarget.communicationChannelNamespace}/${identityInput.providerTarget.communicationChannelName}`
      : null
  const channelAlias = identityInput.providerTarget?.communicationChannelAlias?.trim() || null
  const channelRef = directChannelRef
    ? directChannelRef
    : channelAlias
      ? await resolveChannelRefByAlias(db, identity, channelAlias)
      : null
  const result = await db.query(
    `SELECT id,
            user_id AS "userId",
            medium,
            provider_user_id AS "providerUserId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "providerChannelId",
            communication_channel_ref AS "communicationChannelRef",
            disabled_at AS "disabledAt"
      FROM workflow_approval_medium_accounts
      WHERE medium = $1
        AND provider_user_id = $2
        AND COALESCE(provider_workspace_id, '') = COALESCE($3, '')
        AND ($4::text IS NULL OR provider_channel_id = $4)
        AND communication_channel_ref = $5
        AND disabled_at IS NULL
      LIMIT 1`,
    [
      identity.medium,
      identity.providerUserId,
      identity.providerWorkspaceId,
      identity.medium === 'telegram' ? privateProviderChannelId : identity.providerChannelId,
      channelRef,
    ]
  )
  return (result.rows[0] as VerifiedMediumAccount | undefined) ?? null
}
