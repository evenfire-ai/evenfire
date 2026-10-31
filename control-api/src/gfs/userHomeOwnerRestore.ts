import type { DbClient } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { auditMutation } from './audit.js'

export const USER_HOME_OWNER_PERMISSIONS = [
  'read',
  'write',
  'delete',
  'share',
  'manage_acl',
] as const

export async function lockUserHome(db: DbClient, userId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('gfs:user-home:' || $1)::bigint)", [userId])
}

export type OwnerRestoreAttribution = {
  actorKey: string
  actorOnBehalfOf: string | null
  desktopUserId?: string
  authoritySource?: 'user-session' | 'linked-admin'
  requestId?: string
  sourceIp?: string
}

type OwnerHomeBinding = { userId: string; drive: string; resourceId: string }

type RestoreResult = 'restored' | 'not_found' | 'not_restorable'

/**
 * Finish an ownership-conflict restoration in the caller's transaction.
 * The caller must hold lockUserHome for this user before any structure lock;
 * the callback writes the owner grant after the registry and resource are locked.
 * The operator restore route and grant PUT share the same validation and audit.
 */
export async function restoreUserHomeOwnerGrant(
  db: DbClient,
  userId: string,
  attribution: OwnerRestoreAttribution,
  writeGrant: (binding: OwnerHomeBinding) => Promise<void>
): Promise<RestoreResult> {
  const result = await db.query(
    `SELECT state, drive, storage_username, resource_id, conflict_code, conflict_detail
       FROM gfs_user_homes WHERE user_id = $1::uuid FOR UPDATE`,
    [userId]
  )
  const home = result.rows[0] as
    | {
        state: string
        drive: string | null
        storage_username: string | null
        resource_id: string | null
        conflict_code: string | null
        conflict_detail: unknown
      }
    | undefined
  if (!home) return 'not_found'
  if (home.state !== 'conflict' || home.conflict_code !== 'ownership_conflict')
    return 'not_restorable'
  if (!home.drive || !home.resource_id || !home.storage_username) {
    throw new Error('home_owner_binding_invalid')
  }
  const resource = await db.query(
    `SELECT resource_id FROM gfs_resources
      WHERE resource_id = $1::uuid AND drive = $2 AND kind = 'directory' AND deleted_at IS NULL
      FOR SHARE`,
    [home.resource_id, home.drive]
  )
  if (resource.rows.length !== 1) throw new Error('home_owner_binding_invalid')

  await writeGrant({ userId, drive: home.drive, resourceId: home.resource_id })
  const grant = await db.query(
    `SELECT permissions, inherit FROM gfs_grants
      WHERE drive = $1 AND resource_id = $2::uuid AND subject_type = 'user' AND subject_id = $3
      FOR UPDATE`,
    [home.drive, home.resource_id, userId]
  )
  const restored = grant.rows[0] as { permissions?: unknown; inherit?: unknown } | undefined
  const restoredPermissions = restored?.permissions
  if (
    !restored ||
    restored.inherit !== true ||
    !Array.isArray(restoredPermissions) ||
    !USER_HOME_OWNER_PERMISSIONS.every(permission => restoredPermissions.includes(permission))
  ) {
    throw new Error('home_owner_grant_invariant_failed')
  }
  const audit = {
    ...attribution,
    targetKey: `user:${userId}`,
    drive: home.drive,
    resourceId: home.resource_id,
    outcome: 'allowed' as const,
  }
  await auditMutation(db, { ...audit, op: 'user_home.conflict_cleared.ownership_conflict' })
  rootLogger.info(
    {
      event: 'user_home.conflict_cleared',
      userId,
      conflictCode: home.conflict_code,
      conflictDetail: home.conflict_detail,
      transactionState: 'pending_commit',
    },
    'user home conflict clearing'
  )
  await db.query(
    `UPDATE gfs_user_homes SET state = 'ready', conflict_code = NULL, conflict_detail = NULL,
       last_error = NULL, updated_at = now() WHERE user_id = $1::uuid`,
    [userId]
  )
  await auditMutation(db, { ...audit, op: 'user_home.restore_owner' })
  return 'restored'
}
