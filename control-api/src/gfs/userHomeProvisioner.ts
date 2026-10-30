import type { Pool } from 'pg'
import { config } from '../config.js'
import { type DbClient, type DbTransactionClient, pool, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  acquireStructureLock,
  auditMutation,
  recordOwnerGrantConflict,
} from '../routes/gfs/grants.js'
import { makeHostSubjectId } from './hostSubject.js'
import { userHomeNameCandidates } from './userHomeNaming.js'
import { reserveUserHomeName } from './userHomeReservation.js'
import {
  type UserHomeConflictCode,
  type UserHomeConflictDetail,
  type UserHomeState,
  parseUserHomeConflictDetail,
  transitionUserHomeState,
} from './userHomeState.js'

const log = rootLogger.child({ service: 'gfs_user_home_provisioner' })
const OWNER_PERMISSIONS = ['read', 'write', 'delete', 'share', 'manage_acl']
// Allow twice the maximum core-pool statement timeout for the whole transaction.
const PROVISION_TRANSACTION_TIMEOUT_MS = 60_000

type HomeRow = {
  drive: string | null
  storage_username: string | null
  resource_id: string | null
  state: 'pending' | 'ready' | 'conflict' | 'retired'
  conflict_code: UserHomeConflictCode | null
  conflict_detail: unknown | null
}

type TransactionRunner = typeof withTransaction
type ProvisionOptions = {
  drive?: string | null
  dbPool?: Pool
  transaction?: TransactionRunner
  transactionTimeoutMs?: number
}

export type ProvisionUserHomeResult = 'ready' | 'conflict' | 'retired' | 'pending' | 'unchanged'

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function errorClass(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) return error.name
  return typeof error
}

async function lockUser(db: DbTransactionClient, userId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('gfs:user-home:' || $1)::bigint)", [userId])
}

async function lockHome(db: DbClient, userId: string): Promise<HomeRow | undefined> {
  const result = await db.query(
    'SELECT drive, storage_username, resource_id, state, conflict_code, conflict_detail FROM gfs_user_homes WHERE user_id = $1::uuid FOR UPDATE',
    [userId]
  )
  return result.rows[0] as HomeRow | undefined
}

function homeState(home: HomeRow): UserHomeState {
  return {
    state: home.state,
    drive: home.drive,
    conflictCode: home.conflict_code,
    conflictDetail: home.conflict_detail,
  }
}

