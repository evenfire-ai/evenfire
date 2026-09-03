import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Pool, type PoolClient } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import {
  PR1_MIGRATION_VERSIONS,
  applyPendingPr1Migrations,
} from '../src/migrations/migrationRunner.js'
import {
  type OnlineIndexDefinition,
  PR1_ONLINE_INDEX_PLAN,
  ensureOnlineIndex,
} from '../src/migrations/pr1OnlineIndexPlan.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const FRESH_TABLE_INDEXES = Object.freeze([
  'external_user_sessions_user_live_idx',
  'external_user_sessions_idle_idx',
  'external_v1_session_revocations_user_idx',
  'external_v1_session_revocations_expiry_idx',
  'authorization_resource_revisions_updated_idx',
  'operational_resource_source_idx',
  'operational_relationship_source_idx',
  'operational_relationship_target_idx',
  'operational_relationship_catalog_target_idx',
  'operational_relationship_generation_idx',
  'operational_resource_staging_identity_idx',
  'operational_relationship_staging_identity_idx',
  'invitation_delivery_commands_authorized_idx',
  'invitation_delivery_commands_invitation_idx',
])

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function versions(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  )
  return result.rows.map(row => row.version)
}

describeRealPostgres('D34 migration execution on real PostgreSQL', () => {
  const database = `control_api_d34_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.end()
    }
  })

  it('classifies, creates, and reruns all PR1 indexes without replay', async () => {
    const firstVersions = await versions(databasePool)
    expect(PR1_ONLINE_INDEX_PLAN).toHaveLength(25)
    expect(FRESH_TABLE_INDEXES).toHaveLength(14)

    const allNames = [...PR1_ONLINE_INDEX_PLAN.map(index => index.name), ...FRESH_TABLE_INDEXES]
    expect(new Set(allNames)).toHaveLength(39)
    const indexes = await databasePool.query<{ relname: string; indisvalid: boolean }>(
      `SELECT relation.relname, index.indisvalid
         FROM pg_class relation
         JOIN pg_index index ON index.indexrelid = relation.oid
        WHERE relation.relname = ANY($1::text[])`,
      [allNames]
    )
    expect(indexes.rows).toHaveLength(39)
    expect(indexes.rows.every(row => row.indisvalid)).toBe(true)

    await initDb({ connect: () => databasePool.connect() })
    expect(await versions(databasePool)).toEqual(firstVersions)
  })

  it('adopts an exact valid online index when the version row is absent', async () => {
    const entry = PR1_ONLINE_INDEX_PLAN[0]!
    const before = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [entry.name]
    )
    await databasePool.query('DELETE FROM schema_migrations WHERE version = $1', [
      entry.migrationVersion,
    ])

    await initDb({ connect: () => databasePool.connect() })

    const after = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [entry.name]
    )
    expect(after.rows[0]?.oid).toBe(before.rows[0]?.oid)
    expect(await versions(databasePool)).toContain(entry.migrationVersion)
  })

  it('repairs an equivalent interrupted index and enforces the online bound', async () => {
    const name = `d34_interrupted_${randomBytes(4).toString('hex')}`
    const entry: OnlineIndexDefinition = {
      migrationVersion: '0109_user_access_foundation',
      name,
      table: 'd34_interrupted_index',
      unique: true,
      createSql: `CREATE UNIQUE INDEX CONCURRENTLY ${name} ON d34_interrupted_index (value)`,
    }
    await databasePool.query(`CREATE TABLE d34_interrupted_index(value integer NOT NULL)`)
    await databasePool.query(`INSERT INTO d34_interrupted_index(value) VALUES (1), (1)`)
    await expect(ensureOnlineIndex(databasePool, entry)).rejects.toThrow()
    const interrupted = await databasePool.query<{ indisvalid: boolean }>(
      `SELECT index.indisvalid
         FROM pg_class relation
         JOIN pg_index index ON index.indexrelid = relation.oid
        WHERE relation.relname = $1`,
      [name]
    )
    expect(interrupted.rows).toEqual([{ indisvalid: false }])

    await databasePool.query(
      `DELETE FROM d34_interrupted_index
       WHERE ctid NOT IN (SELECT min(ctid) FROM d34_interrupted_index GROUP BY value)`
    )
    let observedStatementTimeout = ''
    const onlineClient = await databasePool.connect()
    const boundedClient: DbClient = {
      query: async (sql, values) => {
        if (sql.startsWith('CREATE UNIQUE INDEX CONCURRENTLY')) {
          const current = await onlineClient.query<{ statement_timeout: string }>(
            'SHOW statement_timeout'
          )
          observedStatementTimeout = current.rows[0]?.statement_timeout ?? ''
        }
        return onlineClient.query(sql, values)
      },
    }
    try {
      await ensureOnlineIndex(boundedClient, entry)
    } finally {
      onlineClient.release()
    }
    expect(observedStatementTimeout).toBe('2min')
  })

  it('cancels online index construction at 120 seconds and leaves classified state', async () => {
    const suffix = randomBytes(4).toString('hex')
    const table = `d34_slow_index_${suffix}`
    const functionName = `d34_slow_index_value_${suffix}`
    const name = `d34_slow_index_${suffix}_idx`
    const entry: OnlineIndexDefinition = {
      migrationVersion: '0109_user_access_foundation',
      name,
      table,
      createSql: `CREATE INDEX CONCURRENTLY ${name} ON ${table} (${functionName}(value))`,
    }
    await databasePool.query(`CREATE TABLE ${table}(value integer NOT NULL)`)
    await databasePool.query(`INSERT INTO ${table}(value) VALUES (1)`)
    await databasePool.query(`
      CREATE FUNCTION ${functionName}(input integer)
      RETURNS integer
      LANGUAGE plpgsql
      IMMUTABLE
      STRICT
      AS $$
      BEGIN
        PERFORM pg_sleep(121);
        RETURN input;
      END;
      $$
    `)

    const started = Date.now()
    await expect(ensureOnlineIndex(databasePool, entry)).rejects.toMatchObject({ code: '57014' })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(119_000)
    expect(elapsed).toBeLessThan(130_000)
    const interrupted = await databasePool.query<{ indisvalid: boolean }>(
      `SELECT index.indisvalid
         FROM pg_class relation
         JOIN pg_index index ON index.indexrelid = relation.oid
        WHERE relation.relname = $1`,
      [name]
    )
    expect(interrupted.rows).toEqual([{ indisvalid: false }])
  }, 135_000)

  it('fails closed on a same-name non-equivalent index and releases the advisory lock', async () => {
    const entry = PR1_ONLINE_INDEX_PLAN[0]!
    await databasePool.query(`DROP INDEX ${entry.name}`)
    await databasePool.query(`CREATE INDEX ${entry.name} ON team_members (team_id)`)
    await databasePool.query('DELETE FROM schema_migrations WHERE version = $1', [
      entry.migrationVersion,
    ])

    await expect(initDb({ connect: () => databasePool.connect() })).rejects.toThrow(
      `Non-equivalent existing index: ${entry.name}`
    )
    const lockCheck = await databasePool.connect()
    try {
      const acquired = await lockCheck.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('control-api-init-db-v1')::bigint) AS acquired`
      )
      expect(acquired.rows).toEqual([{ acquired: true }])
      await lockCheck.query(`SELECT pg_advisory_unlock(hashtext('control-api-init-db-v1')::bigint)`)
    } finally {
      lockCheck.release()
    }

    await databasePool.query(`DROP INDEX ${entry.name}`)
    await initDb({ connect: () => databasePool.connect() })
  })

  it('releases the migration advisory lock when its owning process is terminated', async () => {
    const childScript = `
      const { Client } = require('pg');
      (async () => {
        const client = new Client({ connectionString: process.env.D34_DATABASE_URL });
        await client.connect();
        await client.query("SELECT pg_advisory_lock(hashtext('control-api-init-db-v1')::bigint)");
        process.stdout.write('locked\\n');
        await new Promise(() => {});
      })().catch(error => {
        process.stderr.write(String(error));
        process.exit(1);
      });
    `
    const child = spawn(process.execPath, ['-e', childScript], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, D34_DATABASE_URL: connectionString },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const locked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('child did not acquire advisory lock')),
        10_000
      )
      child.stdout.on('data', chunk => {
        if (!String(chunk).includes('locked')) return
        clearTimeout(timer)
        resolve()
      })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
    await locked
    child.kill('SIGKILL')
    await once(child, 'exit')

    const lockCheck = await databasePool.connect()
    try {
      const acquired = await lockCheck.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('control-api-init-db-v1')::bigint) AS acquired`
      )
      expect(acquired.rows).toEqual([{ acquired: true }])
      await lockCheck.query(`SELECT pg_advisory_unlock(hashtext('control-api-init-db-v1')::bigint)`)
    } finally {
      lockCheck.release()
    }
  }, 15_000)

  it('bounds ordinary DDL lock acquisition and never runs the later version', async () => {
    const locker = await databasePool.connect()
    await databasePool.query(
      `DELETE FROM schema_migrations
        WHERE version IN ('010c_composable_catalog_revisions', '010d_gfs_catalog_revision_components')`
    )
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE team_members IN ACCESS EXCLUSIVE MODE')
    const started = Date.now()
    try {
      await expect(initDb({ connect: () => databasePool.connect() })).rejects.toMatchObject({
        code: '55P03',
      })
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000)
    expect(Date.now() - started).toBeLessThan(15_000)
    const failedVersions = await versions(databasePool)
    expect(failedVersions).not.toContain('010c_composable_catalog_revisions')
    expect(failedVersions).not.toContain('010d_gfs_catalog_revision_components')
    await initDb({ connect: () => databasePool.connect() })
  }, 20_000)

  it('cancels and rolls back one ordinary migration statement within 15 seconds', async () => {
    const client = await databasePool.connect()
    const appliedVersions = new Set(PR1_MIGRATION_VERSIONS.slice(0, 3))
    const recordTable = `d34_record_${randomBytes(4).toString('hex')}`
    await client.query(`CREATE TEMP TABLE ${recordTable}(version text PRIMARY KEY)`)
    const migrations = PR1_MIGRATION_VERSIONS.map(version => ({
      version,
      apply: async (db: DbClient) => {
        if (version === '010c_composable_catalog_revisions') {
          await db.query('SELECT pg_sleep(20)')
        }
      },
    }))
    const started = Date.now()
    try {
      await expect(
        applyPendingPr1Migrations({
          db: client,
          migrations,
          appliedVersions,
          recordMigration: async (db, version) => {
            await db.query(`INSERT INTO ${recordTable}(version) VALUES ($1)`, [version])
          },
        })
      ).rejects.toMatchObject({ code: '57014' })
      expect(Date.now() - started).toBeGreaterThanOrEqual(14_000)
      expect(Date.now() - started).toBeLessThan(20_000)
      const recorded = await client.query<{ version: string }>(
        `SELECT version FROM ${recordTable} ORDER BY version`
      )
      expect(recorded.rows).toEqual([])
      expect(appliedVersions).not.toContain('010d_gfs_catalog_revision_components')
    } finally {
      client.release(true)
    }
  }, 25_000)

  it('converges accepted legacy aliases without replaying historical bodies', async () => {
    const entry = PR1_ONLINE_INDEX_PLAN[0]!
    const before = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [entry.name]
    )
    await databasePool.query('DELETE FROM schema_migrations WHERE version = $1', [
      entry.migrationVersion,
    ])
    await databasePool.query(
      `INSERT INTO schema_migrations(version)
       VALUES ('0101_user_access_foundation')
       ON CONFLICT DO NOTHING`
    )

    await initDb({ connect: () => databasePool.connect() })

    const after = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [entry.name]
    )
    expect(after.rows[0]?.oid).toBe(before.rows[0]?.oid)
    expect(await versions(databasePool)).toContain(entry.migrationVersion)
  })

  it('keeps legacy team-member payloads compatible with revision triggers', async () => {
    const userId = randomUUID()
    const teamId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'D34 old writer')`,
      [userId, `d34-${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'D34 old team')`, [teamId])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    const revision = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM authorization_team_revisions
        WHERE team_id = $1`,
      [teamId]
    )
    expect(Number(revision.rows[0]?.count ?? 0)).toBeGreaterThan(0)
  })
})
