import type { Request, Response, Router } from 'express'
import { config } from '../../config.js'
import { type DbClient, pool, withTransaction } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import { PERMISSIONS, UUID_RE, auditMutation, requestIdOf } from './grants.js'

const HOME_STATES = ['pending', 'ready', 'conflict', 'retired'] as const
const HOME_DEFAULT_PAGE_SIZE = 50
const HOME_MAX_PAGE_SIZE = 100

type HomeRow = {
  user_id: string
  email: string | null
  name: string | null
  state: (typeof HOME_STATES)[number]
  drive: string | null
  storage_username: string | null
  resource_id: string | null
  path_cache: string | null
  conflict_code: string | null
  conflict_detail: unknown
  attempts: number
  last_attempt_at: Date | null
  last_error: string | null
  updated_at: Date
}

const HOME_COLUMNS = `h.user_id, u.email, u.name, h.state, h.drive, h.storage_username, h.resource_id,
  r.path_cache, h.conflict_code, h.conflict_detail, h.attempts, h.last_attempt_at,
  h.last_error, h.updated_at`

const HOME_JOINS = `LEFT JOIN users u ON u.id = h.user_id
  LEFT JOIN gfs_resources r ON r.resource_id = h.resource_id AND r.drive = h.drive`

function homeView(row: HomeRow) {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    state: row.state,
    drive: row.drive,
    storageUsername: row.storage_username,
    resourceId: row.resource_id,
    path: row.path_cache,
    conflictCode: row.conflict_code,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }
}

async function loadHome(db: DbClient, userId: string): Promise<HomeRow | undefined> {
  const result = await db.query(
    `SELECT ${HOME_COLUMNS} FROM gfs_user_homes h ${HOME_JOINS} WHERE h.user_id = $1`,
    [userId]
  )
  return result.rows[0] as HomeRow | undefined
}

async function handleInventory(req: Request, res: Response): Promise<void> {
  const state = req.query.state
  const cursor = req.query.cursor
  const rawLimit = req.query.limit
  if (
    state !== undefined &&
    (typeof state !== 'string' || !HOME_STATES.includes(state as (typeof HOME_STATES)[number]))
  ) {
    res.status(400).json({ error: 'invalid_state' })
    return
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_RE.test(cursor))) {
    res.status(400).json({ error: 'invalid_cursor' })
    return
  }
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== 'string' ||
      !/^[1-9]\d*$/.test(rawLimit) ||
      Number(rawLimit) > HOME_MAX_PAGE_SIZE)
  ) {
    res.status(400).json({ error: 'invalid_limit' })
    return
  }
  const limit = rawLimit === undefined ? HOME_DEFAULT_PAGE_SIZE : Number(rawLimit)
  const [page, totals] = await Promise.all([
    pool.query(
      `SELECT ${HOME_COLUMNS}
         FROM gfs_user_homes h
         ${HOME_JOINS}
        WHERE ($1::text IS NULL OR h.state = $1)
          AND ($2::uuid IS NULL OR h.user_id > $2::uuid)
        ORDER BY h.user_id LIMIT $3`,
      [state ?? null, cursor ?? null, limit + 1]
    ),
    pool.query('SELECT state, count(*)::int AS count FROM gfs_user_homes GROUP BY state'),
  ])
  const rows = page.rows as HomeRow[]
  const visible = rows.slice(0, limit)
  const counts: Record<(typeof HOME_STATES)[number], number> = {
    pending: 0,
    ready: 0,
    conflict: 0,
    retired: 0,
  }
  for (const total of totals.rows as Array<{
    state: (typeof HOME_STATES)[number]
    count: number
  }>) {
    counts[total.state] = total.count
  }
  res.status(200).json({
    items: visible.map(homeView),
    nextCursor: rows.length > limit ? visible[visible.length - 1].user_id : null,
    counts,
  })
}

async function handleDetail(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.userId)
  if (!UUID_RE.test(userId)) {
    res.status(400).json({ error: 'invalid_user_id' })
    return
  }
  const home = await loadHome(pool, userId)
  if (!home) {
    res.status(404).json({ error: 'home_not_found' })
    return
  }
  res.status(200).json({ home: homeView(home) })
}

type RestoreResult =
  | { kind: 'restored'; home: HomeRow }
  | { kind: 'not_found' }
  | { kind: 'not_restorable' }