/** The caller already holds the users row lock, when that row exists. */
export async function retireUserHomeForInactiveUser(
  db: DbClient,
  userId: string,
  configuredDrive: string | null,
  actorKey = 'platform:user-home',
  actorOnBehalfOf?: string
): Promise<void> {
  // A hard delete by an older image cascades user_agents; startup repair cannot
  // identify those agents' grants outside the home (the D31 rollback gap).
  const agents = await db.query('SELECT agent_name FROM user_agents WHERE user_id = $1::uuid', [
    userId,
  ])
  const agentNames = (agents.rows as { agent_name: string }[]).map(row => row.agent_name)

  const binding = await db.query(
    'SELECT drive, resource_id FROM gfs_user_homes WHERE user_id = $1::uuid',
    [userId]
  )
  const unlocked = binding.rows[0] as
    | { drive: string | null; resource_id: string | null }
    | undefined
  if (unlocked?.resource_id) {
    if (!unlocked.drive) throw new Error('Bound user home has no drive')
    await acquireStructureLock(db, unlocked.drive)
  }
  const home = await lockHome(db, userId)
  if (home?.state === 'retired') return
  const detail =
    home?.conflict_detail == null ? null : parseUserHomeConflictDetail(home.conflict_detail)
  if (home?.state === 'conflict' && !detail) throw new Error('User-home conflict lacks detail')
  const drive = home?.drive ?? configuredDrive
  const conflictResource =
    home?.conflict_code === 'path_conflict' ? detail?.resourceIds[0] : undefined
  if (home?.conflict_code === 'path_conflict' && !home.resource_id && !conflictResource) {
    throw new Error('Path conflict lacks its resource identity')
  }
  const resourceId = home?.resource_id ?? conflictResource ?? null
  if (home?.conflict_code) {
    await auditMutation(db, {
      actorKey,
      actorOnBehalfOf,
      targetKey: `user:${userId}`,
      op: `user_home.conflict_cleared.${home.conflict_code}`,
      drive,
      resourceId,
      outcome: 'allowed',
    })
  }
  await auditMutation(db, {
    actorKey,
    actorOnBehalfOf,
    targetKey: `user:${userId}`,
    op: 'user_home.retired',
    drive,
    resourceId,
    outcome: 'allowed',
  })
  if (home) {
    const next = transitionUserHomeState(homeState(home), { type: 'retire' })
    await db.query(
      `UPDATE gfs_user_homes
          SET state = $2, conflict_code = NULL, conflict_detail = NULL,
              attempts = attempts + 1, last_attempt_at = now(), last_error = NULL, updated_at = now()
        WHERE user_id = $1::uuid`,
      [userId, next.state]
    )
  }

  const capturedAgentIds = agentNames
    .map(name => makeHostSubjectId('1st', config.hostsNamespace, name))
    .filter((id): id is string => id !== null)

  const tree = `WITH RECURSIVE home_tree AS (
    SELECT resource_id FROM gfs_resources WHERE resource_id = $2::uuid
    UNION ALL
    SELECT r.resource_id FROM gfs_resources r JOIN home_tree t ON r.parent_resource_id = t.resource_id
  )`
  const grants = await db.query(
    `${tree}
     SELECT g.id::text, g.subject_id,
            (g.subject_type IN ('user','team','host','context') AND g.resource_id IN (SELECT resource_id FROM home_tree)) AS home_match,
            (g.subject_type = 'user' AND g.subject_id = $1) AS user_match,
            (g.subject_type = 'host' AND g.subject_id = ANY($3::text[])) AS agent_candidate
       FROM gfs_grants g
      WHERE (g.subject_type IN ('user','team','host','context') AND g.resource_id IN (SELECT resource_id FROM home_tree))
         OR (g.subject_type = 'user' AND g.subject_id = $1)
         OR (g.subject_type = 'host' AND g.subject_id = ANY($3::text[]))
      ORDER BY g.id FOR UPDATE`,
    [userId, home?.resource_id ?? null, capturedAgentIds]
  )
  const shares = await db.query(
    `${tree}
     SELECT s.id::text,
            (s.subject_type IN ('user','team','host','context') AND s.resource_id IN (SELECT resource_id FROM home_tree)) AS home_match,
            (s.subject_type = 'user' AND s.subject_id = $1) AS user_match
       FROM gfs_shares s
      WHERE (s.subject_type IN ('user','team','host','context') AND s.resource_id IN (SELECT resource_id FROM home_tree))
         OR (s.subject_type = 'user' AND s.subject_id = $1)
      ORDER BY s.id FOR UPDATE`,
    [userId, home?.resource_id ?? null]
  )
  // Lock every captured agent's grants in the global id order before deciding
  // whether the agent is still shared. Concurrent retirements on different
  // drives then recheck after the preceding retirement has committed.
  const unsharedAgents = await db.query(
    `SELECT candidate.agent_name FROM unnest($1::text[]) AS candidate(agent_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM user_agents other JOIN users u ON u.id = other.user_id
         WHERE other.agent_name = candidate.agent_name AND other.user_id <> $2::uuid
           AND u.lifecycle_state = 'active'
      )
        AND NOT EXISTS (SELECT 1 FROM team_agents ta WHERE ta.agent_name = candidate.agent_name)`,
    [agentNames, userId]
  )
  const unsharedIds = new Set(
    (unsharedAgents.rows as { agent_name: string }[])
      .map(row => makeHostSubjectId('1st', config.hostsNamespace, row.agent_name))
      .filter((id): id is string => id !== null)
  )
  type Match = { id: string; home_match: boolean; user_match: boolean }
  type GrantMatch = Match & { subject_id: string; agent_candidate: boolean }
  const grantRows = (grants.rows as GrantMatch[])
    .map(row => ({ ...row, agent_match: row.agent_candidate && unsharedIds.has(row.subject_id) }))
    .filter(row => row.home_match || row.user_match || row.agent_match)
  const shareRows = shares.rows as Match[]
  await db.query('DELETE FROM gfs_grants WHERE id = ANY($1::uuid[])', [
    grantRows.map(row => row.id),
  ])
  await db.query('DELETE FROM gfs_shares WHERE id = ANY($1::uuid[])', [
    shareRows.map(row => row.id),
  ])

  log.info(
    {
      event: 'user_home.retired',
      transactionState: 'pending_commit',
      userId,
      drive,
      conflictCode: home?.conflict_code ?? null,
      conflictDetail: detail,
      homeGrants: grantRows.filter(row => row.home_match).length,
      userGrants: grantRows.filter(row => row.user_match).length,
      agentGrants: grantRows.filter(row => row.agent_match).length,
      homeShares: shareRows.filter(row => row.home_match).length,
      userShares: shareRows.filter(row => row.user_match).length,
    },
    'User-home retirement recorded'
  )
}

