import type { Request, Response, Router } from 'express'
import { config } from '../../config.js'
import { type DbClient, type DbTransactionClient, pool, withTransaction } from '../../db.js'
import { isValidUserHomeName, userHomeRetryNameCandidates } from '../../gfs/userHomeNaming.js'
import {
  USER_HOME_OWNER_PERMISSIONS,
  lockUserHome,
  restoreUserHomeOwnerGrant,
} from '../../gfs/userHomeOwnerRestore.js'
import { reserveUserHomeName } from '../../gfs/userHomeReservation.js'
import {
  type UserHomeConflictCode,
  parseUserHomeConflictDetail,
  transitionUserHomeState,
} from '../../gfs/userHomeState.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import { UUID_RE, auditMutation, requestIdOf } from './grants.js'
import { resolveUserHomeConflictDetail } from './userHomeConflictDetails.js'

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
  conflict_code: UserHomeConflictCode | null
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
  const conflictDetail =
    home.state === 'conflict'
      ? await resolveUserHomeConflictDetail(pool, {
          userId: home.user_id,
          drive: home.drive,
          resourceId: home.resource_id,
          code: home.conflict_code,
          detail: home.conflict_detail,
        })
      : null
  res.status(200).json({ home: { ...homeView(home), conflictDetail } })
}

type RetryResult =
  | { kind: 'retried'; home: HomeRow }
  | { kind: 'not_found' | 'not_retryable' | 'owner_requires_restore' | 'invalid_name' }

type RetryHome = Pick<
  HomeRow,
  'state' | 'drive' | 'storage_username' | 'resource_id' | 'conflict_code' | 'conflict_detail'
>

async function retryUserHomeInTransaction(
  db: DbTransactionClient,
  userId: string,
  storageUsername: unknown,
  adminId: string,
  requestId?: string,
  sourceIp?: string
): Promise<RetryResult> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('gfs:user-home:' || $1)::bigint)", [userId])

  // Read without a row lock so a needed structure lock precedes the home row lock.
  const snapshot = await db.query(
    `SELECT state, drive, storage_username, resource_id, conflict_code, conflict_detail
       FROM gfs_user_homes WHERE user_id = $1`,
    [userId]
  )
  const observed = snapshot.rows[0] as RetryHome | undefined
  let lockedDrive: string | null = null
  if (
    observed?.state === 'conflict' &&
    (observed.conflict_code === 'path_conflict' ||
      observed.conflict_code === 'ancestor_grant_conflict') &&
    !observed.resource_id &&
    typeof storageUsername === 'string' &&
    storageUsername !== observed.storage_username &&
    isValidUserHomeName(storageUsername, userId)
  ) {
    if (!observed.drive) throw new Error('home_conflict_drive_invalid')
    lockedDrive = observed.drive
    await db.query("SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)", [
      lockedDrive,
    ])
  }

  const result = await db.query(
    `SELECT state, drive, storage_username, resource_id, conflict_code, conflict_detail
       FROM gfs_user_homes WHERE user_id = $1 FOR UPDATE`,
    [userId]
  )
  const home = result.rows[0] as RetryHome | undefined
  if (!home) return { kind: 'not_found' }
  if (home.state === 'conflict' && home.conflict_code === 'ownership_conflict') {
    return { kind: 'owner_requires_restore' }
  }
  if (
    home.state !== 'conflict' ||
    (home.conflict_code !== 'path_conflict' && home.conflict_code !== 'ancestor_grant_conflict')
  ) {
    return { kind: 'not_retryable' }
  }
  if (storageUsername !== undefined && typeof storageUsername !== 'string') {
    return { kind: 'invalid_name' }
  }
  if (
    home.resource_id &&
    storageUsername !== undefined &&
    storageUsername !== home.storage_username
  ) {
    return { kind: 'not_retryable' }
  }
  if (!home.drive) throw new Error('home_conflict_drive_invalid')
  if (storageUsername !== undefined && storageUsername !== home.storage_username) {
    if (!isValidUserHomeName(storageUsername, userId)) return { kind: 'invalid_name' }
    if (lockedDrive !== home.drive) throw new Error('home_retry_structure_lock_changed')
    await reserveUserHomeName(
      db,
      userId,
      home.drive,
      userHomeRetryNameCandidates(userId, storageUsername)
    )
  }

  const detail = parseUserHomeConflictDetail(home.conflict_detail)
  const conflictResource =
    home.conflict_code === 'path_conflict' ? detail.resourceIds[0] : undefined
  if (home.conflict_code === 'path_conflict' && !home.resource_id && !conflictResource) {
    throw new Error('Path conflict lacks its resource identity')
  }
  const next = transitionUserHomeState(
    {
      state: home.state,
      drive: home.drive,
      conflictCode: home.conflict_code,
      conflictDetail: detail,
    },
    { type: 'retry' }
  )
  await auditMutation(db, {
    actorKey: 'operator:',
    actorOnBehalfOf: adminId,
    targetKey: `user:${userId}`,
    op: `user_home.conflict_cleared.${home.conflict_code}`,
    drive: home.drive,
    resourceId: home.resource_id ?? conflictResource ?? null,
    outcome: 'allowed',
    requestId,
    sourceIp,
  })
  rootLogger.info(
    {
      event: 'user_home.conflict_cleared',
      userId,
      conflictCode: home.conflict_code,
      conflictDetail: detail,
      transactionState: 'pending_commit',
    },
    'user home conflict clearing'
  )
  await db.query(
    `UPDATE gfs_user_homes SET state = $2, conflict_code = NULL, conflict_detail = NULL,
            attempts = 0, last_error = NULL, updated_at = now() WHERE user_id = $1`,
    [userId, next.state]
  )
  const updatedHome = await loadHome(db, userId)
  if (!updatedHome) throw new Error('home_disappeared_during_retry')
  return { kind: 'retried', home: updatedHome }
}

