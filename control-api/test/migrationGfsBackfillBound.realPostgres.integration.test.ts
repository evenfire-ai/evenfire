import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { CONTROL_API_MIGRATIONS, assertDbReady, initDb } from '../src/db.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const VERSION = '0134_composable_catalog_revisions'
const NEXT_VERSION = '0135_legacy_password_security_epoch_backfill'

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

describeRealPostgres('0134 GFS backfill bound on real PostgreSQL', () => {
  let database: string
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(() => {
    adminPool = new Pool({ connectionString: adminUrl })
  })

  beforeEach(async () => {
    database = `control_api_gfs_bound_${randomBytes(6).toString('hex')}`
    await adminPool.query(`CREATE DATABASE "${database}"`)
    databasePool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })

    // Build the actual pre-0134 schema and receipts through initDb. Abort at
    // entry to 0134 rather than running it and faking an older database state.
    const migration = CONTROL_API_MIGRATIONS.find(item => item.version === VERSION)!
    const original = migration.apply
    const stop = new Error('fixture stops before 0134')
    migration.apply = async () => {
      throw stop
    }
    try {
      await expect(initDb({ connect: () => databasePool.connect() })).rejects.toBe(stop)
    } finally {
      migration.apply = original
    }
    const receipts = await databasePool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    )
    expect(receipts.rows).toEqual([{ version: '0133_catalog_utf8_ordering' }])
    expect((await databasePool.query('SELECT count(*) FROM gfs_resources')).rows).toEqual([
      { count: '0' },
    ])
  })

  afterEach(async () => {
    await endPoolAndWaitForClients(databasePool)
    if (adminPool && database) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
      database = ''
    }
  })

  afterAll(async () => {
    try {
      // Retry the last database cleanup if a per-test teardown failed.
      if (adminPool && database) {
        await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function seedResources(count: number): Promise<void> {
    // Separate drives give each root a valid, unique structural identity.
    const inserted = await databasePool.query(
      `INSERT INTO gfs_resources(drive, name, kind)
       SELECT 'bound-' || n, 'root', 'directory' FROM generate_series(1, $1::int) AS n`,
      [count]
    )
    expect(inserted.rowCount).toBe(count)
    const resources = await databasePool.query('SELECT count(*) FROM gfs_resources')
    expect(resources.rows).toEqual([{ count: String(count) }])
  }

  async function shareRowExclusiveLocks(pid: number): Promise<unknown[]> {
    const result = await databasePool.query(
      `SELECT relation::regclass::text AS relation, granted
         FROM pg_locks
        WHERE pid = $1 AND mode = 'ShareRowExclusiveLock'`,
      [pid]
    )
    return result.rows
  }

  async function migrate() {
    const triggerDdl: string[] = []
    let locksBeforeBackfill: unknown[] | undefined
    let locksAfterRollback: unknown[] | undefined
    let statementTimeout: string | undefined
    let error: unknown
    const started = Date.now()
    try {
      await initDb({
        connect: async () => {
          const client = await databasePool.connect()
          const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          const pid = rows[0]!.pid
          return {
            release: (destroy?: boolean | Error) => client.release(destroy),
            query: async (sql: string, values?: unknown[]) => {
              if (/\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b/i.test(sql)) triggerDdl.push(sql)
              if (sql.trimStart().startsWith('INSERT INTO authorization_resource_revisions(')) {
                locksBeforeBackfill = await shareRowExclusiveLocks(pid)
                const setting = await client.query('SHOW statement_timeout')
                statementTimeout = setting.rows[0].statement_timeout
              }
              const result = await client.query(sql, values)
              if (sql.trim() === 'ROLLBACK') {
                locksAfterRollback = await shareRowExclusiveLocks(pid)
              }
              return result
            },
          }
        },
      })
    } catch (caught) {
      error = caught
    }
    return {
      error,
      triggerDdl,
      locksBeforeBackfill,
      locksAfterRollback,
      statementTimeout,
      elapsedMs: Date.now() - started,
    }
  }

  it.each([0, 662, 100000])('backfills %i resources and commits its receipt', async count => {
    await seedResources(count)
    // Existing non-default revisions must survive ON CONFLICT unchanged.
    await databasePool.query(
      `INSERT INTO authorization_resource_revisions(environment_id, resource_type, resource_id, revision)
       SELECT $1, 'gfs_resource', resource_id::text, 7 FROM gfs_resources LIMIT 1`,
      [canonicalEnvironmentId()]
    )

    const run = await migrate()

    expect(run.error).toBeUndefined()
    expect(run.locksBeforeBackfill).toEqual([])
    expect(run.statementTimeout).toBe('15s')
    expect(run.triggerDdl).toHaveLength(1)
    const coverage = await databasePool.query(
      `SELECT count(*)::int AS resources, count(revision.resource_id)::int AS covered,
              count(*) FILTER (WHERE revision.revision = 7)::int AS preserved
         FROM gfs_resources AS resource
         LEFT JOIN authorization_resource_revisions AS revision
           ON revision.environment_id = $1 AND revision.resource_type = 'gfs_resource'
          AND revision.resource_id = resource.resource_id::text`,
      [canonicalEnvironmentId()]
    )
    expect(coverage.rows).toEqual([{ resources: count, covered: count, preserved: count ? 1 : 0 }])
    const receipts = await databasePool.query(
      'SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version',
      [[VERSION, NEXT_VERSION]]
    )
    expect(receipts.rows).toEqual([{ version: VERSION }, { version: NEXT_VERSION }])
    await expect(assertDbReady(databasePool)).resolves.toBeUndefined()
    console.info('B0 backfill', {
      count,
      ...coverage.rows[0],
      elapsedMs: run.elapsedMs,
      statementTimeout: run.statementTimeout,
    })
  })

  it('refuses 100001 resources before trigger DDL and rolls back without a receipt or locks', async () => {
    await seedResources(100001)
    await databasePool.query(
      `INSERT INTO authorization_resource_revisions(environment_id, resource_type, resource_id, revision)
       SELECT $1, 'gfs_resource', resource_id::text, 7 FROM gfs_resources LIMIT 1`,
      [canonicalEnvironmentId()]
    )
    const before = await databasePool.query('SELECT * FROM authorization_resource_revisions')
    // Make the unguarded backfill deterministically exceed the real 15s bound.
    // This test-only trigger turns guard removal into 57014, independent of
    // host speed; it must never run when the count guard is present.
    await databasePool.query(`
      CREATE FUNCTION test_slow_resource_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(16);
        RETURN NULL;
      END;
      $$;
      CREATE TRIGGER test_slow_resource_backfill BEFORE INSERT ON authorization_resource_revisions
        FOR EACH STATEMENT EXECUTE FUNCTION test_slow_resource_backfill();
    `)

    const run = await migrate()
    const error = run.error as { code?: string; message?: string } | undefined
    console.info('B0 refusal', {
      code: error?.code,
      message: error?.message,
      elapsedMs: run.elapsedMs,
      triggerDdl: run.triggerDdl.length,
      locksAfterRollback: run.locksAfterRollback,
    })

    expect(error).toMatchObject({ code: 'P0001' })
    expect(error?.message).toContain('0134 gfs_resources backfill refused')
    expect(error?.message).toContain('count 100001')
    expect(error?.message).toContain('limit 100000')
    expect(run.triggerDdl).toEqual([])
    expect(run.locksBeforeBackfill).toBeUndefined()
    expect(run.locksAfterRollback).toEqual([])
    const after = await databasePool.query('SELECT * FROM authorization_resource_revisions')
    expect(after.rows).toEqual(before.rows)
    const receipts = await databasePool.query(
      'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
      [[VERSION, NEXT_VERSION]]
    )
    expect(receipts.rows).toEqual([])
    await expect(assertDbReady(databasePool)).rejects.toThrow(VERSION)
    const environment = await databasePool.query(
      "SELECT to_regclass('authorization_catalog_environment') AS relation"
    )
    expect(environment.rows).toEqual([{ relation: null }])
  })
})
