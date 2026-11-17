import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashSync } from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import pino from 'pino'
import { withTransaction } from '../src/db.js'
import { provisionUserHome } from '../src/gfs/userHomeProvisioner.js'
import { rootLogger } from '../src/observability/logger.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import { GfsUserHomeReconciler } from '../src/services/gfsUserHomeReconciler.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import {
  createDrive,
  createUser,
  createUserHomeDatabase,
  homeState,
} from './helpers/userHomeRealPostgres.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('automatic user-home backfill on PostgreSQL', () => {
  let adminPool: Pool
  let database: Awaited<ReturnType<typeof createUserHomeDatabase>>
  let databaseOpen = false
  let drive: string

  async function closeDatabase() {
    if (!databaseOpen) return
    databaseOpen = false
    await database.closeConnections()
    await adminPool.query(`DROP DATABASE "${database.database}"`)
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
  })

  beforeEach(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    database = await createUserHomeDatabase(adminUrl, adminPool)
    databaseOpen = true
    drive = `homes-${randomUUID()}`
    await createDrive(database.pool, drive)
  }, 60_000)

  afterEach(async () => {
    await closeDatabase()
  }, 60_000)

  afterAll(async () => {
    try {
      await closeDatabase()
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  it('backfills 250 active users across ticks, insertion and restart without enrolling a retired user', async () => {
    const rows = await database.pool.query<{ id: string }>(
      `INSERT INTO users (email, name)
       SELECT 'backfill-' || n || '-' || $1 || '@example.test', 'Backfill ' || n
         FROM generate_series(1, 250) n RETURNING id::text`,
      [randomUUID()]
    )
    const ids = rows.rows.map(row => row.id)
    await database.pool.query('DELETE FROM gfs_user_homes WHERE user_id = ANY($1::uuid[])', [ids])

    const retired = await createUser(database.pool, 'Retired User')
    const adminId = randomUUID()
    await database.pool.query(
      `INSERT INTO control_admin_users (id, username, email, password_hash, role, status, session_version)
       VALUES ($1, $2, $3, $4, 'admin', 'active', 1)`,
      [adminId, `admin-${adminId}`, `${adminId}@example.test`, hashSync(randomUUID(), 4)]
    )
    await withTransaction(
      db =>
        retireDesktopUser(
          { kind: 'control_admin', controlAdminId: adminId },
          retired,
          'test retirement',
          randomUUID(),
          null,
          { db, retainWithoutLinkHistory: true }
        ),
      database.pool
    )
    await database.pool.query('DELETE FROM gfs_user_homes WHERE user_id = $1', [retired])

    const first = new GfsUserHomeReconciler(drive, database.pool)
    await first.tick()
    const enrolled = await database.pool.query(
      'SELECT count(*)::int AS count FROM gfs_user_homes WHERE user_id = ANY($1::uuid[])',
      [ids]
    )
    expect(enrolled.rows[0].count).toBe(200)
    const duringPass = await createUser(database.pool, 'New During Pass')
    expect(await homeState(database.pool, duringPass)).toMatchObject({ state: 'pending' })

    const restarted = new GfsUserHomeReconciler(drive, database.pool)
    for (let n = 0; n < 6; n++) await restarted.tick()
    const result = await database.pool.query(
      `SELECT count(*)::int AS homes, count(*) FILTER (WHERE state = 'ready')::int AS ready,
              count(DISTINCT resource_id)::int AS resources
         FROM gfs_user_homes WHERE user_id = ANY($1::uuid[])`,
      [[...ids, duringPass]]
    )
    expect(result.rows[0]).toEqual({ homes: 251, ready: 251, resources: 251 })
    expect(await homeState(database.pool, retired)).toBeUndefined()
    await restarted.tick()
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS count FROM gfs_user_homes WHERE user_id = ANY($1::uuid[])',
          [[...ids, duringPass]]
        )
      ).rows[0].count
    ).toBe(251)
  }, 120_000)

  it('moves a repeatedly failing row behind healthy users and ignores a different drive', async () => {
    const failed = await createUser(database.pool, 'Failing User')
    const healthy: string[] = []
    for (let n = 0; n < 52; n++) healthy.push(await createUser(database.pool, `Healthy User ${n}`))
    const mismatch = await createUser(database.pool, 'Different Drive')
    await database.pool.query('UPDATE gfs_user_homes SET drive = $2 WHERE user_id = $1', [
      mismatch,
      'another-drive',
    ])
    await database.pool.query(
      "UPDATE gfs_user_homes SET last_attempt_at = '2000-01-01' WHERE user_id = $1",
      [failed]
    )
    // Select the failed user deterministically ahead of otherwise untouched rows.
    await database.pool.query(
      "UPDATE gfs_user_homes SET last_attempt_at = '2001-01-01' WHERE user_id = ANY($1::uuid[])",
      [healthy]
    )
    const worker = new GfsUserHomeReconciler(drive, database.pool, async userId => {
      if (userId === failed) throw new Error('injected transaction failure')
      return provisionUserHome(userId, { drive, dbPool: database.pool })
    })
    await worker.tick()
    const failedAfterOne = await homeState(database.pool, failed)
    expect(failedAfterOne).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error: 'provisioning_failed',
    })
    await worker.tick()
    expect(await homeState(database.pool, failed)).toMatchObject({ state: 'pending', attempts: 2 })
    const ready = await database.pool.query(
      'SELECT count(*)::int AS count FROM gfs_user_homes WHERE user_id = ANY($1::uuid[]) AND state = $2',
      [healthy, 'ready']
    )
    expect(ready.rows[0].count).toBe(52)
    expect(await homeState(database.pool, mismatch)).toMatchObject({
      state: 'pending',
      drive: 'another-drive',
      attempts: 0,
    })
  }, 60_000)

  it('logs a failed accounting write once and retries the unchanged row on the next tick', async () => {
    const user = await createUser(database.pool, 'Accounting User')
    await database.pool.query(
      "UPDATE gfs_resources SET path_cache = '/invalid-root' WHERE drive = $1 AND parent_resource_id IS NULL",
      [drive]
    )
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const limitedPool = new Pool({
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: 250,
      statement_timeout: 10_000,
    })
    let held: PoolClient | undefined
    const logger = rootLogger as unknown as Record<symbol, unknown>
    const streamSymbol = pino.symbols.streamSym
    const oldStream = logger[streamSymbol]
    const oldLevel = rootLogger.level
    const lines: Array<Record<string, unknown>> = []
    logger[streamSymbol] = {
      write: (line: string) => {
        lines.push(JSON.parse(line))
        return true
      },
    }
    rootLogger.level = 'error'
    try {
      const worker = new GfsUserHomeReconciler(drive, limitedPool, async userId => {
        try {
          return await provisionUserHome(userId, { drive, dbPool: limitedPool })
        } catch (error) {
          held = await limitedPool.connect()
          throw error
        }
      })
      await worker.tick()
      expect(await homeState(database.pool, user)).toMatchObject({ state: 'pending', attempts: 0 })
      expect(lines.filter(line => line.level === 50)).toEqual([
        expect.objectContaining({
          event: 'user_home_attempt_record_failed',
          userId: user,
          attemptOutcome: 'failed',
          errorClass: 'Error',
        }),
      ])
      held!.release()
      held = undefined
      await database.pool.query(
        "UPDATE gfs_resources SET path_cache = '/' WHERE drive = $1 AND parent_resource_id IS NULL",
        [drive]
      )
      await new GfsUserHomeReconciler(drive, limitedPool).tick()
      const ready = await homeState(database.pool, user)
      expect(ready).toMatchObject({ state: 'ready', drive })
      const grant = await database.pool.query(
        "SELECT count(*)::int AS count FROM gfs_grants WHERE resource_id = $1 AND subject_type = 'user' AND subject_id = $2",
        [ready!.resource_id, user]
      )
      expect(grant.rows[0].count).toBe(1)
    } finally {
      held?.release()
      rootLogger.level = oldLevel
      logger[streamSymbol] = oldStream
      await endPoolAndWaitForClients(limitedPool)
    }
  }, 60_000)

  it('deduplicates concurrent ticks and finishes the current user on shutdown', async () => {
    const user = await createUser(database.pool, 'Tick User')
    const another = await createUser(database.pool, 'Other Tick User')
    let started!: () => void
    let finish!: () => void
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    let calls = 0
    const worker = new GfsUserHomeReconciler(drive, database.pool, async id => {
      calls++
      started()
      await gate
      return provisionUserHome(id, { drive, dbPool: database.pool })
    })
    const competing = new GfsUserHomeReconciler(drive, database.pool)
    const firstTick = worker.tick()
    await entered
    await competing.tick()
    expect(await homeState(database.pool, user)).toMatchObject({ state: 'pending' })
    expect(await homeState(database.pool, another)).toMatchObject({ state: 'pending' })
    const stopped = worker.stop()
    finish()
    await Promise.all([firstTick, stopped])
    expect(calls).toBe(1)
    const counts = await database.pool.query(
      'SELECT state, count(*)::int AS count FROM gfs_user_homes GROUP BY state'
    )
    expect(counts.rows).toEqual(
      expect.arrayContaining([
        { state: 'ready', count: 1 },
        { state: 'pending', count: 1 },
      ])
    )
    await competing.tick()
    expect(await homeState(database.pool, user)).toMatchObject({ state: 'ready' })
    expect(await homeState(database.pool, another)).toMatchObject({ state: 'ready' })
  }, 60_000)

  it('provisions when the configured core pool permits only one connection', async () => {
    const user = await createUser(database.pool, 'Single Connection User')
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    const constrainedPool = new Pool({
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: 250,
      statement_timeout: 10_000,
    })
    try {
      const worker = new GfsUserHomeReconciler(drive, constrainedPool)
      await worker.tick()
      expect(await homeState(database.pool, user)).toMatchObject({ state: 'ready', drive })
    } finally {
      await endPoolAndWaitForClients(constrainedPool)
    }
  })
})