async function handleRetry(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.userId).toLowerCase()
  if (!UUID_RE.test(userId)) {
    res.status(400).json({ error: 'invalid_user_id' })
    return
  }
  const adminId = (req as Request & { adminAuth: { sub: string } }).adminAuth.sub
  const result = await withTransaction(db =>
    retryUserHomeInTransaction(
      db,
      userId,
      req.body?.storageUsername,
      adminId,
      requestIdOf(req),
      req.ip
    )
  )
  switch (result.kind) {
    case 'not_found':
      res.status(404).json({ error: 'home_not_found' })
      return
    case 'not_retryable':
      res.status(409).json({ error: 'home_not_retryable' })
      return
    case 'owner_requires_restore':
      res.status(409).json({ error: 'home_owner_grant_requires_operator_restore' })
      return
    case 'invalid_name':
      res.status(422).json({ error: 'invalid_name' })
      return
    case 'retried':
      res.status(202).json({ home: homeView(result.home) })
  }
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
  await lockUserHome(db, userId)
  // One implementation serves this route and the operator grant PUT (D34):
  // validation, invariant check, audit and the state change live there.
  const outcome = await restoreUserHomeOwnerGrant(
    db,
    userId,
    { actorKey: 'operator:', actorOnBehalfOf: adminId, requestId, sourceIp },
    async binding => {
      await db.query(
        `INSERT INTO gfs_grants
           (drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by)
         VALUES ($1, $2, 'user', $3, $4::text[], true, 'platform:user-home')
         ON CONFLICT (drive, resource_id, subject_type, subject_id)
         DO UPDATE SET permissions = EXCLUDED.permissions, inherit = true,
                       granted_by = 'platform:user-home', updated_at = now()`,
        [binding.drive, binding.resourceId, binding.userId, [...USER_HOME_OWNER_PERMISSIONS]]
      )
    }
  )
  if (outcome === 'not_found') return { kind: 'not_found' }
  if (outcome === 'not_restorable') return { kind: 'not_restorable' }
  const updatedHome = await loadHome(db, userId)
  if (!updatedHome) throw new Error('home_disappeared_during_restore')
  return { kind: 'restored', home: updatedHome }
}

async function handleRestoreOwner(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.userId).toLowerCase()
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
    '/gfs/user-homes/:userId/retry',
    requireAuthForControlUI,
    writeLimit,
    asyncHandler(handleRetry)
  )
  router.post(
    '/gfs/user-homes/:userId/restore-owner',
    requireAuthForControlUI,
    writeLimit,
    asyncHandler(handleRestoreOwner)
  )
}
