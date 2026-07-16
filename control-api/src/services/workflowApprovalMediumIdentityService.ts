import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { type DbClient, pool, withTransaction } from '../db.js'
import { enqueueWorkflowApprovalMediumChallengeDelivery } from './workflowApprovalMediumChallengeDeliveryService.js'

export type WorkflowApprovalMedium = 'telegram' | 'slack' | 'teams' | 'discord'

export type MediumIdentityInput = {
  medium: string
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId?: string | null
  // Figure D multi-bot: "namespace/name" of the CommunicationChannel this
  // identity was verified through (reader-link / Modo A — channel-reader
  // supplies it because it knows which channel it polled). NULL rows are legacy
  // and cannot receive channel-scoped Telegram/Slack approval delivery.
  communicationChannelRef?: string | null
}

export type VerifiedMediumAccount = {
  id: string
  userId: string
  medium: WorkflowApprovalMedium
  providerUserId: string
  providerWorkspaceId: string | null
  providerChannelId: string | null
  communicationChannelRef: string | null
  displayName: string | null
  disabledAt: string | null
}

export type MediumChallenge = {
  id: string
  expiresAt: string
}

const SUPPORTED_MEDIA = new Set<WorkflowApprovalMedium>(['telegram', 'slack', 'teams', 'discord'])
const CODE_RE = /^\d{6}$/
const PROVIDER_IDENTITY_PART_MAX = 256

function normalizeOptional(value: unknown, errorCode: string): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  if (normalized.length > PROVIDER_IDENTITY_PART_MAX) {
    throw new Error(errorCode)
  }
  return normalized ? normalized : null
}

export function normalizeMedium(value: string): WorkflowApprovalMedium | null {
  const normalized = value.trim().toLowerCase()
  return SUPPORTED_MEDIA.has(normalized as WorkflowApprovalMedium)
    ? (normalized as WorkflowApprovalMedium)
    : null
}

export function normalizeMediumIdentity(input: MediumIdentityInput): {
  medium: WorkflowApprovalMedium
  providerUserId: string
  providerWorkspaceId: string | null
  providerChannelId: string | null
  communicationChannelRef: string | null
} {
  const medium = normalizeMedium(input.medium)
  const providerUserId = input.providerUserId.trim()
  if (!medium) {
    throw new Error('unsupported_medium')
  }
  if (!providerUserId || providerUserId.length > 256) {
    throw new Error('invalid_provider_user_id')
  }
  return {
    medium,
    providerUserId,
    providerWorkspaceId: normalizeOptional(
      input.providerWorkspaceId,
      'invalid_provider_workspace_id'
    ),
    providerChannelId: normalizeOptional(input.providerChannelId, 'invalid_provider_channel_id'),
    communicationChannelRef: normalizeOptional(
      input.communicationChannelRef,
      'invalid_communication_channel_ref'
    ),
  }
}

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function createChallengeCodeHash(params: {
  userId: string
  medium: WorkflowApprovalMedium
  providerUserId: string
  code: string
  saltHex?: string
}): string {
  const saltHex = params.saltHex ?? randomBytes(16).toString('hex')
  const hash = createHash('sha256')
    .update(params.userId)
    .update('\0')
    .update(params.medium)
    .update('\0')
    .update(params.providerUserId)
    .update('\0')
    .update(params.code)
    .update('\0')
    .update(saltHex)
    .digest('hex')
  return `sha256:${saltHex}:${hash}`
}

function verifyChallengeCodeHash(params: {
  userId: string
  medium: WorkflowApprovalMedium
  providerUserId: string
  code: string
  storedHash: string
}): boolean {
  const [, saltHex, expectedHex] = params.storedHash.split(':')
  if (!saltHex || !expectedHex) return false
  const actual = createChallengeCodeHash({ ...params, saltHex }).split(':')[2]
  const actualBuf = Buffer.from(actual, 'hex')
  const expectedBuf = Buffer.from(expectedHex, 'hex')
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf)
}

