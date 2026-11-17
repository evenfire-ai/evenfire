import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type LlmProviderId } from '@clerum/llm-providers'
import { initDb, withTransaction } from '../src/db.js'
import { PR1_MIGRATION_VERSIONS } from '../src/migrations/migrationRunner.js'
import { PR1_ONLINE_INDEX_PLAN } from '../src/migrations/pr1OnlineIndexPlan.js'
import { updateAllowedModel } from '../src/services/llmAllowedModels.js'
import { type SyncConnector, syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import {
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  loadStub,
  trimLiveCatalog,
} from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

/*
 * The PR1 migration Job runs while the previous control-api, external-rest-api
 * and workflow-recipes images keep serving the same tables. A PR1 transaction
 * must therefore never hold AccessExclusiveLock (blocks readers) or ShareLock
 * (in-transaction CREATE INDEX) on a table that existed before PR1, except for
 * the closed list below. The locks are read from pg_locks just before each PR1
 * transaction commits, when every lock it took is still held.
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

/**
 * The only blocking locks a PR1 transaction may hold on a pre-existing table,
 * each valid only in a commit of that version alone. Adding a column cannot be
 * done without an AccessExclusiveLock; the migration adds all of them in one
 * catalog-only ALTER TABLE (constant defaults, CHECK NOT VALID) under a 2 s
 * lock_timeout, and does everything slower in the next version.
 */
const ALLOWED_BLOCKING_LOCKS = [
  {
    versions: '0139_llm_catalog_prune_columns',
    relname: 'llm_allowed_models',
    mode: 'AccessExclusiveLock',
    reason: 'ADD COLUMN, catalog only, lock_timeout 2s',
  },
] as const
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

type MigrationRun = {
  preExistingTables: Set<string>
  commits: CommitSnapshot[]
  /** `pg_class.relfilenode` of llm_allowed_models before PR1; a rewrite changes it. */
  allowedModelsFilenodeBefore: number | null
}

async function allowedModelsFilenode(observer: Pool): Promise<number | null> {
  const result = await observer.query<{ relfilenode: string }>(
    `SELECT c.relfilenode::text AS relfilenode
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = 'llm_allowed_models'`
  )
  return result.rows[0] ? Number(result.rows[0].relfilenode) : null
}

/**
 * Run initDb, recording the locks each PR1 commit holds. On a fresh database
 * the pre-PR1 tables are captured when 0137 starts; on one that already ran
 * part of PR1 the caller passes them (tables an earlier head of PR1 created are
 * not among them: the previous image never touches those).
 */
async function migrate(
  pool: Pool,
  observer: Pool,
  options: { preExistingTables?: Set<string> } = {}
): Promise<MigrationRun> {
  const run: MigrationRun = {
    preExistingTables: new Set(),
    commits: [],
    allowedModelsFilenodeBefore: null,
  }
  const pendingVersions: string[] = []
  let accessFoundationSeen = false
  if (options.preExistingTables) {
    accessFoundationSeen = true
    run.preExistingTables = options.preExistingTables
    run.allowedModelsFilenodeBefore = await allowedModelsFilenode(observer)
  }

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
            run.allowedModelsFilenodeBefore = await allowedModelsFilenode(observer)
          }
          if (text.includes('INSERT INTO schema_migrations')) {
            pendingVersions.push(String(values?.[0]))
          }
          if (text.trim() === 'COMMIT') {
            const versions = pendingVersions.splice(0)
            if (versions.some(version => PR1_VERSIONS.has(version))) {
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

    const isAllowed = (lock: RelationLock & { versions: string }) =>
      ALLOWED_BLOCKING_LOCKS.some(
        allowed =>
          allowed.versions === lock.versions &&
          allowed.relname === lock.relname &&
          allowed.mode === lock.mode
      )
    const observed = blockingLocks(fresh)
    // Exactly the allowed exceptions, all of them: one that stops being taken
    // is a stale exception, and one taken in a commit with other versions is
    // not covered by it.
    expect(
      observed.filter(isAllowed).map(({ versions, relname, mode }) => ({ versions, relname, mode }))
    ).toEqual(
      ALLOWED_BLOCKING_LOCKS.map(({ versions, relname, mode }) => ({ versions, relname, mode }))
    )
    expect(observed.filter(lock => !isAllowed(lock))).toEqual([])
  })

  it('adds the prune columns to llm_allowed_models without rewriting it', async () => {
    expect(fresh.allowedModelsFilenodeBefore).not.toBeNull()
    expect(await allowedModelsFilenode(freshObserver)).toBe(fresh.allowedModelsFilenodeBefore)
  })

  // An earlier head of this change applied both parts under one version. Such
  // a database records the columns migration through its legacy alias, without
  // running it, and runs the state migration over a trigger that already
  // exists: dropping it there would take an AccessExclusiveLock.
  it('upgrades a database that ran the single earlier migration without a blocking lock', async () => {
    // Rows the earlier head already classified, from the real producers: one an
    // operator enabled (its audit names `enabled`) and one the sync turned
    // stale (the trigger opened its episode). The re-run backfill must leave
    // both as they are.
    const provider = 'openai'
    const catalog = trimLiveCatalog({ [PROVIDER_KEY_MAP[provider]]: 4 })
    const ids = (mapCatalogToProviders(catalog)[provider as LlmProviderId] ?? []).map(
      m => m.model_id
    )
    const [operatorModel, staleModel] = [ids[0]!, ids[1]!]
    const runSync = (source: RawModelsDevCatalog) =>
      syncDiscoveredModels(
        {
          materializer: { materializeIfChanged: async () => 'unchanged' as const },
          loadCatalog: loadStub(source, 'live', LIVE_MODELS_DEV_CAPTURED_AT),
          minPlausibleLiveTotal: 1,
          providerMinLive: 0,
        },
        freshPool as unknown as SyncConnector
      )
    await runSync(catalog)
    const key = PROVIDER_KEY_MAP[provider]
    const without = structuredClone(catalog)
    for (const rawId of Object.keys(without[key]!.models)) {
      const [m] = mapCatalogToProviders({
        [key]: { ...without[key]!, models: { [rawId]: without[key]!.models[rawId]! } },
      })[provider as LlmProviderId]!
      if (m?.model_id === staleModel) delete without[key]!.models[rawId]
    }
    await runSync(without)
    const operatorId = (
      await freshPool.query<{ id: string }>(
        `SELECT id FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
        [provider, operatorModel]
      )
    ).rows[0]!.id
    await withTransaction(
      db => updateAllowedModel(operatorId, { enabled: true }, 'test-admin', db),
      freshPool
    )
    const classified = () =>
      freshPool.query(
        `SELECT model, enabled_managed_by, stale, stale_since::text AS stale_since,
                stale_episode, deprecated_episode
           FROM llm_allowed_models
          WHERE provider = $1 AND model = ANY($2::text[])
          ORDER BY model`,
        [provider, [operatorModel, staleModel]]
      )
    const before = (await classified()).rows
    expect(before.find(r => r.model === operatorModel)).toMatchObject({
      enabled_managed_by: 'operator',
    })
    expect(before.find(r => r.model === staleModel)).toMatchObject({
      enabled_managed_by: 'catalog',
      stale: true,
      stale_episode: 1,
    })
    expect(before.find(r => r.model === staleModel)!.stale_since).not.toBeNull()

    await freshPool.query(
      `DELETE FROM schema_migrations WHERE version = ANY($1::text[]);
       INSERT INTO schema_migrations (version) VALUES ('0139_llm_catalog_prune_state');`.replace(
        '$1::text[]',
        `ARRAY['0139_llm_catalog_prune_columns', '0140_llm_catalog_prune_episodes']`
      )
    )
    const upgrade = await migrate(freshPool, freshObserver, {
      preExistingTables: fresh.preExistingTables,
    })
    expect(upgrade.commits.map(commit => commit.versions)).toEqual([
      ['0139_llm_catalog_prune_columns'],
      ['0140_llm_catalog_prune_episodes'],
    ])
    expect(upgrade.preExistingTables.has('llm_allowed_models')).toBe(true)
    expect(blockingLocks(upgrade)).toEqual([])
    expect(await allowedModelsFilenode(freshObserver)).toBe(upgrade.allowedModelsFilenodeBefore)
    expect(await triggerDefinitions(freshPool)).toEqual(
      expect.arrayContaining([expect.stringContaining('llm_allowed_models_track_episodes')])
    )
    expect((await classified()).rows).toEqual(before)
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
})
