import { Client, type Pool } from 'pg'
import { config } from '../config.js'
import { pool } from '../db.js'
import {
  provisionUserHome,
  recordFailedUserHomeAttempt,
  repairUserHomeOwnerGrant,
} from '../gfs/userHomeProvisioner.js'
import { rootLogger } from '../observability/logger.js'

const log = rootLogger.child({ service: 'gfs_user_home_reconciler' })
const FIRST_CURSOR = '00000000-0000-0000-0000-000000000000'
const LOCK_KEY = "hashtext('gfs-user-home-reconciler-v1')"
const PERIOD_MS = 60_000

// Materialize each page and retain lateral index lookups so a startup pass
// stays bounded as the home registry grows; D18 requires index-backed scans.
export const STARTUP_RETIRED_SQL = `WITH batch AS MATERIALIZED (
  SELECT h.user_id FROM gfs_user_homes h
   WHERE h.state IN ('ready', 'conflict') AND h.user_id > $1::uuid
   ORDER BY h.user_id LIMIT 50
)
SELECT b.user_id::text, (u.id IS NULL OR u.lifecycle_state <> 'active') AS needs_repair
  FROM batch b LEFT JOIN LATERAL (
    SELECT id, lifecycle_state FROM users WHERE id = b.user_id OFFSET 0
  ) u ON true ORDER BY b.user_id`

export const STARTUP_OWNER_SQL = `WITH batch AS MATERIALIZED (
  SELECT h.user_id, h.drive, h.resource_id FROM gfs_user_homes h
   WHERE h.state = 'ready' AND h.user_id > $1::uuid ORDER BY h.user_id LIMIT 50
)
SELECT b.user_id::text,
  (g.id IS NULL OR NOT g.inherit OR NOT g.permissions @> ARRAY['read','write','delete','share','manage_acl']::text[]) AS needs_repair
  FROM batch b LEFT JOIN LATERAL (
    SELECT id, inherit, permissions FROM gfs_grants
     WHERE drive = b.drive AND resource_id = b.resource_id
       AND subject_type = 'user' AND subject_id = b.user_id::text OFFSET 0
  ) g ON true ORDER BY b.user_id`

function errorClass(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) return error.name
  return typeof error
}

type StartupRepairPhase = 'retired' | 'owner'
type StartupRepairTarget = { phase: StartupRepairPhase; userId: string }

export class GfsUserHomeReconciler {
  private cursor = FIRST_CURSOR
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private stopping = false
  // null until the full startup pass completes; afterwards it holds only the
  // rows that still failed, so a retry tick never rescans the whole registry.
  private startupRepairRetry: StartupRepairTarget[] | null = null

  constructor(
    private readonly drive: string,
    private readonly dbPool: Pool = pool,
    private readonly provision = (userId: string) =>
      provisionUserHome(userId, { drive: this.drive, dbPool: this.dbPool })
  ) {}