export async function createMediumChallenge(params: {
  userId: string
  identity: MediumIdentityInput
}): Promise<MediumChallenge> {
  const identity = normalizeMediumIdentity(params.identity)
  if (identity.medium === 'telegram') {
    throw new Error('telegram_target_required')
  }
  if (identity.medium === 'slack') {
    throw new Error('slack_target_required')
  }
  if (identity.medium === 'teams') {
    throw new Error('teams_target_required')
  }
  const code = generateSixDigitCode()
  const codeHash = createChallengeCodeHash({
    userId: params.userId,
    medium: identity.medium,
    providerUserId: identity.providerUserId,
    code,
  })

  const result = await pool.query(
    `INSERT INTO workflow_approval_medium_challenges
       (user_id, medium, provider_user_id, provider_workspace_id, provider_channel_id, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + interval '1 second' * $7)
     RETURNING id, expires_at AS "expiresAt"`,
    [
      params.userId,
      identity.medium,
      identity.providerUserId,
      identity.providerWorkspaceId,
      identity.providerChannelId,
      codeHash,
      config.approvalMediumChallengeTtlSec,
    ]
  )

  const row = result.rows[0] as { id: string; expiresAt: string }
  await enqueueWorkflowApprovalMediumChallengeDelivery({
    challengeId: row.id,
    userId: params.userId,
    medium: identity.medium,
    providerUserId: identity.providerUserId,
    code,
    expiresAt: row.expiresAt,
  })
  return { id: row.id, expiresAt: row.expiresAt }
}

export async function confirmMediumChallenge(params: {
  challengeId: string
  userId: string
  code: string
}): Promise<{ ok: true; accountId: string } | { ok: false; error: string }> {
  if (!CODE_RE.test(params.code)) {
    return { ok: false, error: 'invalid_code' }
  }

  return withTransaction(async db => {
    const current = await db.query(
      `SELECT id,
              user_id AS "userId",
              medium,
              provider_user_id AS "providerUserId",
              provider_workspace_id AS "providerWorkspaceId",
              provider_channel_id AS "providerChannelId",
              code_hash AS "codeHash",
              expires_at <= NOW() AS "isExpired",
              consumed_at AS "consumedAt",
              attempts
         FROM workflow_approval_medium_challenges
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [params.challengeId, params.userId]
    )

    if ((current.rowCount ?? 0) === 0) {
      return { ok: false, error: 'challenge_not_found' }
    }

    const row = current.rows[0] as {
      id: string
      userId: string
      medium: WorkflowApprovalMedium
      providerUserId: string
      providerWorkspaceId: string | null
      providerChannelId: string | null
      codeHash: string
      isExpired: boolean
      consumedAt: string | null
      attempts: number
    }

    if (row.consumedAt) return { ok: false, error: 'challenge_consumed' }
    if (row.isExpired) return { ok: false, error: 'challenge_expired' }
    if (row.medium === 'telegram') return { ok: false, error: 'telegram_target_required' }
    if (row.medium === 'slack') return { ok: false, error: 'slack_target_required' }
    if (row.medium === 'teams') return { ok: false, error: 'teams_target_required' }
    if (row.attempts >= config.approvalMediumChallengeMaxAttempts) {
      return { ok: false, error: 'too_many_attempts' }
    }

    const valid = verifyChallengeCodeHash({
      userId: row.userId,
      medium: row.medium,
      providerUserId: row.providerUserId,
      code: params.code,
      storedHash: row.codeHash,
    })

    if (!valid) {
      await db.query(
        `UPDATE workflow_approval_medium_challenges
            SET attempts = attempts + 1
          WHERE id = $1`,
        [row.id]
      )
      return { ok: false, error: 'invalid_code' }
    }

    let account = await db.query(
      `UPDATE workflow_approval_medium_accounts
          SET user_id = $1,
              verified_at = NOW(),
              updated_at = NOW()
        WHERE medium = $2
          AND provider_user_id = $3
          AND COALESCE(provider_workspace_id, '') = COALESCE($4, '')
          AND COALESCE(provider_channel_id, '') = COALESCE($5, '')
          AND disabled_at IS NULL
      RETURNING id`,
      [row.userId, row.medium, row.providerUserId, row.providerWorkspaceId, row.providerChannelId]
    )
    if ((account.rowCount ?? 0) === 0) {
      if (row.providerChannelId) {
        await db.query(
          `UPDATE workflow_approval_medium_accounts
              SET disabled_at = COALESCE(disabled_at, NOW()),
                  updated_at = NOW()
            WHERE medium = $1
              AND provider_user_id = $2
              AND COALESCE(provider_workspace_id, '') = COALESCE($3, '')
              AND provider_channel_id IS NULL
              AND disabled_at IS NULL`,
          [row.medium, row.providerUserId, row.providerWorkspaceId]
        )
      }
      account = await db.query(
        `INSERT INTO workflow_approval_medium_accounts
           (user_id, medium, provider_user_id, provider_workspace_id, provider_channel_id, verified_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [row.userId, row.medium, row.providerUserId, row.providerWorkspaceId, row.providerChannelId]
      )
    }

    await db.query(
      `UPDATE workflow_approval_medium_challenges
          SET consumed_at = NOW()
        WHERE id = $1`,
      [row.id]
    )

    const accountRow = account.rows[0] as { id: string }
    return { ok: true, accountId: accountRow.id }
  })
}

