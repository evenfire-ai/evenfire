import { createHash, randomInt } from 'node:crypto'
import { type DbClient, pool, withTransaction } from '../db.js'
import {
  type MediumIdentityInput,
  type VerifiedMediumAccount,
  normalizeMediumIdentity,
} from './workflowApprovalMediumIdentityService.js'

const LINK_SESSION_PROVIDER_USER_ID = '__reader_link__'
const LINK_SESSION_HASH_PREFIX = 'reader-link-sha256'
const SLACK_LINK_SESSION_TTL_SECONDS = 2 * 60

export type WorkflowApprovalLinkSession = {
  id: string
  nonce: string
  expiresAt: string
  deepLinkUrl: string | null
}

function nonceHash(nonce: string): string {
  return `${LINK_SESSION_HASH_PREFIX}:${createHash('sha256').update(nonce).digest('hex')}`
}

function randomSlackVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function assertFigureDMedium(medium: string): 'telegram' | 'slack' {
  const normalized = medium.trim().toLowerCase()
  if (normalized === 'telegram' || normalized === 'slack') return normalized
  throw new Error('unsupported_medium')
}

function normalizeLinkSessionWorkspace(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  if (normalized.length > 256) throw new Error('invalid_provider_workspace_id')
  return normalized || null
}

export async function createMediumLinkSession(params: {
  userId: string
  medium: string
  providerWorkspaceId?: unknown
  communicationChannelRef?: unknown
}): Promise<WorkflowApprovalLinkSession> {
  const medium = assertFigureDMedium(params.medium)
  if (medium === 'telegram') {
    throw new Error('telegram_target_required')
  }
  const providerWorkspaceId = normalizeLinkSessionWorkspace(params.providerWorkspaceId)
  const communicationChannelRef = normalizeLinkSessionWorkspace(params.communicationChannelRef)

  const nonce = randomSlackVerificationCode()
  const result = await pool.query(
    `INSERT INTO workflow_approval_medium_challenges
       (user_id, medium, provider_user_id, provider_workspace_id, provider_channel_id, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + interval '1 second' * $7)
     RETURNING id, expires_at AS "expiresAt"`,
    [
      params.userId,
      medium,
      LINK_SESSION_PROVIDER_USER_ID,
      providerWorkspaceId,
      communicationChannelRef,
      nonceHash(nonce),
      SLACK_LINK_SESSION_TTL_SECONDS,
    ]
  )
  const row = result.rows[0] as { id: string; expiresAt: string }
  return {
    id: row.id,
    nonce,
    expiresAt: row.expiresAt,
    deepLinkUrl: null,
  }
}

