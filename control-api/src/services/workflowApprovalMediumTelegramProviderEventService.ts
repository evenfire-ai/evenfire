import { config } from '../config.js'
import { type DbClient, pool, withTransaction } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import { upsertVerifiedTelegramAccount } from './workflowApprovalMediumTelegramAccountService.js'
import {
  dedupeProviderTargets,
  normalizeProviderTarget,
  normalizeProviderTargets,
} from './workflowApprovalMediumTelegramProviderTarget.js'
import {
  type TelegramTargetAssociationMutation,
  addTelegramTargetAssociation,
  removeTelegramTargetAssociation,
} from './workflowApprovalMediumTelegramTargetAssociationService.js'
import {
  TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
  type TelegramApprovalTarget,
  type TelegramProviderEventChallengeRow,
  findMatchingTelegramProviderEventChallenge,
  resolveTelegramProviderEventTarget,
  verifyTelegramProviderEventChallengeCodeHash,
} from './workflowApprovalMediumTelegramVerificationService.js'

export {
  attachTelegramTargetsToAccounts,
  disableVerifiedMediumAccountWithTelegramAssociations,
} from './workflowApprovalMediumTelegramTargetAssociationService.js'

type TelegramIdentity = {
  providerUserId: string
  providerChannelId: string
  providerChannelType: string
  providerChannelTitle?: string | null
  providerChannelHandle?: string | null
}

const CODE_RE = /^\d{6}$/
function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function normalizeTelegramIdentity(params: TelegramIdentity): TelegramIdentity | null {
  const providerUserId = optionalString(params.providerUserId)
  const providerChannelId = optionalString(params.providerChannelId)
  const providerChannelType = optionalString(params.providerChannelType)
  if (!providerUserId || !providerChannelId || !providerChannelType) return null
  if (providerUserId.length > 256 || providerChannelId.length > 256) return null
  if (
    providerChannelType !== 'private' &&
    providerChannelType !== 'group' &&
    providerChannelType !== 'supergroup'
  ) {
    return null
  }
  if (providerChannelType === 'private' && providerUserId !== providerChannelId) return null
  return {
    providerUserId,
    providerChannelId,
    providerChannelType,
    providerChannelTitle: optionalString(params.providerChannelTitle),
    providerChannelHandle: optionalString(params.providerChannelHandle),
  }
}

async function loadPendingChallengeForUpdate(
  db: DbClient,
  challengeId: string
): Promise<TelegramProviderEventChallengeRow | null> {
  const current = await db.query(
    `SELECT c.id,
            c.user_id AS "userId",
            u.email AS "userEmail",
            c.provider_channel_id AS "targetId",
            c.code_hash AS "codeHash",
            c.expires_at <= NOW() AS "isExpired",
            c.consumed_at AS "consumedAt",
            c.attempts
       FROM workflow_approval_medium_challenges c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = $1
        AND c.medium = 'telegram'
        AND c.provider_user_id = $2
      FOR UPDATE`,
    [challengeId, TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID]
  )
  if ((current.rowCount ?? 0) === 0) return null
  return current.rows[0] as TelegramProviderEventChallengeRow
}

async function validateChallengeCodeForUpdate(
  db: DbClient,
  row: TelegramProviderEventChallengeRow,
  code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (row.consumedAt) return { ok: false, error: 'challenge_consumed' }
  if (row.isExpired) return { ok: false, error: 'challenge_expired' }
  if (row.attempts >= config.approvalMediumChallengeMaxAttempts) {
    return { ok: false, error: 'too_many_attempts' }
  }
  if (!verifyTelegramProviderEventChallengeCodeHash({ row, code })) {
    await db.query(
      `UPDATE workflow_approval_medium_challenges
          SET attempts = attempts + 1
        WHERE id = $1`,
      [row.id]
    )
    return { ok: false, error: 'invalid_code' }
  }
  return { ok: true }
}