async function markPendingAttempt(
  db: DbTransactionClient,
  userId: string,
  error: string
): Promise<void> {
  await db.query(
    `UPDATE gfs_user_homes
        SET attempts = attempts + 1, last_attempt_at = now(), last_error = $2, updated_at = now()
      WHERE user_id = $1::uuid AND state = 'pending'`,
    [userId, error]
  )
}

/** Recheck under the home lock; never restore an owner grant automatically. */
export async function repairUserHomeOwnerGrant(
  userId: string,
  drive: string,
  dbPool: Pool
): Promise<void> {
  await withTransaction(async db => {
    await db.query("SET LOCAL statement_timeout = '10s'")
    await lockUser(db, userId)
    const users = await db.query(
      'SELECT lifecycle_state FROM users WHERE id = $1::uuid FOR SHARE',
      [userId]
    )
    const user = users.rows[0] as { lifecycle_state: string } | undefined
    if (!user || user.lifecycle_state !== 'active') {
      await retireUserHomeForInactiveUser(db, userId, drive)
      return
    }
    const home = await lockHome(db, userId)
    if (!home || home.state !== 'ready' || !home.resource_id || !home.drive) return
    const result = await db.query(
      `SELECT permissions, inherit FROM gfs_grants
        WHERE drive = $1 AND resource_id = $2::uuid AND subject_type = 'user' AND subject_id = $3`,
      [home.drive, home.resource_id, userId]
    )
    const grant = result.rows[0] as { permissions: string[]; inherit: boolean } | undefined
    if (
      !grant ||
      !grant.inherit ||
      !OWNER_PERMISSIONS.every(permission => grant.permissions.includes(permission))
    ) {
      await recordOwnerGrantConflict(
        db,
        { user_id: userId, state: home.state },
        home.drive,
        home.resource_id,
        { isOperator: true, subjects: new Set(), actorKey: 'platform:user-home' }
      )
    }
  }, dbPool)
}

/** A rolled-back attempt must still move to the back of the pending queue. */
export async function recordFailedUserHomeAttempt(
  userId: string,
  drive: string,
  error: unknown,
  dbPool: Pool = pool
): Promise<void> {
  const code = errorCode(error)
  const reason =
    code === '57014'
      ? 'statement_timeout'
      : code === '55P03'
        ? 'lock_timeout'
        : 'provisioning_failed'
  await withTransaction(async db => {
    await db.query("SET LOCAL statement_timeout = '10s'")
    await db.query(
      `UPDATE gfs_user_homes
          SET attempts = attempts + 1, last_attempt_at = now(), last_error = $3, updated_at = now()
        WHERE user_id = $1::uuid AND state = 'pending' AND (drive IS NULL OR drive = $2)`,
      [userId, drive, reason]
    )
  }, dbPool)
}

async function recordUncertainUserHomeAttempt(
  userId: string,
  drive: string,
  dbPool: Pool
): Promise<void> {
  await withTransaction(
    async db => {
      await db.query("SET LOCAL statement_timeout = '10s'")
      // Fence the original transaction before inspecting or updating its row.
      await lockUser(db, userId)
      await db.query(
        `UPDATE gfs_user_homes
            SET attempts = attempts + 1, last_attempt_at = now(),
                last_error = 'commit_outcome_pending', updated_at = now()
          WHERE user_id = $1::uuid AND state = 'pending' AND (drive IS NULL OR drive = $2)`,
        [userId, drive]
      )
    },
    dbPool,
    { signal: AbortSignal.timeout(10_000) }
  )
}

