import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import {
  PR1_MIGRATION_VERSIONS,
  PR2_MIGRATION_VERSIONS,
} from '../src/migrations/migrationRunner.js'
import {
  PR1_ONLINE_INDEX_PLAN,
  PR2_ONLINE_INDEX_PLAN,
  PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS,
} from '../src/migrations/pr1OnlineIndexPlan.js'
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

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

const PR1_VERSIONS = new Set<string>(PR1_MIGRATION_VERSIONS)
const ACCESS_FOUNDATION_MARKER = 'CREATE TABLE IF NOT EXISTS external_user_sessions'
// Online indexes the removed catalog migration (0133) and the removed
// catalog rows of 0137 used to build; none of them may exist.
const REMOVED_CATALOG_INDEXES = [
  'user_workflow_triggers_recipe_user_idx',
  'team_workflow_triggers_recipe_team_idx',
  'user_workflow_triggers_catalog_key_idx',
  'team_workflow_triggers_catalog_key_idx',
  'workflow_runs_actor_catalog_idx',
  'workflow_runs_team_catalog_idx',
  'workflow_runs_usage_team_catalog_idx',
  'workflow_approval_user_catalog_idx',
  'workflow_approval_team_catalog_idx',
  'notification_user_catalog_idx',
  'notification_team_catalog_idx',
  'gfs_grants_subject_resource_catalog_idx',
  'gfs_shares_subject_resource_catalog_idx',
  'user_agents_catalog_utf8_idx',
  'team_agents_catalog_utf8_idx',
  'user_contexts_catalog_utf8_idx',
  'team_contexts_catalog_utf8_idx',
  'user_workflow_triggers_catalog_utf8_idx',
  'team_workflow_triggers_catalog_utf8_idx',
  'operational_relationship_catalog_utf8_target_idx',
] as const
const SESSION_TABLES = [
  'external_user_session_security_epochs',
  'external_user_sessions',
  'external_v1_session_revocations',
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

type ConstraintValidationSnapshot = {
  table: string
  constraint: string
  // pg_constraint.convalidated read from another session just before the
  // runner's VALIDATE CONSTRAINT runs, that is, after the schema commit.
  convalidatedBefore: boolean | null
}

type MigrationRun = {
  preExistingTables: Set<string>
  commits: CommitSnapshot[]
  // Tables committed when the last PR1 receipt commits: every table PR2 finds.
  pr2PreExistingTables: Set<string>
  // Each statement PR2 runs inside a transaction, and the locks each PR2
  // transaction holds just before it commits.
  pr2TransactionSql: string[]
  pr2Commits: RelationLock[][]
  pr2Validations: ConstraintValidationSnapshot[]
  // Runner events after PR1, in order: `validate:<constraint>` and `receipt:<version>`.
  pr2Events: string[]
}

const VALIDATE_CONSTRAINT = /^ALTER TABLE (\w+) VALIDATE CONSTRAINT (\w+)$/
const LAST_PR1_VERSION = PR1_MIGRATION_VERSIONS.at(-1)!

async function convalidated(
  observer: Pool,
  table: string,
  constraint: string
): Promise<boolean | null> {
  const result = await observer.query<{ convalidated: boolean }>(
    `SELECT con.convalidated
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = current_schema() AND rel.relname = $1 AND con.conname = $2`,
    [table, constraint]
  )
  return result.rows[0]?.convalidated ?? null
}

async function migrate(pool: Pool, observer: Pool): Promise<MigrationRun> {
  const run: MigrationRun = {
    preExistingTables: new Set(),
    commits: [],
    pr2PreExistingTables: new Set(),
    pr2TransactionSql: [],
    pr2Commits: [],
    pr2Validations: [],
    pr2Events: [],
  }
  const pendingVersions: string[] = []
  let accessFoundationSeen = false
  let pr2Started = false
  let inTransaction = false

  const connector = {
    connect: async () => {
      const client: PoolClient = await pool.connect()
      const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      return {
        release: (destroy?: boolean) => client.release(destroy),
        query: async (text: string, values?: unknown[]) => {
          if (!accessFoundationSeen && text.includes(ACCESS_FOUNDATION_MARKER)) {
            accessFoundationSeen = true
            // The 0137 transaction has not created anything yet, so the
            // committed catalog holds exactly the tables that predate PR1.
            run.preExistingTables = await committedTables(observer)
          }
          const statement = text.trim()
          if (text.includes('INSERT INTO schema_migrations')) {
            pendingVersions.push(String(values?.[0]))
            if (pr2Started) run.pr2Events.push(`receipt:${String(values?.[0])}`)
          }
          const validation = VALIDATE_CONSTRAINT.exec(statement)
          if (pr2Started && validation) {
            run.pr2Events.push(`validate:${validation[2]}`)
            run.pr2Validations.push({
              table: validation[1]!,
              constraint: validation[2]!,
              convalidatedBefore: await convalidated(observer, validation[1]!, validation[2]!),
            })
          }
          if (pr2Started && inTransaction && statement !== 'COMMIT') {
            run.pr2TransactionSql.push(statement)
          }
          if (statement === 'COMMIT') {
            const versions = pendingVersions.splice(0)
            if (versions.some(version => PR1_VERSIONS.has(version))) {
              run.commits.push({ versions, locks: await relationLocks(observer, pid) })
            }
            if (pr2Started) run.pr2Commits.push(await relationLocks(observer, pid))
            const result = await client.query(text, values)
            inTransaction = false
            if (!pr2Started && versions.includes(LAST_PR1_VERSION)) {
              pr2Started = true
              run.pr2PreExistingTables = await committedTables(observer)
            }
            return result
          }
          if (statement === 'BEGIN') inTransaction = true
          if (statement === 'ROLLBACK') inTransaction = false
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
    // Liveness: every PR1 version committed under observation and the pre-PR1
    // table set was captured.
    for (const version of PR1_MIGRATION_VERSIONS) {
      expect(
        fresh.commits.some(commit => commit.versions.includes(version)),
        version
      ).toBe(true)
    }
    expect(fresh.preExistingTables.has('users')).toBe(true)
    expect(fresh.preExistingTables.has('external_user_sessions')).toBe(false)

    expect(blockingLocks(fresh)).toEqual([])
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

  it('installs no revision, catalog, operational or invitation-delivery object', async () => {
    // Witness: the fresh database holds the PR1 session tables and every
    // planned online index, so the absence queries below ran after 0137.
    const sessionTables = await freshPool.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($1::text[])
        ORDER BY 1`,
      [[...SESSION_TABLES]]
    )
    expect(sessionTables.rows.map(row => row.name)).toEqual([...SESSION_TABLES])
    const plannedIndexes = await freshPool.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind = 'i'
          AND c.relname = ANY($1::text[])
        ORDER BY 1`,
      [PR1_ONLINE_INDEX_PLAN.map(entry => entry.name)]
    )
    expect(plannedIndexes.rows).toHaveLength(5)

    const functions = await freshPool.query<{ name: string }>(
      `SELECT p.proname AS name
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema()
          AND (p.proname LIKE 'authorization\\_%' OR p.proname = 'catalog_utf8_bytes')
        ORDER BY 1`
    )
    expect(functions.rows).toEqual([])

    const definitions = await triggerDefinitions(freshPool)
    expect(
      definitions.filter(
        definition =>
          definition.includes('_authorization_revision') || definition.includes('_catalog_revision')
      )
    ).toEqual([])

    const relations = await freshPool.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND (
            c.relname LIKE 'authorization\\_%'
            OR c.relname LIKE 'operational\\_%'
            OR c.relname = 'invitation_delivery_commands'
            OR c.relname = ANY($1::text[])
          )
        ORDER BY 1`,
      [[...REMOVED_CATALOG_INDEXES]]
    )
    expect(relations.rows).toEqual([])
  })

  it('adds the eight PR2 constraints NOT VALID on a fresh database and validates each after its schema commit', async () => {
    const planned = PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS.map(entry => ({
      table: entry.table,
      constraint: entry.constraint,
    }))
    expect(planned).toHaveLength(8)
    // Liveness: the runner validated every planned constraint once, in order,
    // after the PR1 receipts.
    expect(fresh.pr2Validations.map(({ table, constraint }) => ({ table, constraint }))).toEqual(
      planned
    )
    // Read from another session after each schema commit: not yet validated.
    expect(
      fresh.pr2Validations.map(({ constraint, convalidatedBefore }) => [
        constraint,
        convalidatedBefore,
      ])
    ).toEqual(planned.map(({ constraint }) => [constraint, false]))

    const final = await freshPool.query<{ name: string; valid: boolean }>(
      `SELECT rel.relname || '.' || con.conname AS name, con.convalidated AS valid
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE (rel.relname::text, con.conname::text) IN (
          SELECT * FROM unnest($1::text[], $2::text[])
        )
        ORDER BY 1`,
      [planned.map(entry => entry.table), planned.map(entry => entry.constraint)]
    )
    expect(final.rows).toEqual(
      [...new Set(planned.map(entry => `${entry.table}.${entry.constraint}`))]
        .sort()
        .map(name => ({ name, valid: true }))
    )

    // Each version's validations come before its receipt, and after the
    // receipt of the version before it.
    for (const [index, version] of PR2_MIGRATION_VERSIONS.entries()) {
      const receipt = fresh.pr2Events.indexOf(`receipt:${version}`)
      expect(receipt, version).toBeGreaterThanOrEqual(0)
      const previous = index > 0 ? PR2_MIGRATION_VERSIONS[index - 1] : undefined
      const after = previous ? fresh.pr2Events.indexOf(`receipt:${previous}`) : -1
      const ownValidations = PR2_POST_SCHEMA_CONSTRAINT_VALIDATIONS.filter(
        entry => entry.migrationVersion === version
      ).map(entry => `validate:${entry.constraint}`)
      expect(fresh.pr2Events.slice(after + 1, receipt), version).toEqual(ownValidations)
    }
  })

  it('builds no index on a pre-existing table inside a PR2 schema transaction', async () => {
    // Liveness: PR2's transactions were recorded, including 0139's own table
    // and the in-transaction index on it, which the pattern below must see.
    const transactionSql = fresh.pr2TransactionSql.join('\n')
    expect(transactionSql).toContain('CREATE TABLE IF NOT EXISTS workflow_authority_bindings')
    expect(fresh.pr2PreExistingTables.has('workflow_runs')).toBe(true)
    expect(fresh.pr2PreExistingTables.has('workflow_approval_requests')).toBe(true)
    expect(fresh.pr2PreExistingTables.has('gfs_upload_sessions')).toBe(true)
    expect(fresh.pr2PreExistingTables.has('workflow_authority_bindings')).toBe(false)
    const indexTargets = [
      ...transactionSql.matchAll(
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?\w+\s+ON\s+(\w+)/gi
      ),
    ].map(match => match[1]!)
    expect(indexTargets).toContain('workflow_authority_bindings')
    expect(indexTargets.filter(table => fresh.pr2PreExistingTables.has(table))).toEqual([])

    // In-transaction CREATE INDEX takes ShareLock on its table; no PR2
    // transaction holds one on a table that predates PR2.
    expect(fresh.pr2Commits.length).toBeGreaterThan(PR2_MIGRATION_VERSIONS.length)
    expect(
      fresh.pr2Commits
        .flat()
        .filter(lock => fresh.pr2PreExistingTables.has(lock.relname) && lock.mode === 'ShareLock')
    ).toEqual([])

    const indexes = await freshPool.query<{ name: string; valid: boolean | null }>(
      `SELECT index_name AS name, i.indisvalid AS valid
         FROM unnest($1::text[]) AS index_name
         LEFT JOIN pg_class c ON c.relname = index_name AND c.relkind = 'i'
         LEFT JOIN pg_index i ON i.indexrelid = c.oid
        ORDER BY 1`,
      [[...PR2_ONLINE_INDEX_PLAN.map(entry => entry.name), 'idx_wr_owner', 'idx_wr_phase']]
    )
    expect(indexes.rows).toEqual([
      { name: 'idx_wr_owner', valid: null },
      { name: 'idx_wr_owner_v2', valid: true },
      { name: 'idx_wr_phase', valid: null },
      { name: 'idx_wr_phase_v2', valid: true },
      { name: 'workflow_runs_initiating_authority_binding', valid: true },
    ])
  })
})
