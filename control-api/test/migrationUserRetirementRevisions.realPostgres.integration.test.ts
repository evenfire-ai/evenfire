import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { CONTROL_API_MIGRATIONS, assertDbReady, initDb } from '../src/db.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const VERSION = '0134_composable_catalog_revisions'
const isBackfill = (sql: string) => sql.includes('previous_lock_timeout TEXT')

describeRealPostgres('0134 user retirement revision coverage on PostgreSQL 16', () => {
  let database: string
  let admin: Pool
  let db: Pool
  const user = randomUUID(),
    retired = randomUUID(),
    team = randomUUID()

  beforeEach(async () => {
    expect(process.version).toMatch(/^v24\./)
    database = `retirement_migration_${randomBytes(6).toString('hex')}`
    admin = new Pool({ connectionString: adminUrl })
    const version = Number(
      (await admin.query('SHOW server_version_num')).rows[0].server_version_num
    )
    expect(version).toBeGreaterThanOrEqual(160000)
    expect(version).toBeLessThan(170000)
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    db = new Pool({ connectionString: url.toString() })
    const migration = CONTROL_API_MIGRATIONS.find(m => m.version === VERSION)!
    const apply = migration.apply
    const stop = new Error('stop before 0134')
    migration.apply = async () => {
      throw stop
    }
    try {
      await expect(initDb({ connect: () => db.connect() })).rejects.toBe(stop)
    } finally {
      migration.apply = apply
    }
    await db.query(
      "INSERT INTO users(id,email) VALUES($1,'active@example.test'),($2,'retired@example.test')",
      [user, retired]
    )
    await db.query("INSERT INTO teams(id,name) VALUES($1,'team without memberships')", [team])
    // A valid retained lifecycle from before 0134, without relying on the new caller.
    const actor = randomUUID(),
      operation = randomUUID()
    await db.query(
      `INSERT INTO control_admin_users(id,username,password_hash,role,status)
      VALUES($1,$2,'test-unusable-hash','admin','disabled')`,
      [actor, actor]
    )
    await db.query(
      `INSERT INTO desktop_user_retirement_operations(id,operation,actor_type,
      actor_control_admin_id,target_user_id,idempotency_key_hash,request_fingerprint,reason)
      VALUES($1,'retire_desktop_user','control_admin',$2,$3,repeat('a',64),repeat('b',64),'legacy retirement')`,
      [operation, actor, retired]
    )
    await db.query(
      `UPDATE users SET lifecycle_state='retired',retired_at=NOW(),
      retirement_reason='legacy retirement',retired_by_type='control_admin',
      retired_by_control_admin_id=$2,retirement_operation_id=$3 WHERE id=$1`,
      [retired, actor, operation]
    )
    await db.query('DELETE FROM authorization_user_revisions')
    await db.query('DELETE FROM authorization_team_revisions')
  })
  afterEach(async () => {
    try {
      await endPoolAndWaitForClients(db)
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await endPoolAndWaitForClients(admin)
    }
  })
  async function coverage() {
    return (
      await db.query(`SELECT
      (SELECT count(*)::int FROM users u LEFT JOIN authorization_user_revisions r ON r.user_id=u.id WHERE r.user_id IS NULL) AS users,
      (SELECT count(*)::int FROM teams t LEFT JOIN authorization_team_revisions r ON r.team_id=t.id WHERE r.team_id IS NULL) AS teams`)
    ).rows[0]
  }
  async function assertNoReceipt() {
    expect(
      (await db.query('SELECT version FROM schema_migrations WHERE version >= $1', [VERSION])).rows
    ).toEqual([])
    await expect(assertDbReady(db)).rejects.toThrow(VERSION)
    expect(
      (
        await db.query(
          "SELECT to_regprocedure('public.authorization_prelock_user_retirement_revisions(uuid[])')::text AS function"
        )
      ).rows
    ).toEqual([{ function: null }])
  }
  it('covers every lifecycle and teams without memberships, preserves revisions and commits one receipt', async () => {
    await db.query('INSERT INTO authorization_user_revisions(user_id,revision) VALUES($1,7)', [
      user,
    ])
    await initDb({ connect: () => db.connect() })
    expect(await coverage()).toEqual({ users: 0, teams: 0 })
    expect(
      (await db.query('SELECT user_id,revision FROM authorization_user_revisions ORDER BY user_id'))
        .rows
    ).toEqual(
      [
        { user_id: user, revision: '7' },
        { user_id: retired, revision: '1' },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id))
    )
    expect(
      (await db.query('SELECT revision FROM authorization_team_revisions WHERE team_id=$1', [team]))
        .rows
    ).toEqual([{ revision: '1' }])
    const before = (await db.query('SELECT * FROM authorization_user_revisions ORDER BY user_id'))
      .rows
    await initDb({ connect: () => db.connect() })
    expect(
      (await db.query('SELECT * FROM authorization_user_revisions ORDER BY user_id')).rows
    ).toEqual(before)
    expect(
      (
        await db.query('SELECT count(*)::int AS count FROM schema_migrations WHERE version=$1', [
          VERSION,
        ])
      ).rows
    ).toEqual([{ count: 1 }])
    await expect(assertDbReady(db)).resolves.toBeUndefined()
  })
  it('rolls back interrupted coverage and function DDL without a receipt, then resumes', async () => {
    const interruption = new Error('interrupted after coverage')
    await expect(
      initDb({
        connect: async () => {
          const c = await db.connect()
          return {
            release: () => c.release(),
            query: async (sql: string, values?: unknown[]) => {
              const result = await c.query(sql, values)
              if (isBackfill(sql)) throw interruption
              return result
            },
          }
        },
      })
    ).rejects.toBe(interruption)
    await assertNoReceipt()
    expect(await coverage()).toEqual({ users: 2, teams: 1 })
    await initDb({ connect: () => db.connect() })
    expect(await coverage()).toEqual({ users: 0, teams: 0 })
  })
  it('refuses a receipt when runtime EXECUTE is missing and restores the whole unit on rerun', async () => {
    await expect(
      initDb({
        connect: async () => {
          const c = await db.connect()
          return {
            release: () => c.release(),
            query: async (sql: string, values?: unknown[]) => {
              if (isBackfill(sql))
                await c.query(
                  'REVOKE EXECUTE ON FUNCTION public.authorization_prelock_user_retirement_revisions(uuid[]) FROM control_api_runtime'
                )
              return c.query(sql, values)
            },
          }
        },
      })
    ).rejects.toThrow('prelock owner or runtime privileges are invalid')
    await assertNoReceipt()
    expect(await coverage()).toEqual({ users: 2, teams: 1 })
    await initDb({ connect: () => db.connect() })
    expect(await coverage()).toEqual({ users: 0, teams: 0 })
  })
  it('bounds the real migration backfill lock wait below deadlock detection and resumes after rollback', async () => {
    const blocker = await db.connect()
    let migrationPid: number | undefined
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    let observed: unknown
    let migration: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user])
      migration = initDb({
        connect: async () => {
          const c = await db.connect()
          await c.query("SET deadlock_timeout='2s'")
          migrationPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          return c
        },
      }).then(
        () => null,
        error => error
      )
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        if (migrationPid) {
          const row = (await db.query('SELECT pg_blocking_pids($1) AS blockers', [migrationPid]))
            .rows[0]
          if (row.blockers.includes(blockerPid)) {
            observed = row
            break
          }
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(observed).toBeDefined()
      expect(await migration).toMatchObject({ code: '55P03' })
      await assertNoReceipt()
      expect(await coverage()).toEqual({ users: 2, teams: 1 })
    } finally {
      await blocker.query('ROLLBACK')
      await migration
      blocker.release()
    }
    await initDb({ connect: () => db.connect() })
    expect(await coverage()).toEqual({ users: 0, teams: 0 })
  })
})