  start(): void {
    if (this.timer) return
    this.stopping = false
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, PERIOD_MS)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.running
  }

  async tick(): Promise<void> {
    if (this.stopping || this.running) return
    const run = this.runTick()
    this.running = run
    try {
      await run
    } finally {
      if (this.running === run) this.running = undefined
    }
  }

  private async runTick(): Promise<void> {
    let client: Client | undefined
    let locked = false
    let sessionFailed = false
    try {
      // The lock must outlive each user transaction. Keep its session separate
      // so CORE_POOL_MAX=1 still leaves the pool available for provisioning.
      // pg-pool hides an explicit password from object spread.
      client = new Client({
        ...this.dbPool.options,
        password: this.dbPool.options.password,
        query_timeout: 10_000,
      })
      client.on('error', () => {
        sessionFailed = true
        log.error(
          { event: 'user_home_reconcile_session_failed' },
          'User-home reconciliation session failed'
        )
      })
      await client.connect()
      const lockResult = await client.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired`)
      locked = lockResult.rows[0]?.acquired === true
      if (!locked || this.stopping) return

      if (this.startupRepairRetry === null) {
        this.startupRepairRetry = await this.repairStartup(client)
        if (this.stopping || sessionFailed) return
      } else if (this.startupRepairRetry.length > 0) {
        await this.retryFailedStartupRepairs()
        if (this.stopping || sessionFailed) return
      }

      // Return the scanned candidates, including insert races, so the cursor
      // advances even when the enrollment trigger won ON CONFLICT.
      const candidates = await client.query<{ user_id: string }>(
        `WITH candidates AS MATERIALIZED (
           SELECT u.id AS user_id FROM users u
            WHERE u.lifecycle_state = 'active' AND u.id > $1::uuid
              AND NOT EXISTS (SELECT 1 FROM gfs_user_homes h WHERE h.user_id = u.id)
            ORDER BY u.id LIMIT 200
         ), inserted AS (
           INSERT INTO gfs_user_homes (user_id, state)
           SELECT user_id, 'pending' FROM candidates
           ON CONFLICT (user_id) DO NOTHING RETURNING user_id
         )
         SELECT user_id::text FROM candidates ORDER BY user_id`,
        [this.cursor]
      )
      this.cursor = candidates.rows.at(-1)?.user_id ?? FIRST_CURSOR
      if (this.stopping) return

      const pending = await client.query<{ user_id: string }>(
        `SELECT user_id::text FROM gfs_user_homes
          WHERE state = 'pending' AND (drive IS NULL OR drive = $1)
          ORDER BY last_attempt_at NULLS FIRST, user_id LIMIT 50`,
        [this.drive]
      )
      for (const row of pending.rows) {
        if (this.stopping || sessionFailed) break
        try {
          await this.provision(row.user_id)
        } catch (error) {
          try {
            await recordFailedUserHomeAttempt(row.user_id, this.drive, error, this.dbPool)
          } catch (recordError) {
            // A lost connection can also prevent failure accounting; see issue #1203.
            log.error(
              {
                event: 'user_home_attempt_record_failed',
                userId: row.user_id,
                attemptOutcome: 'failed',
                errorClass: errorClass(recordError),
              },
              'Failed to record user-home attempt'
            )
            continue
          }
          log.error(
            { event: 'user_home_provision_failed', userId: row.user_id },
            'User-home provisioning failed'
          )
        }
      }
    } catch (error) {
      log.error(
        { event: 'user_home_reconcile_tick_failed' },
        'User-home reconciliation tick failed'
      )
    } finally {
      if (client && locked) {
        try {
          await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`)
        } catch {
          // Closing this dedicated session also releases a retained lock.
        }
      }
      if (client) await client.end().catch(() => {})
    }
  }

  private async repairStartupTarget(target: StartupRepairTarget): Promise<void> {
    if (target.phase === 'retired') {
      await provisionUserHome(target.userId, { drive: this.drive, dbPool: this.dbPool })
      return
    }
    await repairUserHomeOwnerGrant(target.userId, this.drive, this.dbPool)
  }

  /** Retry only the rows that failed, and keep only the ones that fail again. */
  private async retryFailedStartupRepairs(): Promise<void> {
    const remaining: StartupRepairTarget[] = []
    for (const target of this.startupRepairRetry ?? []) {
      if (this.stopping) return
      try {
        await this.repairStartupTarget(target)
      } catch (error) {
        remaining.push(target)
        log.error(
          {
            event: 'user_home_startup_repair_failed',
            userId: target.userId,
            errorClass: errorClass(error),
          },
          'User-home startup repair failed'
        )
      }
    }
    this.startupRepairRetry = remaining
  }

  /** Returns the failed rows, or null when the pass was interrupted. */
  private async repairStartup(client: Client): Promise<StartupRepairTarget[] | null> {
    const failed: StartupRepairTarget[] = []
    for (const phase of ['retired', 'owner'] as const) {
      const sql = phase === 'retired' ? STARTUP_RETIRED_SQL : STARTUP_OWNER_SQL
      let cursor = FIRST_CURSOR
      for (;;) {
        if (this.stopping) return null
        const page = await client.query<{ user_id: string; needs_repair: boolean }>(sql, [cursor])
        if (page.rows.length === 0) break
        for (const row of page.rows) {
          if (this.stopping) return null
          if (!row.needs_repair) continue
          try {
            await this.repairStartupTarget({ phase, userId: row.user_id })
          } catch (error) {
            failed.push({ phase, userId: row.user_id })
            log.error(
              {
                event: 'user_home_startup_repair_failed',
                userId: row.user_id,
                errorClass: errorClass(error),
              },
              'User-home startup repair failed'
            )
          }
        }
        cursor = page.rows[page.rows.length - 1]!.user_id
      }
    }
    return this.stopping ? null : failed
  }
}

let reconciler: GfsUserHomeReconciler | undefined

export function startGfsUserHomeReconciler(): void {
  if (reconciler) return
  if (!config.gfsHomeDrive) {
    log.error(
      { event: 'gfs_home_drive_missing' },
      'GFS_HOME_DRIVE is missing; user-home reconciliation is disabled'
    )
    return
  }
  reconciler = new GfsUserHomeReconciler(config.gfsHomeDrive)
  reconciler.start()
}

export async function stopGfsUserHomeReconciler(): Promise<void> {
  const current = reconciler
  if (!current) return
  await current.stop()
  if (reconciler === current) reconciler = undefined
}
