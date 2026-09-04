import { createHash } from 'node:crypto'
import { type DbClient, pool, withTransaction } from '../../db.js'
import {
  type GfsDesktopOperatorLifecycleActor,
  GfsDesktopOperatorLinkError,
  gfsDesktopOperatorLinkService,
} from '../gfsDesktopOperatorLinkService.js'
import type { AdminDeleteUserResult } from './types.js'
import { normalizeChannels } from './types.js'

export type DesktopUserRetirementActor = GfsDesktopOperatorLifecycleActor
export type DesktopUserRetirementOutcome = 'retired' | 'deleted'

export type RetireDesktopUserResult = {
  id: string
  outcome: DesktopUserRetirementOutcome
  operationId: string
  lifecycleVersion: number | null
  replayed: boolean
}

export type DesktopUserRetirementErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'idempotency_conflict'
  | 'retirement_conflict'

export class DesktopUserRetirementError extends Error {
  constructor(
    readonly code: DesktopUserRetirementErrorCode,
    message: string = code
  ) {
    super(message)
    this.name = 'DesktopUserRetirementError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RETIREMENT_OPERATION = 'retire_desktop_user'

function requireUuid(value: unknown, field: string): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    throw new DesktopUserRetirementError('invalid_input', `${field} must be a UUID`)
  }
  return normalized
}

function normalizeRetirementActor(actor: DesktopUserRetirementActor): DesktopUserRetirementActor {
  if (!actor || typeof actor !== 'object') {
    throw new DesktopUserRetirementError('invalid_input', 'actor is required')
  }
  if (actor.kind === 'control_admin') {
    return {
      kind: 'control_admin',
      controlAdminId: requireUuid(actor.controlAdminId, 'actor.controlAdminId'),
    }
  }
  if (actor.kind === 'platform_user') {
    return {
      kind: 'platform_user',
      desktopUserId: requireUuid(actor.desktopUserId, 'actor.desktopUserId'),
    }
  }
  throw new DesktopUserRetirementError('invalid_input', 'actor kind is not supported')
}

function retirementActorId(actor: DesktopUserRetirementActor): string {
  return actor.kind === 'control_admin' ? actor.controlAdminId : actor.desktopUserId
}

function requireRetirementReason(value: unknown): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 512) {
    throw new DesktopUserRetirementError(
      'invalid_input',
      'reason is required and must be at most 512 characters'
    )
  }
  return normalized
}

function requireIdempotencyKey(value: unknown): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DesktopUserRetirementError(
      'invalid_input',
      'Idempotency-Key is required and must be a printable value of at most 256 characters'
    )
  }
  return normalized
}

function normalizeRequestId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DesktopUserRetirementError(
      'invalid_input',
      'requestId must be a printable value of at most 256 characters'
    )
  }
  return normalized
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requireLifecycleVersion(value: unknown): number {
  const normalized = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new DesktopUserRetirementError('retirement_conflict', 'user lifecycle version is invalid')
  }
  return normalized
}

type RetirementOperationRow = {
  id: string
  request_fingerprint: string
  status: string
  outcome: DesktopUserRetirementOutcome | null
  lifecycle_version: string | number | null
}

function completedReplay(
  row: RetirementOperationRow,
  targetUserId: string
): RetireDesktopUserResult {
  if (row.status !== 'completed' || (row.outcome !== 'retired' && row.outcome !== 'deleted')) {
    throw new DesktopUserRetirementError(
      'retirement_conflict',
      'retirement operation is not terminal'
    )
  }
  return {
    id: targetUserId,
    outcome: row.outcome,
    operationId: String(row.id),
    lifecycleVersion:
      row.outcome === 'retired' ? requireLifecycleVersion(row.lifecycle_version) : null,
    replayed: true,
  }
}

type AdminUserRow = {
  id: string
  email: string
  name?: string | null
  picture?: string | null
  display_name?: string | null
  control_admin_id?: string | null
  active_team_count: string | number
  teams?: unknown
  password_pending_from_accepted_invitation?: unknown
}

