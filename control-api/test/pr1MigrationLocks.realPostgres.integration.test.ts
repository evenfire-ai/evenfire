import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import { PR1_MIGRATION_VERSIONS } from '../src/migrations/migrationRunner.js'
import { PR1_ONLINE_INDEX_PLAN } from '../src/migrations/pr1OnlineIndexPlan.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

/*
 * The PR1 migration Job runs while the previous control-api, external-rest-api
 * and workflow-recipes images keep serving the same tables. A PR1 transaction
 * must therefore never hold AccessExclusiveLock (blocks readers) or ShareLock
 * (in-transaction CREATE INDEX) on a table that existed before PR1. The locks
 * are read from pg_locks just before each PR1 transaction commits, when every
 * lock it took is still held.
 */

type DbConnector = NonNullable<Parameters<typeof initDb>[0]>
type RelationLock = { relname: string; mode: string }
type CommitSnapshot = { versions: string[]; locks: RelationLock[] }
type Probe = { ok: boolean; sqlstate: string | null }

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

const PR1_VERSIONS = new Set<string>(PR1_MIGRATION_VERSIONS)
const ACCESS_FOUNDATION_MARKER = 'CREATE TABLE IF NOT EXISTS external_user_sessions'
const COMPOSABLE_CATALOG_VERSION = '0134_composable_catalog_revisions'
const ROW_REVISION_TRIGGER_TABLES = [
  'users',
  'teams',
  'workflow_runs',
  'workflow_approval_requests',
  'workflow_recipe_allowed_teams',
  'workflow_approval_medium_accounts',
  'workflow_runs_audit',
  'notification_deliveries',
  'gfs_grants',
  'gfs_shares',
  'gfs_resources',
] as const
function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function relationLocks(observer: Pool, pid: number): Promise<RelationLock[]> {
  const result = await observer.query<RelationLock>(
    `SELECT c.relname, l.mode
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = $1
        AND l.locktype = 'relation'
        AND l.granted
        AND c.relkind IN ('r', 'p')
        AND l.mode <> 'AccessShareLock'
      ORDER BY c.relname, l.mode`,
    [pid]
  )
  return result.rows
}

async function committedTables(observer: Pool): Promise<Set<string>> {
  const result = await observer.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')`
  )
  return new Set(result.rows.map(row => row.relname))
}

// Runs one statement in its own transaction with a short lock_timeout and
// reports whether it got through or waited for a lock.
async function probe(observer: Pool, sql: string): Promise<Probe> {
  const client = await observer.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '1000ms'`)
    try {
      await client.query(sql)
      return { ok: true, sqlstate: null }
    } catch (error) {
      const sqlstate = (error as { code?: string }).code ?? null
      if (sqlstate !== '55P03') throw error
      return { ok: false, sqlstate }
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function triggerDefinitions(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema()
      ORDER BY 1`
  )
  return result.rows.map(row => row.definition)
}

type MigrationRun = {
  preExistingTables: Set<string>
  commits: CommitSnapshot[]
  composableCatalogProbes: Record<string, Probe> | null
}

async function migrate(pool: Pool, observer: Pool): Promise<MigrationRun> {
  const run: MigrationRun = {
    preExistingTables: new Set(),
    commits: [],
    composableCatalogProbes: null,
  }
  const pendingVersions: string[] = []
  let accessFoundationSeen = false

  const connector = {
    connect: async () => {
      const client: PoolClient = await pool.connect()
      const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      return {
        release: (destroy?: boolean) => client.release(destroy),
        query: async (text: string, values?: unknown[]) => {
          if (!accessFoundationSeen && text.includes(ACCESS_FOUNDATION_MARKER)) {
            accessFoundationSeen = true
            // The 0131 transaction has not created anything yet, so the
            // committed catalog holds exactly the tables that predate PR1.
            run.preExistingTables = await committedTables(observer)
          }
          if (text.includes('INSERT INTO schema_migrations')) {
            pendingVersions.push(String(values?.[0]))
          }
          if (text.trim() === 'COMMIT') {
            const versions = pendingVersions.splice(0)
            if (versions.some(version => PR1_VERSIONS.has(version))) {
              if (versions.includes(COMPOSABLE_CATALOG_VERSION)) {
                run.composableCatalogProbes = {
                  readUsers: await probe(observer, 'SELECT count(*) FROM users'),
                  readWorkflowRuns: await probe(observer, 'SELECT count(*) FROM workflow_runs'),
                  writeUsers: await probe(observer, 'LOCK TABLE users IN ROW EXCLUSIVE MODE'),
                }
              }
              run.commits.push({ versions, locks: await relationLocks(observer, pid) })
            }
          }
          return client.query(text, values)
        },
      }
    },
  } as unknown as DbConnector

  await initDb(connector)
  return run
}