async function setConflict(
  db: DbTransactionClient,
  userId: string,
  drive: string,
  home: HomeRow,
  code: UserHomeConflictCode,
  conflictDetail: UserHomeConflictDetail
): Promise<ProvisionUserHomeResult> {
  const detail = parseUserHomeConflictDetail(conflictDetail)
  const next = transitionUserHomeState(homeState(home), { type: 'conflict', drive, code, detail })
  await db.query(
    `UPDATE gfs_user_homes
        SET drive = $2, state = $5, conflict_code = $3, conflict_detail = $4::jsonb,
            attempts = attempts + 1, last_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE user_id = $1::uuid`,
    [userId, drive, code, JSON.stringify(detail), next.state]
  )
  await auditMutation(db, {
    actorKey: 'platform:user-home',
    targetKey: `user:${userId}`,
    op: `user_home.conflict.${code}`,
    drive,
    resourceId:
      home.resource_id ?? (code === 'path_conflict' ? detail.resourceIds[0] : undefined) ?? null,
    outcome: 'allowed',
  })
  log.info(
    { event: 'user_home.conflict', userId, drive, conflictCode: code, conflictDetail: detail },
    'User-home conflict recorded'
  )
  return 'conflict'
}

async function pathConflict(
  db: DbTransactionClient,
  userId: string,
  drive: string,
  home: HomeRow,
  resourceIds: string[]
): Promise<ProvisionUserHomeResult> {
  // Access belongs to the path occupant, or to the bound home if no occupant exists.
  const access = await db.query(
    `SELECT 'grant' AS relation, id::text FROM gfs_grants WHERE drive = $1 AND resource_id = $2::uuid
     UNION ALL
     SELECT 'share' AS relation, id::text FROM gfs_shares WHERE drive = $1 AND resource_id = $2::uuid`,
    [drive, resourceIds[0]]
  )
  const rows = access.rows as Array<{ relation: 'grant' | 'share'; id: string }>
  const grantIds = rows
    .filter(row => row.relation === 'grant')
    .map(row => row.id)
    .sort()
  const shareIds = rows
    .filter(row => row.relation === 'share')
    .map(row => row.id)
    .sort()
  return setConflict(db, userId, drive, home, 'path_conflict', {
    resourceIds,
    ...(grantIds.length ? { grantIds } : {}),
    ...(shareIds.length ? { shareIds } : {}),
  })
}