function mapAdminUserRow(row: AdminUserRow) {
  return {
    id: String(row.id),
    email: String(row.email),
    name: (row.name ?? null) as string | null,
    picture: (row.picture ?? null) as string | null,
    displayName: (row.display_name ?? null) as string | null,
    controlAdminId: (row.control_admin_id ?? null) as string | null,
    activeTeamCount: Number(row.active_team_count || 0),
    teams: (Array.isArray(row.teams) ? row.teams : []).map(teamValue => {
      const team =
        teamValue && typeof teamValue === 'object' ? (teamValue as Record<string, unknown>) : {}
      return {
        id: String(team.id || ''),
        name: String(team.name || ''),
        role: String(team.role || 'member'),
      }
    }),
    passwordPendingFromAcceptedInvitation: Boolean(row.password_pending_from_accepted_invitation),
  }
}

const ADMIN_USER_SELECT = `SELECT u.id,
            u.email,
            u.name,
            u.picture,
            p.display_name,
            ca.id AS control_admin_id,
            COUNT(DISTINCT CASE WHEN tm.status = 'active' THEN tm.team_id END) AS active_team_count,
            COALESCE(
              jsonb_agg(
                DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'role', tm.role)
              ) FILTER (WHERE tm.status = 'active' AND t.id IS NOT NULL),
              '[]'::jsonb
            ) AS teams,
            EXISTS (
              SELECT 1
                FROM invitations i
               WHERE i.status = 'accepted'
                 AND (
                   i.accepted_user_id = u.id
                   OR LOWER(i.email) = LOWER(u.email)
                 )
                 AND u.password_hash IS NULL
            ) AS password_pending_from_accepted_invitation
       FROM users u
  LEFT JOIN profiles p ON p.user_id = u.id
  LEFT JOIN control_admin_users ca ON lower(ca.email) = lower(u.email)
  LEFT JOIN team_members tm ON tm.user_id = u.id
  LEFT JOIN teams t ON t.id = tm.team_id`

const ADMIN_USER_GROUP_ORDER = `GROUP BY u.id, u.email, u.name, u.picture, p.display_name, ca.id
  ORDER BY u.email ASC`