async function validateChallengeBeforeAssociation(params: {
  challengeId: string
  code: string
  identity: TelegramIdentity
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return withTransaction(async db => {
    const row = await loadPendingChallengeForUpdate(db, params.challengeId)
    if (!row) return { ok: false, error: 'challenge_not_found' }
    const valid = await validateChallengeCodeForUpdate(db, row, params.code)
    if (!valid.ok) return valid
    const existing = await db.query(
      `SELECT id
         FROM workflow_approval_medium_accounts
        WHERE medium = 'telegram'
          AND provider_user_id = $1
          AND provider_workspace_id IS NULL
          AND provider_channel_id = $2
          AND disabled_at IS NULL
          AND user_id <> $3
        LIMIT 1
        FOR UPDATE`,
      [params.identity.providerUserId, params.identity.providerChannelId, row.userId]
    )
    if ((existing.rowCount ?? 0) > 0) {
      return { ok: false, error: 'telegram_identity_already_verified' }
    }
    return { ok: true }
  })
}

async function consumeChallengeAfterAssociation(params: {
  challengeId: string
  code: string
  identity: TelegramIdentity
  // Figure D multi-bot: "namespace/name" of the validated CommunicationChannel
  // (already proven to match the target above) — bound to the account so
  // delivery resolves the per-channel bot and authz filters by channel.
  communicationChannelRef: string
}): Promise<{ ok: true; accountId: string; userEmail: string } | { ok: false; error: string }> {
  return withTransaction(async db => {
    const row = await loadPendingChallengeForUpdate(db, params.challengeId)
    if (!row) return { ok: false, error: 'challenge_not_found' }
    const valid = await validateChallengeCodeForUpdate(db, row, params.code)
    if (!valid.ok) return valid
    const account = await upsertVerifiedTelegramAccount(
      db,
      row.userId,
      params.identity,
      params.communicationChannelRef
    )
    if (!account.ok) return account
    await db.query(
      `UPDATE workflow_approval_medium_challenges
          SET consumed_at = NOW()
        WHERE id = $1`,
      [row.id]
    )
    return { ok: true, accountId: account.accountId, userEmail: row.userEmail }
  })
}

async function isTelegramIdentityVerifiedForUser(params: {
  userId: string
  identity: TelegramIdentity
}): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM workflow_approval_medium_accounts
      WHERE user_id = $1
        AND medium = 'telegram'
        AND provider_user_id = $2
        AND provider_workspace_id IS NULL
        AND provider_channel_id = $3
        AND disabled_at IS NULL
      LIMIT 1`,
    [params.userId, params.identity.providerUserId, params.identity.providerChannelId]
  )
  return (result.rowCount ?? 0) > 0
}

export async function confirmTelegramProviderEventChallenge(params: {
  gateway: K8sGateway
  code: string
  providerUserId: string
  providerChannelId: string
  providerChannelType: string
  providerChannelTitle?: string | null
  providerChannelHandle?: string | null
  providerTarget: unknown
  providerTargets?: unknown
}): Promise<{ ok: true; accountId: string; userEmail: string } | { ok: false; error: string }> {
  if (!CODE_RE.test(params.code)) return { ok: false, error: 'invalid_code' }
  const identity = normalizeTelegramIdentity(params)
  if (!identity) return { ok: false, error: 'invalid_provider_identity' }
  const primaryProviderTarget = normalizeProviderTarget(params.providerTarget)
  const providerTargets = dedupeProviderTargets([
    ...(primaryProviderTarget ? [primaryProviderTarget] : []),
    ...normalizeProviderTargets(params.providerTargets),
  ])
  if (providerTargets.length === 0) return { ok: false, error: 'invalid_receiver_identity' }
  const challenge = await findMatchingTelegramProviderEventChallenge(params.code)
  if ('error' in challenge) return { ok: false, error: challenge.error }
  if (!challenge.targetId) return { ok: false, error: 'telegram_target_not_found' }
  let target: TelegramApprovalTarget
  try {
    target = await resolveTelegramProviderEventTarget({
      gateway: params.gateway,
      userId: challenge.userId,
      targetId: challenge.targetId,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'telegram_target_not_found' }
  }
  const receiverMatchesTarget = providerTargets.some(
    providerTarget =>
      target.agentName === providerTarget.hostRef &&
      target.channelNamespace === providerTarget.communicationChannelNamespace &&
      target.channelName === providerTarget.communicationChannelName
  )
  if (!receiverMatchesTarget) {
    return { ok: false, error: 'telegram_target_not_found' }
  }
  const validated = await validateChallengeBeforeAssociation({
    challengeId: challenge.id,
    code: params.code,
    identity,
  })
  if (!validated.ok) return validated
  let associationMutation: TelegramTargetAssociationMutation = { changed: false }
  try {
    associationMutation = await addTelegramTargetAssociation(params.gateway, target, {
      ...identity,
      userId: challenge.userId,
    })
  } catch (err) {
    console.error(
      '[WorkflowApprovalMedium] Failed to associate Telegram target after provider confirmation:',
      err instanceof Error ? err.message : err
    )
    return { ok: false, error: 'telegram_target_not_ready' }
  }
  const consumed = await consumeChallengeAfterAssociation({
    challengeId: challenge.id,
    code: params.code,
    identity,
    communicationChannelRef: `${target.channelNamespace}/${target.channelName}`,
  })
  if (!consumed.ok) {
    const shouldKeepAssociation =
      (consumed.error === 'challenge_consumed' || consumed.error === 'challenge_not_found') &&
      (await isTelegramIdentityVerifiedForUser({ userId: challenge.userId, identity }))
    if (shouldKeepAssociation) return consumed
    try {
      await removeTelegramTargetAssociation(
        params.gateway,
        target,
        { ...identity, userId: challenge.userId },
        associationMutation
      )
    } catch (err) {
      console.error(
        '[WorkflowApprovalMedium] Failed to roll back Telegram target association after provider confirmation failed:',
        err instanceof Error ? err.message : err
      )
    }
  }
  return consumed
}

export async function isTelegramProviderEventChallengeForUser(params: {
  challengeId: string
  userId: string
}): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM workflow_approval_medium_challenges
      WHERE id = $1
        AND user_id = $2
        AND medium = 'telegram'
        AND provider_user_id = $3
      LIMIT 1`,
    [params.challengeId, params.userId, TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID]
  )
  return (result.rowCount ?? 0) > 0
}