function blockingLocks(run: MigrationRun): (RelationLock & { versions: string })[] {
  return run.commits.flatMap(commit =>
    commit.locks
      .filter(
        lock =>
          run.preExistingTables.has(lock.relname) &&
          (lock.mode === 'AccessExclusiveLock' || lock.mode === 'ShareLock')
      )
      .map(lock => ({ ...lock, versions: commit.versions.join(',') }))
  )
}

describeRealPostgres('PR1 migration locks on real PostgreSQL', () => {
  const suffix = randomBytes(6).toString('hex')
  const freshDatabase = `control_api_pr1_locks_fresh_${suffix}`
  const baseUrl = adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres'
  let adminPool: Pool
  let freshPool: Pool
  let freshObserver: Pool
  let fresh: MigrationRun

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(freshDatabase)}`)
    freshPool = new Pool({ connectionString: databaseUrl(baseUrl, freshDatabase), max: 2 })
    freshObserver = new Pool({ connectionString: databaseUrl(baseUrl, freshDatabase), max: 3 })
    fresh = await migrate(freshPool, freshObserver)
  }, 120_000)

  afterAll(async () => {
    try {
      for (const pool of [freshPool, freshObserver]) {
        if (pool) await endPoolAndWaitForClients(pool)
      }
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [freshDatabase]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(freshDatabase)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('holds no AccessExclusive or Share lock on a pre-existing table in any PR1 transaction', () => {
    // Liveness: every PR1 version committed under observation, the pre-PR1
    // table set was captured, and the snapshots see the trigger locks 0134 takes.
    for (const version of PR1_MIGRATION_VERSIONS) {
      expect(
        fresh.commits.some(commit => commit.versions.includes(version)),
        version
      ).toBe(true)
    }
    expect(fresh.preExistingTables.has('users')).toBe(true)
    expect(fresh.preExistingTables.has('external_user_sessions')).toBe(false)
    const composable = fresh.commits.find(commit =>
      commit.versions.includes(COMPOSABLE_CATALOG_VERSION)
    )
    expect(composable?.locks).toContainEqual({ relname: 'users', mode: 'ShareRowExclusiveLock' })

    expect(blockingLocks(fresh)).toEqual([])
  })

  it('lets readers through and holds writers while 0134 is open', () => {
    expect(fresh.composableCatalogProbes).toEqual({
      readUsers: { ok: true, sqlstate: null },
      readWorkflowRuns: { ok: true, sqlstate: null },
      // Witness that the probe ran inside the open 0134 transaction.
      writeUsers: { ok: false, sqlstate: '55P03' },
    })
  })

  it('builds every planned index online and leaves it valid', async () => {
    const result = await freshPool.query<{ name: string; valid: boolean }>(
      `SELECT c.relname AS name, i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ANY($1::text[])
        ORDER BY 1`,
      [PR1_ONLINE_INDEX_PLAN.map(entry => entry.name)]
    )
    expect(result.rows).toEqual(
      PR1_ONLINE_INDEX_PLAN.map(entry => ({ name: entry.name, valid: true })).sort((left, right) =>
        left.name < right.name ? -1 : 1
      )
    )
  })

  it('installs the row revision triggers and no statement-level catalog trigger', async () => {
    const definitions = await triggerDefinitions(freshPool)
    expect(definitions.filter(definition => definition.includes('_catalog_revision '))).toEqual([])
    for (const table of ROW_REVISION_TRIGGER_TABLES) {
      expect(
        definitions.some(definition =>
          definition.startsWith(
            `CREATE TRIGGER ${table}_authorization_revision AFTER INSERT OR DELETE OR UPDATE ON public.${table} FOR EACH ROW`
          )
        ),
        table
      ).toBe(true)
    }
  })
})