export async function listVerifiedMediumAccounts(
  userId: string,
  options: { includeDisabled?: boolean } = {}
): Promise<VerifiedMediumAccount[]> {
  const result = await pool.query(
    `SELECT id,
            user_id AS "userId",
            medium,
            provider_user_id AS "providerUserId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "providerChannelId",
            display_name AS "displayName",
            disabled_at AS "disabledAt"
       FROM workflow_approval_medium_accounts
      WHERE user_id = $1${options.includeDisabled ? '' : ' AND disabled_at IS NULL'}
      ORDER BY disabled_at IS NOT NULL, medium, provider_user_id`,
    [userId]
  )
  return result.rows as VerifiedMediumAccount[]
}

// Ownership + active guard in one query: the account must exist, belong to the
// user, and not be disabled. Used to validate a preferred_account_id before it
// is persisted on user_notification_preferences.
export async function getVerifiedMediumAccountById(
  userId: string,
  accountId: string,
  db: DbClient = pool
): Promise<VerifiedMediumAccount | null> {
  const result = await db.query(
    `SELECT id,
            user_id AS "userId",
            medium,
            provider_user_id AS "providerUserId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "providerChannelId",
            display_name AS "displayName",
            disabled_at AS "disabledAt"
       FROM workflow_approval_medium_accounts
      WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL
      LIMIT 1`,
    [accountId, userId]
  )
  return (result.rows[0] as VerifiedMediumAccount | undefined) ?? null
}

export async function disableVerifiedMediumAccount(params: {
  userId: string
  accountId: string
}): Promise<boolean> {
  return withTransaction(async db => {
    const result = await db.query(
      `UPDATE workflow_approval_medium_accounts
          SET disabled_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL`,
      [params.accountId, params.userId]
    )
    const disabled = (result.rowCount ?? 0) > 0
    if (disabled) {
      // Lifecycle cleanup: if this account was the user's preferred delivery
      // instance, clear it so routing degrades to the automatic default instead
      // of silently blocking delivery under the strict (no-fallback) policy.
      await db.query(
        `UPDATE user_notification_preferences
            SET preferred_account_id = NULL, updated_at = NOW()
          WHERE user_id = $1 AND preferred_account_id = $2`,
        [params.userId, params.accountId]
      )
    }
    return disabled
  })
}

export async function findVerifiedMediumAccount(
  identity: MediumIdentityInput,
  db: DbClient = pool
): Promise<VerifiedMediumAccount | null> {
  const normalized = normalizeMediumIdentity(identity)
  if (!normalized.providerChannelId) {
    throw new Error('provider_channel_id_required')
  }
  const result = await db.query(
    `SELECT id,
            user_id AS "userId",
            medium,
            provider_user_id AS "providerUserId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "providerChannelId",
            display_name AS "displayName",
            disabled_at AS "disabledAt"
       FROM workflow_approval_medium_accounts
      WHERE medium = $1
        AND provider_user_id = $2
        AND COALESCE(provider_workspace_id, '') = COALESCE($3, '')
        AND provider_channel_id = $4
        AND disabled_at IS NULL
      LIMIT 1`,
    [
      normalized.medium,
      normalized.providerUserId,
      normalized.providerWorkspaceId,
      normalized.providerChannelId,
    ]
  )
  return (result.rows[0] as VerifiedMediumAccount | undefined) ?? null
}