async function installHome(
  db: DbTransactionClient,
  userId: string,
  drive: string
): Promise<ProvisionUserHomeResult> {
  await db.query("SET LOCAL statement_timeout = '10s'")
  // If a network partition hides COMMIT and the disconnect, statement_timeout
  // cannot end the idle transaction. Release its locks before the 10s re-read.
  await db.query("SET LOCAL idle_in_transaction_session_timeout = '8s'")
  await lockUser(db, userId)
  const users = await db.query(
    'SELECT id::text, name, email, lifecycle_state FROM users WHERE id = $1::uuid FOR SHARE',
    [userId]
  )
  const user = users.rows[0] as
    | { id: string; name: string | null; email: string; lifecycle_state: string }
    | undefined
  if (!user || user.lifecycle_state !== 'active') {
    await retireUserHomeForInactiveUser(db, userId, drive)
    return 'retired'
  }

  const rootBeforeLock = await db.query(
    'SELECT resource_id FROM gfs_resources WHERE drive = $1 AND parent_resource_id IS NULL AND deleted_at IS NULL',
    [drive]
  )
  if (rootBeforeLock.rows.length === 0) {
    const home = await lockHome(db, userId)
    if (!home || home.state !== 'pending' || (home.drive !== null && home.drive !== drive))
      return 'unchanged'
    await markPendingAttempt(db, userId, 'drive_not_ready')
    return 'pending'
  }

  await acquireStructureLock(db, drive)
  const home = await lockHome(db, userId)
  if (!home || home.state !== 'pending' || (home.drive !== null && home.drive !== drive))
    return 'unchanged'

  const roots = await db.query(
    `SELECT resource_id, kind, path_cache FROM gfs_resources
      WHERE drive = $1 AND parent_resource_id IS NULL AND deleted_at IS NULL`,
    [drive]
  )
  const root = roots.rows[0] as
    | { resource_id: string; kind: string; path_cache: string | null }
    | undefined
  if (!root) {
    await markPendingAttempt(db, userId, 'drive_not_ready')
    return 'pending'
  }
  if (root.kind !== 'directory' || root.path_cache !== '/')
    throw new Error('GFS drive root is not canonical')

  const existingUsers = await db.query(
    `SELECT resource_id, kind, path_cache FROM gfs_resources
      WHERE drive = $1 AND parent_resource_id = $2::uuid AND name = 'Users' AND deleted_at IS NULL`,
    [drive, root.resource_id]
  )
  let usersDirectory = existingUsers.rows[0] as
    | { resource_id: string; kind: string; path_cache: string | null }
    | undefined
  if (!usersDirectory) {
    const inserted = await db.query(
      `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $2::uuid, 'Users', 'directory', '/Users') RETURNING resource_id, kind, path_cache`,
      [drive, root.resource_id]
    )
    usersDirectory = inserted.rows[0] as typeof usersDirectory
  }
  if (
    !usersDirectory ||
    usersDirectory.kind !== 'directory' ||
    usersDirectory.path_cache !== '/Users'
  ) {
    throw new Error('GFS Users directory is not canonical')
  }

  const ancestors = await db.query(
    `SELECT 'grant' AS relation, id::text, resource_id::text FROM gfs_grants
      WHERE drive = $1 AND resource_id = ANY($2::uuid[]) AND inherit = true
        AND subject_type IN ('user', 'team', 'host', 'context')
     UNION ALL
     SELECT 'share' AS relation, id::text, resource_id::text FROM gfs_shares
      WHERE drive = $1 AND resource_id = ANY($2::uuid[]) AND include_descendants = true
        AND subject_type IN ('user', 'team', 'host', 'context')`,
    [drive, [root.resource_id, usersDirectory.resource_id]]
  )
  if (ancestors.rows.length) {
    const rows = ancestors.rows as Array<{
      relation: 'grant' | 'share'
      id: string
      resource_id: string
    }>
    const grantIds = rows
      .filter(row => row.relation === 'grant')
      .map(row => row.id)
      .sort()
    const shareIds = rows
      .filter(row => row.relation === 'share')
      .map(row => row.id)
      .sort()
    return setConflict(db, userId, drive, home, 'ancestor_grant_conflict', {
      resourceIds: [...new Set(rows.map(row => row.resource_id))].sort(),
      ...(grantIds.length ? { grantIds } : {}),
      ...(shareIds.length ? { shareIds } : {}),
    })
  }

  const name = await reserveUserHomeName(
    db,
    userId,
    drive,
    home.storage_username ? [home.storage_username] : userHomeNameCandidates(user)
  )
  const existing = await db.query(
    `SELECT resource_id, kind FROM gfs_resources
      WHERE drive = $1 AND parent_resource_id = $2::uuid AND name = $3 AND deleted_at IS NULL`,
    [drive, usersDirectory.resource_id, name]
  )
  let resource = existing.rows[0] as { resource_id: string; kind: string } | undefined
  if (resource && !home.resource_id) {
    return pathConflict(db, userId, drive, home, [resource.resource_id])
  }
  if (
    home.resource_id &&
    (!resource || resource.resource_id !== home.resource_id || resource.kind !== 'directory')
  ) {
    const bound = await db.query(
      `SELECT resource_id, drive, parent_resource_id, name, kind, deleted_at FROM gfs_resources
        WHERE resource_id = $1::uuid FOR UPDATE`,
      [home.resource_id]
    )
    const existingBinding = bound.rows[0] as
      | {
          resource_id: string
          drive: string
          parent_resource_id: string | null
          name: string
          kind: string
          deleted_at: Date | null
        }
      | undefined
    // A missing referenced row violates the registry's foreign key; it is not
    // evidence that another home may safely be created.
    if (!existingBinding) throw new Error('Bound user-home resource is missing')
    if (
      existingBinding.drive !== drive ||
      existingBinding.parent_resource_id !== usersDirectory.resource_id ||
      existingBinding.name !== name ||
      existingBinding.kind !== 'directory' ||
      existingBinding.deleted_at !== null ||
      (resource !== undefined && resource.resource_id !== home.resource_id)
    ) {
      const resourceIds: string[] = []
      if (resource && resource.resource_id !== existingBinding.resource_id) {
        resourceIds.push(resource.resource_id)
      }
      resourceIds.push(existingBinding.resource_id)
      return pathConflict(db, userId, drive, home, resourceIds)
    }
    resource = existingBinding
  }
  if (!resource) {
    const inserted = await db.query(
      `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $2::uuid, $3, 'directory', $4) RETURNING resource_id, kind`,
      [drive, usersDirectory.resource_id, name, `/Users/${name}`]
    )
    resource = inserted.rows[0] as { resource_id: string; kind: string }
  }

  if (home.resource_id) {
    const grants = await db.query(
      `SELECT permissions, inherit FROM gfs_grants
        WHERE drive = $1 AND resource_id = $2::uuid AND subject_type = 'user' AND subject_id = $3`,
      [drive, resource.resource_id, userId]
    )
    const grant = grants.rows[0] as { permissions: string[]; inherit: boolean } | undefined
    if (
      !grant ||
      !grant.inherit ||
      !OWNER_PERMISSIONS.every(permission => grant.permissions.includes(permission))
    ) {
      return setConflict(db, userId, drive, home, 'ownership_conflict', {
        resourceIds: [resource.resource_id],
      })
    }
  } else {
    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by, introduced_by)
       VALUES ($1, $2::uuid, 'user', $3, $4::text[], true, 'platform:user-home', 'platform:user-home')
       ON CONFLICT DO NOTHING`,
      [drive, resource.resource_id, userId, OWNER_PERMISSIONS]
    )
  }
  const next = transitionUserHomeState(homeState(home), { type: 'provisioned', drive })
  await db.query(
    `UPDATE gfs_user_homes
        SET resource_id = $2::uuid, state = $3, conflict_code = NULL, conflict_detail = NULL,
            attempts = attempts + 1, last_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE user_id = $1::uuid`,
    [userId, resource.resource_id, next.state]
  )
  await auditMutation(db, {
    actorKey: 'platform:user-home',
    targetKey: `user:${userId}`,
    op: 'user_home.provisioned',
    drive,
    resourceId: resource.resource_id,
    outcome: 'allowed',
  })
  return 'ready'
}

/** Provision one user. Unknown COMMIT results are resolved only after the user lock. */
export async function provisionUserHome(
  userId: string,
  options: ProvisionOptions = {}
): Promise<ProvisionUserHomeResult> {
  const drive = options.drive === undefined ? config.gfsHomeDrive : options.drive
  if (!drive) throw new Error('GFS_HOME_DRIVE is required for user-home provisioning')
  const dbPool = options.dbPool ?? pool
  const transaction = options.transaction ?? withTransaction
  for (;;) {
    let outcomeUnknown = false
    try {
      return await transaction(db => installHome(db, userId, drive), dbPool, {
        signal: AbortSignal.timeout(
          options.transactionTimeoutMs ?? PROVISION_TRANSACTION_TIMEOUT_MS
        ),
        onCommitOutcomeUnknown: () => {
          outcomeUnknown = true
        },
      })
    } catch (error) {
      if (!outcomeUnknown) throw error
      const deadline = AbortSignal.timeout(10_000)
      try {
        const state = await transaction(
          async db => {
            await db.query("SET LOCAL statement_timeout = '10s'")
            await lockUser(db, userId)
            const result = await db.query(
              'SELECT state FROM gfs_user_homes WHERE user_id = $1::uuid',
              [userId]
            )
            return (result.rows[0] as { state: HomeRow['state'] } | undefined)?.state
          },
          dbPool,
          { signal: deadline }
        )
        if (state === 'pending') continue
        return state ?? 'unchanged'
      } catch (readError) {
        log.warn(
          { event: 'commit_outcome_pending', userId, errorCode: errorCode(readError) },
          'User-home commit outcome remains pending'
        )
        try {
          await recordUncertainUserHomeAttempt(userId, drive, dbPool)
        } catch (recordError) {
          // A lost connection can also prevent failure accounting; see issue #1203.
          log.error(
            {
              event: 'user_home_attempt_record_failed',
              userId,
              attemptOutcome: 'commit_outcome_pending',
              errorClass: errorClass(recordError),
            },
            'Failed to record user-home attempt'
          )
        }
        return 'pending'
      }
    }
  }
}