export async function createAdminUser(email: string, name: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) throw new Error('email is required')

  return withTransaction(async db => {
    const userResult = await db.query(
      `INSERT INTO users(email, name)
       VALUES ($1, $2)
       RETURNING id, email, name, picture`,
      [normalizedEmail, name.trim() || null]
    )
    const user = userResult.rows[0] as {
      id: string
      email: string
      name: string | null
      picture: string | null
    }

    await db.query(
      `INSERT INTO profiles(user_id, display_name)
       VALUES($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, name.trim() || null]
    )

    return user
  })
}

export async function listUsers(searchQuery = '') {
  const query = searchQuery.trim()
  const result = await pool.query(
    `${ADMIN_USER_SELECT}
      WHERE (
        $1 = ''
        OR u.email ILIKE $2
        OR COALESCE(u.name, '') ILIKE $2
        OR COALESCE(p.display_name, '') ILIKE $2
        OR u.id::text = $1
      )
   ${ADMIN_USER_GROUP_ORDER}
      LIMIT 100`,
    [query, `%${query}%`]
  )
  return result.rows.map(row => mapAdminUserRow(row as AdminUserRow))
}

export async function getAdminUserContext(userId: string) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture, p.display_name, p.channels
       FROM users u
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [userId]
  )

  const row = result.rows[0] as
    | {
        id: string
        email: string
        name: string | null
        picture: string | null
        display_name: string | null
        channels: unknown
      }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    displayName: row.display_name || null,
    channels: normalizeChannels(row.channels),
  }
}

export async function updateAdminUserContext(
  userId: string,
  email: string,
  name: string | undefined,
  channelsInput: unknown
) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    throw new Error('email is required')
  }
  const channels = normalizeChannels(channelsInput)
  const hasName = typeof name === 'string'
  const normalizedName = hasName ? (name || '').trim() : null
  const nextName = hasName ? normalizedName || null : null

  return withTransaction(async db => {
    const userResult = await db.query(
      `UPDATE users
          SET email = $2,
              name = CASE WHEN $3 THEN $4 ELSE name END,
              updated_at = NOW()
        WHERE id = $1
    RETURNING id`,
      [userId, normalizedEmail, hasName, nextName]
    )
    if ((userResult.rowCount ?? 0) === 0) {
      return null
    }

    await db.query(
      `INSERT INTO profiles(user_id, display_name, channels)
       VALUES($1, CASE WHEN $3 THEN $4 ELSE NULL END, $2::jsonb)
       ON CONFLICT (user_id)
       DO UPDATE SET
         channels = EXCLUDED.channels,
         display_name = CASE WHEN $3 THEN EXCLUDED.display_name ELSE profiles.display_name END,
         updated_at = NOW()`,
      [userId, JSON.stringify(channels), hasName, nextName]
    )

    return getAdminUserContext(userId)
  })
}

/**
 * Retire a Desktop user under one caller-owned transaction.
 *
 * A user with operator-link history is retained as a lifecycle tombstone. The
 * legacy physical delete remains available only when no such history exists,
 * and its durable operation row makes retries safe even after the user row is
 * gone. Every non-terminal failure throws so the transaction rolls back the
 * pending operation, governed events, link state, and user mutation together.
 */
export async function retireDesktopUser(
  actorInput: DesktopUserRetirementActor,
  userIdInput: string,
  reasonInput: string,
  idempotencyKeyInput: string,
  requestIdInput: string | null | undefined,
  options: { db?: DbClient; authorize?: (db: DbClient) => Promise<void> } = {}
): Promise<RetireDesktopUserResult> {
  const actor = normalizeRetirementActor(actorInput)
  const targetUserId = requireUuid(userIdInput, 'userId')
  const reason = requireRetirementReason(reasonInput)
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyInput)
  const requestId = normalizeRequestId(requestIdInput)
  const actorId = retirementActorId(actor)
  const idempotencyKeyHash = sha256(idempotencyKey)
  const requestFingerprint = sha256(
    JSON.stringify({
      operation: RETIREMENT_OPERATION,
      actor,
      targetUserId,
      reason,
      idempotencyKeyHash,
    })
  )
  const actorColumn =
    actor.kind === 'control_admin' ? 'actor_control_admin_id' : 'actor_desktop_user_id'

  const work = async (db: DbClient): Promise<RetireDesktopUserResult> => {
    const claim = await db.query(
      `INSERT INTO desktop_user_retirement_operations(
         operation,
         actor_type,
         actor_control_admin_id,
         actor_desktop_user_id,
         target_user_id,
         idempotency_key_hash,
         request_fingerprint,
         reason,
         request_id
       )
       VALUES (
         '${RETIREMENT_OPERATION}',
         $1,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         $5,
         $6,
         $7,
         $8
       )
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id`,
      [
        actor.kind,
        actor.kind === 'control_admin' ? actor.controlAdminId : null,
        actor.kind === 'platform_user' ? actor.desktopUserId : null,
        targetUserId,
        idempotencyKeyHash,
        requestFingerprint,
        reason,
        requestId,
      ]
    )

    if ((claim.rowCount ?? 0) === 0) {
      const existing = await db.query(
        `SELECT id::text AS id,
                request_fingerprint,
                status,
                outcome,
                lifecycle_version
           FROM desktop_user_retirement_operations
          WHERE operation = '${RETIREMENT_OPERATION}'
            AND ${actorColumn} = $1::uuid
            AND target_user_id = $2::uuid
            AND idempotency_key_hash = $3
          FOR UPDATE`,
        [actorId, targetUserId, idempotencyKeyHash]
      )
      const row = existing.rows[0] as RetirementOperationRow | undefined
      if (!row) {
        throw new DesktopUserRetirementError(
          'retirement_conflict',
          'retirement operation could not be resolved after an idempotency conflict'
        )
      }
      if (row.request_fingerprint !== requestFingerprint) {
        throw new DesktopUserRetirementError(
          'idempotency_conflict',
          'Idempotency-Key was reused with a different retirement request'
        )
      }
      return completedReplay(row, targetUserId)
    }

    const operationId = String((claim.rows[0] as { id?: unknown } | undefined)?.id ?? '')
    if (!UUID_PATTERN.test(operationId)) {
      throw new DesktopUserRetirementError(
        'retirement_conflict',
        'retirement operation id is invalid'
      )
    }

    const userResult = await db.query(
      `SELECT id::text AS id, lifecycle_state, lifecycle_version
         FROM users
        WHERE id = $1::uuid
        FOR UPDATE`,
      [targetUserId]
    )
    const user = userResult.rows[0] as
      | { id?: unknown; lifecycle_state?: unknown; lifecycle_version?: unknown }
      | undefined
    if (!user || user.id !== targetUserId) {
      throw new DesktopUserRetirementError('not_found', 'Desktop user does not exist')
    }
    if (user.lifecycle_state !== 'active') {
      throw new DesktopUserRetirementError(
        'retirement_conflict',
        'Desktop user is not in the active lifecycle state'
      )
    }
    const lifecycleVersion = requireLifecycleVersion(user.lifecycle_version)
    await options.authorize?.(db)

    const history = await db.query(
      `SELECT EXISTS(
         SELECT 1
           FROM gfs_desktop_operator_links
          WHERE user_id = $1::uuid
       ) AS has_link_history`,
      [targetUserId]
    )
    const hasLinkHistory =
      (history.rows[0] as { has_link_history?: unknown } | undefined)?.has_link_history === true

    if (!hasLinkHistory) {
      await db.query(
        `UPDATE workflow_approval_medium_accounts
            SET disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()
          WHERE user_id = $1::uuid
            AND disabled_at IS NULL`,
        [targetUserId]
      )
      await db.query(
        `UPDATE workflow_approval_medium_challenges
            SET consumed_at = COALESCE(consumed_at, NOW()),
                expires_at = LEAST(expires_at, NOW())
          WHERE user_id = $1::uuid
            AND consumed_at IS NULL`,
        [targetUserId]
      )
      const deleted = await db.query(
        `DELETE FROM users
          WHERE id = $1::uuid
            AND lifecycle_state = 'active'
            AND lifecycle_version = $2
          RETURNING id::text AS id`,
        [targetUserId, lifecycleVersion]
      )
      if ((deleted.rowCount ?? 0) !== 1) {
        throw new DesktopUserRetirementError(
          'retirement_conflict',
          'Desktop user changed during retirement'
        )
      }
      const completed = await db.query(
        `UPDATE desktop_user_retirement_operations
            SET status = 'completed',
                outcome = 'deleted',
                completed_at = NOW()
          WHERE id = $1::uuid
            AND status = 'pending'`,
        [operationId]
      )
      if ((completed.rowCount ?? 0) !== 1) {
        throw new DesktopUserRetirementError(
          'retirement_conflict',
          'retirement operation changed before completion'
        )
      }
      return {
        id: targetUserId,
        outcome: 'deleted',
        operationId,
        lifecycleVersion: null,
        replayed: false,
      }
    }

    let revoked = false
    try {
      revoked = await gfsDesktopOperatorLinkService.retireParentInTransaction(db, {
        kind: 'desktop_user',
        parentId: targetUserId,
        actor,
        reason,
        requestId,
        operationId,
      })
    } catch (error) {
      if (error instanceof GfsDesktopOperatorLinkError && error.code === 'link_conflict') {
        throw new DesktopUserRetirementError(
          'retirement_conflict',
          'operator link changed during retirement'
        )
      }
      throw error
    }
    if (!revoked) {
      throw new DesktopUserRetirementError(
        'retirement_conflict',
        'operator-link history has no active generation to retire'
      )
    }

    const transitioned = await db.query(
      `UPDATE users
          SET lifecycle_state = 'retired',
              retired_at = NOW(),
              retirement_reason = $2,
              retired_by_type = $3,
              retired_by_control_admin_id = $4::uuid,
              retired_by_desktop_user_id = $5::uuid,
              retirement_request_id = $6,
              retirement_operation_id = $7::uuid,
              lifecycle_version = lifecycle_version + 1,
              updated_at = NOW()
        WHERE id = $1::uuid
          AND lifecycle_state = 'active'
          AND lifecycle_version = $8
      RETURNING lifecycle_version`,
      [
        targetUserId,
        reason,
        actor.kind,
        actor.kind === 'control_admin' ? actor.controlAdminId : null,
        actor.kind === 'platform_user' ? actor.desktopUserId : null,
        requestId,
        operationId,
        lifecycleVersion,
      ]
    )
    if ((transitioned.rowCount ?? 0) !== 1) {
      throw new DesktopUserRetirementError(
        'retirement_conflict',
        'Desktop user changed during retirement'
      )
    }
    const nextLifecycleVersion = requireLifecycleVersion(
      (transitioned.rows[0] as { lifecycle_version?: unknown } | undefined)?.lifecycle_version
    )
    const completed = await db.query(
      `UPDATE desktop_user_retirement_operations
          SET status = 'completed',
              outcome = 'retired',
              lifecycle_version = $2,
              lifecycle_operation_id = $1::uuid,
              completed_at = NOW()
        WHERE id = $1::uuid
          AND status = 'pending'`,
      [operationId, nextLifecycleVersion]
    )
    if ((completed.rowCount ?? 0) !== 1) {
      throw new DesktopUserRetirementError(
        'retirement_conflict',
        'retirement operation changed before completion'
      )
    }
    return {
      id: targetUserId,
      outcome: 'retired',
      operationId,
      lifecycleVersion: nextLifecycleVersion,
      replayed: false,
    }
  }
  return options.db ? work(options.db) : withTransaction(work)
}

/**
 * Retire a user account through the existing account-management contract.
 * Teams are retained even when this leaves them with zero active members.
 * Accounts with retained operator-link history are intentionally not purged.
 */
export async function adminDeleteUserInTransaction(
  db: DbClient,
  userId: string
): Promise<AdminDeleteUserResult> {
  const exists = await db.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [userId])
  if ((exists.rowCount ?? 0) === 0) {
    return { error: 'not_found' }
  }

  // Operator-link generations are retained for audit and are protected by
  // ON DELETE RESTRICT. Refuse the legacy hard-delete operation explicitly
  // rather than relying on a late FK error or silently erasing lifecycle history.
  const operatorLinkHistory = await db.query(
    `SELECT 1
       FROM gfs_desktop_operator_links
      WHERE user_id = $1
      LIMIT 1`,
    [userId]
  )
  if ((operatorLinkHistory.rowCount ?? 0) > 0) {
    return { error: 'gfs_operator_link_history_retained' }
  }

  await db.query(
    `UPDATE workflow_approval_medium_accounts
          SET disabled_at = COALESCE(disabled_at, NOW()),
              updated_at = NOW()
        WHERE user_id = $1
          AND disabled_at IS NULL`,
    [userId]
  )
  await db.query(
    `UPDATE workflow_approval_medium_challenges
          SET consumed_at = COALESCE(consumed_at, NOW()),
              expires_at = LEAST(expires_at, NOW())
        WHERE user_id = $1
          AND consumed_at IS NULL`,
    [userId]
  )

  const del = await db.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId])
  if ((del.rowCount ?? 0) === 0) {
    return { error: 'not_found' }
  }
  return { ok: true, id: userId }
}

export async function adminDeleteUser(userId: string): Promise<AdminDeleteUserResult> {
  return withTransaction(async db => {
    return adminDeleteUserInTransaction(db, userId)
  })
}