export async function restoreUserHomeOwnerInTransaction(
  db: DbClient,
  userId: string,
  adminId: string,
  requestId?: string,
  sourceIp?: string
): Promise<RestoreResult> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('gfs:user-home:' || $1::text))", [userId])
  const result = await db.query(
    `SELECT state, drive, storage_username, resource_id, conflict_code, conflict_detail
       FROM gfs_user_homes WHERE user_id = $1 FOR UPDATE`,
    [userId]
  )
  const home = result.rows[0] as HomeRow | undefined
  if (!home) return { kind: 'not_found' }
  if (home.state !== 'conflict' || home.conflict_code !== 'ownership_conflict') {
    return { kind: 'not_restorable' }
  }
  if (!home.drive || !home.resource_id || !home.storage_username) {
    throw new Error('home_owner_binding_invalid')
  }
  const resource = await db.query(
    `SELECT resource_id FROM gfs_resources
      WHERE resource_id = $1 AND drive = $2 AND kind = 'directory' AND deleted_at IS NULL
      FOR SHARE`,
    [home.resource_id, home.drive]
  )
  if (resource.rows.length !== 1) throw new Error('home_owner_binding_invalid')

  const grant = await db.query(
    `INSERT INTO gfs_grants
       (drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by)
     VALUES ($1, $2, 'user', $3, $4::text[], true, 'platform:user-home')
     ON CONFLICT (drive, resource_id, subject_type, subject_id)
     DO UPDATE SET permissions = EXCLUDED.permissions, inherit = true,
                   granted_by = 'platform:user-home', updated_at = now()
     RETURNING permissions, inherit`,
    [home.drive, home.resource_id, userId, [...PERMISSIONS]]
  )
  const restored = grant.rows[0] as { permissions?: unknown; inherit?: unknown } | undefined
  const restoredPermissions = restored?.permissions
  if (
    !restored ||
    restored.inherit !== true ||
    !Array.isArray(restoredPermissions) ||
    !PERMISSIONS.every(permission => restoredPermissions.includes(permission))
  ) {
    throw new Error('home_owner_grant_invariant_failed')
  }

  const audit = {
    actorKey: 'operator:',
    actorOnBehalfOf: adminId,
    targetKey: `user:${userId}`,
    drive: home.drive,
    resourceId: home.resource_id,
    outcome: 'allowed' as const,
    requestId,
    sourceIp,
  }
  await auditMutation(db, { ...audit, op: 'user_home.conflict_cleared.ownership_conflict' })
  // The structured record is emitted before the registry clears the detail;
  // the audit insert and state change are committed or rolled back together.
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
            last_error = NULL, updated_at = now() WHERE user_id = $1`,
    [userId]
  )
  await auditMutation(db, { ...audit, op: 'user_home.restore_owner' })
  const updatedHome = await loadHome(db, userId)
  if (!updatedHome) throw new Error('home_disappeared_during_restore')
  return { kind: 'restored', home: updatedHome }
}

async function handleRestoreOwner(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.userId)
  if (!UUID_RE.test(userId)) {
    res.status(400).json({ error: 'invalid_user_id' })
    return
  }
  const adminId = (req as Request & { adminAuth: { sub: string } }).adminAuth.sub
  const result = await withTransaction(db =>
    restoreUserHomeOwnerInTransaction(db, userId, adminId, requestIdOf(req), req.ip)
  )
  if (result.kind === 'not_found') {
    res.status(404).json({ error: 'home_not_found' })
  } else if (result.kind === 'not_restorable') {
    res.status(409).json({ error: 'home_not_in_ownership_conflict' })
  } else {
    res.status(200).json({ home: homeView(result.home) })
  }
}

export function registerGfsUserHomeRoutes(router: Router): void {
  const rateLimit = (bucketType: string, maxPerMinute: number) =>
    rateLimitMiddleware({
      bucketType,
      maxPerMinute,
      getBucketKey: req => {
        const sub = (req as Request & { adminAuth?: { sub?: string } }).adminAuth?.sub
        return sub ? `${bucketType}:${sub}` : null
      },
      onBackendUnavailable: 'process-memory',
    })
  const readLimit = rateLimit('gfs_user_homes_read', config.adminGfsUserHomesReadPerMin)
  const writeLimit = rateLimit('gfs_user_homes_write', config.adminGfsUserHomesWritePerMin)
  router.get('/gfs/user-homes', requireAuthForControlUI, readLimit, asyncHandler(handleInventory))
  router.get(
    '/gfs/user-homes/:userId',
    requireAuthForControlUI,
    readLimit,
    asyncHandler(handleDetail)
  )
  router.post(
    '/gfs/user-homes/:userId/restore-owner',
    requireAuthForControlUI,
    writeLimit,
    asyncHandler(handleRestoreOwner)
  )
}