export async function confirmMediumLinkSessionFromReader(params: {
  nonce: string
  identity: MediumIdentityInput
  validateSession?: (
    userId: string,
    identity: ReturnType<typeof normalizeMediumIdentity>
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}): Promise<{ ok: true; account: VerifiedMediumAccount } | { ok: false; error: string }> {
  const identity = normalizeMediumIdentity(params.identity)
  if (identity.medium !== 'telegram' && identity.medium !== 'slack') {
    return { ok: false, error: 'unsupported_medium' }
  }
  if (identity.medium === 'telegram') {
    return { ok: false, error: 'telegram_target_required' }
  }
  if (identity.medium === 'slack' && !identity.providerWorkspaceId) {
    return { ok: false, error: 'slack_workspace_id_required' }
  }
  if (!identity.providerChannelId) {
    return { ok: false, error: 'provider_channel_id_required' }
  }
  if (!identity.communicationChannelRef) {
    return { ok: false, error: 'communication_channel_ref_required' }
  }
  const nonce = params.nonce.trim()
  if (!nonce) return { ok: false, error: 'invalid_nonce' }
  if (!/^\d{6}$/.test(nonce)) return { ok: false, error: 'invalid_nonce' }

  return withTransaction(async db =>
    confirmMediumLinkSessionInTransaction(db, nonce, identity, params.validateSession)
  )
}

async function confirmMediumLinkSessionInTransaction(
  db: DbClient,
  nonce: string,
  identity: ReturnType<typeof normalizeMediumIdentity>,
  validateSession?: (
    userId: string,
    identity: ReturnType<typeof normalizeMediumIdentity>
  ) => Promise<{ ok: true } | { ok: false; error: string }>
): Promise<{ ok: true; account: VerifiedMediumAccount } | { ok: false; error: string }> {
  const session = await db.query(
    `SELECT id,
            user_id AS "userId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "communicationChannelRef",
            expires_at <= NOW() AS "isExpired",
            consumed_at AS "consumedAt"
       FROM workflow_approval_medium_challenges
      WHERE medium = $1
        AND provider_user_id = $2
        AND code_hash = $3
      FOR UPDATE`,
    [identity.medium, LINK_SESSION_PROVIDER_USER_ID, nonceHash(nonce)]
  )
  const row = session.rows[0] as
    | {
        id: string
        userId: string
        providerWorkspaceId: string | null
        communicationChannelRef: string | null
        isExpired: boolean
        consumedAt: string | null
      }
    | undefined
  if (!row) return { ok: false, error: 'link_session_not_found' }
  if (row.consumedAt) return { ok: false, error: 'link_session_consumed' }
  if (row.isExpired) return { ok: false, error: 'link_session_expired' }
  if (
    identity.medium === 'slack' &&
    row.providerWorkspaceId &&
    row.providerWorkspaceId !== identity.providerWorkspaceId
  ) {
    return { ok: false, error: 'link_session_workspace_mismatch' }
  }
  if (
    row.communicationChannelRef &&
    row.communicationChannelRef !== identity.communicationChannelRef
  ) {
    return { ok: false, error: 'link_session_channel_mismatch' }
  }
  if (validateSession) {
    const validation = await validateSession(row.userId, identity)
    if (!validation.ok) return validation
  }
  const accountResult = await upsertVerifiedMediumAccount(db, row.userId, identity)
  if (!accountResult.ok) return accountResult
  await db.query(
    `UPDATE workflow_approval_medium_challenges
        SET consumed_at = NOW()
      WHERE id = $1`,
    [row.id]
  )
  return { ok: true, account: accountResult.account }
}

async function upsertVerifiedMediumAccount(
  db: DbClient,
  userId: string,
  identity: ReturnType<typeof normalizeMediumIdentity>
): Promise<
  | { ok: true; account: VerifiedMediumAccount }
  | { ok: false; error: 'medium_identity_already_bound' }
> {
  const existing = await selectExistingVerifiedMediumAccount(db, identity)

  const row = existing.rows[0] as VerifiedMediumAccount | undefined
  if (row) {
    return refreshExistingVerifiedMediumAccount(db, userId, row, identity.communicationChannelRef)
  }

  try {
    const account = await db.query(
      `INSERT INTO workflow_approval_medium_accounts
         (user_id, medium, provider_user_id, provider_workspace_id, provider_channel_id, communication_channel_ref, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id,
                 user_id AS "userId",
                 medium,
                 provider_user_id AS "providerUserId",
                 provider_workspace_id AS "providerWorkspaceId",
                 provider_channel_id AS "providerChannelId"`,
      [
        userId,
        identity.medium,
        identity.providerUserId,
        identity.providerWorkspaceId,
        identity.providerChannelId,
        identity.communicationChannelRef,
      ]
    )
    return { ok: true, account: account.rows[0] as VerifiedMediumAccount }
  } catch (err) {
    if (!isActiveProviderIdentityConflict(err)) throw err
    const conflicted = await selectExistingVerifiedMediumAccount(db, identity)
    const conflictRow = conflicted.rows[0] as VerifiedMediumAccount | undefined
    if (!conflictRow) throw err
    return refreshExistingVerifiedMediumAccount(
      db,
      userId,
      conflictRow,
      identity.communicationChannelRef
    )
  }
}

function isActiveProviderIdentityConflict(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint?: string }
  return pgErr.code === '23505' && pgErr.constraint === 'idx_wama_active_provider_identity'
}

async function selectExistingVerifiedMediumAccount(
  db: DbClient,
  identity: ReturnType<typeof normalizeMediumIdentity>
) {
  return db.query(
    `SELECT id,
            user_id AS "userId",
            medium,
            provider_user_id AS "providerUserId",
            provider_workspace_id AS "providerWorkspaceId",
            provider_channel_id AS "providerChannelId"
       FROM workflow_approval_medium_accounts
      WHERE medium = $1
        AND provider_user_id = $2
        AND COALESCE(provider_workspace_id, '') = COALESCE($3, '')
        AND COALESCE(provider_channel_id, '') = COALESCE($4, '')
        AND disabled_at IS NULL
      FOR UPDATE`,
    [
      identity.medium,
      identity.providerUserId,
      identity.providerWorkspaceId,
      identity.providerChannelId,
    ]
  )
}

async function refreshExistingVerifiedMediumAccount(
  db: DbClient,
  userId: string,
  row: VerifiedMediumAccount,
  communicationChannelRef: string | null
): Promise<
  | { ok: true; account: VerifiedMediumAccount }
  | { ok: false; error: 'medium_identity_already_bound' }
> {
  if (row.userId !== userId) return { ok: false, error: 'medium_identity_already_bound' }
  const account = await db.query(
    `UPDATE workflow_approval_medium_accounts
        SET verified_at = NOW(),
            communication_channel_ref = $2,
            updated_at = NOW()
      WHERE id = $1
     RETURNING id,
               user_id AS "userId",
               medium,
               provider_user_id AS "providerUserId",
               provider_workspace_id AS "providerWorkspaceId",
               provider_channel_id AS "providerChannelId"`,
    [row.id, communicationChannelRef]
  )
  return { ok: true, account: account.rows[0] as VerifiedMediumAccount }
}
