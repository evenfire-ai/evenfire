import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { CONTROL_API_MIGRATIONS, type DbClient, assertDbReady, initDb } from '../src/db.js'
import {
  DEV_POST_0106_MIGRATION_VERSIONS,
  PR1_MIGRATION_VERSIONS,
  applyPendingPr1Migrations,
} from '../src/migrations/migrationRunner.js'
import {
  type OnlineIndexDefinition,
  PR1_ONLINE_INDEX_PLAN,
  ensureOnlineIndex,
} from '../src/migrations/pr1OnlineIndexPlan.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const HISTORICAL_TASK106_SOURCE_COMMIT = '2370a399d4221350946462d41427fad8aee0087f'
const HISTORICAL_TASK106_DB_SOURCE_SHA256 =
  'f2e06aba1cfa84a920eedefdb1ec56748efccbacf5baecad7caede4938364379'
const HISTORICAL_TASK106_MIGRATION_RUNNER_SOURCE_SHA256 =
  '65023efa1630261ce8d180fc2fa8789e517eb6a13ace2a6458ba95236046748f'
const OBSERVED_DEV_SOURCE_COMMIT = '0b26101eb247adcc44f70d39451f3e82c3225d47'
const OBSERVED_DEV_DB_SOURCE_SHA256 =
  '1948ad306fe56b368f120edbc70ddbac6cb9b981d9fd218e7ded2575ed3b2beb'
const OBSERVED_DEV_RECEIPT_COUNT = 133
const OBSERVED_DEV_RECEIPT_SET_SHA256 =
  'acb72ad12e1d342310832cf7628ab8351a80cee7311111039b4c2b9720077307'

const DISPLACED_TASK106_RECEIPTS = Object.freeze([
  ['0126_user_access_foundation', '0129_user_access_foundation'],
  ['0127_invitation_delivery_commands', '0130_invitation_delivery_commands'],
  ['0128_catalog_utf8_ordering', '0131_catalog_utf8_ordering'],
  ['0129_composable_catalog_revisions', '0132_composable_catalog_revisions'],
  ['012a_gfs_catalog_revision_components', '0133_gfs_catalog_revision_components'],
  [
    '012b_user_access_foundation_definer_temp_shadow_hardening',
    '0134_user_access_foundation_definer_temp_shadow_hardening',
  ],
  ['0130_legacy_password_security_epoch_backfill', '0135_legacy_password_security_epoch_backfill'],
  [
    '0138_authorization_revision_delete_compatibility',
    '0143_authorization_revision_delete_compatibility',
  ],
] as const)

const TASK106_HISTORICAL_SOURCE_DIR = process.env.TASK106_R61_B1_HISTORICAL_SOURCE_DIR
const OBSERVED_DEV_SOURCE_DIR = process.env.TASK106_R61_B1_DEV_SOURCE_DIR
if (
  process.env.CONTROL_API_REAL_PG_REQUIRED === '1' &&
  (!TASK106_HISTORICAL_SOURCE_DIR || !OBSERVED_DEV_SOURCE_DIR)
) {
  throw new Error(
    'R61-B1 real PostgreSQL lane requires both pinned historical producer source directories'
  )
}

type HistoricalRunnerPin = {
  label: string
  sourceDir: string | undefined
  commit: string
  sourceFiles: ReadonlyArray<readonly [string, string]>
}

const HISTORICAL_TASK106_RUNNER: HistoricalRunnerPin = {
  label: 'historical Task 106',
  sourceDir: TASK106_HISTORICAL_SOURCE_DIR,
  commit: HISTORICAL_TASK106_SOURCE_COMMIT,
  sourceFiles: [
    ['control-api/src/db.ts', HISTORICAL_TASK106_DB_SOURCE_SHA256],
    [
      'control-api/src/migrations/migrationRunner.ts',
      HISTORICAL_TASK106_MIGRATION_RUNNER_SOURCE_SHA256,
    ],
  ],
}

const OBSERVED_DEV_RUNNER: HistoricalRunnerPin = {
  label: 'observed DEV',
  sourceDir: OBSERVED_DEV_SOURCE_DIR,
  commit: OBSERVED_DEV_SOURCE_COMMIT,
  sourceFiles: [['control-api/src/db.ts', OBSERVED_DEV_DB_SOURCE_SHA256]],
}

let ephemeralMigrationSigningKeys:
  | {
      rpc: string
      session: string
      admin: string
    }
  | undefined

function migrationRunnerSigningKeys(): NonNullable<typeof ephemeralMigrationSigningKeys> {
  if (!ephemeralMigrationSigningKeys) {
    const privateKey = () =>
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }) as string
    ephemeralMigrationSigningKeys = {
      rpc: privateKey(),
      session: privateKey(),
      admin: privateKey(),
    }
  }
  return ephemeralMigrationSigningKeys
}

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

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyPinnedRunnerSource(pin: HistoricalRunnerPin): string {
  if (!pin.sourceDir) {
    throw new Error(`R61-B1 test did not receive ${pin.label} source directory`)
  }
  const sourceDir = resolve(pin.sourceDir)
  const revision = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  expect(revision, `${pin.label} source revision`).toBe(pin.commit)
  const status = execFileSync('git', ['-C', sourceDir, 'status', '--porcelain'], {
    encoding: 'utf8',
  }).trim()
  expect(status, `${pin.label} source checkout is clean`).toBe('')

  for (const [relativePath, expectedHash] of pin.sourceFiles) {
    expect(sha256File(join(sourceDir, relativePath)), `${pin.label} ${relativePath} SHA-256`).toBe(
      expectedHash
    )
  }

  const runnerPath = join(sourceDir, 'control-api/dist/migrate.js')
  expect(existsSync(runnerPath), `${pin.label} migration runner build`).toBe(true)
  return runnerPath
}

async function runPinnedMigrationProducer(
  pin: HistoricalRunnerPin,
  targetDatabaseUrl: string
): Promise<void> {
  const runnerPath = verifyPinnedRunnerSource(pin)
  const keys = migrationRunnerSigningKeys()
  const child = spawn(process.execPath, [runnerPath], {
    cwd: join(resolve(pin.sourceDir!), 'control-api'),
    env: {
      NODE_ENV: 'test',
      CONTROL_API_PG_CONNECTION_STRING: targetDatabaseUrl,
      CONTROL_API_RPC_JWT_PRIVATE_KEY: keys.rpc,
      CONTROL_API_SESSION_JWT_PRIVATE_KEY: keys.session,
      CONTROL_API_ADMIN_JWT_PRIVATE_KEY: keys.admin,
      TZ: 'UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output: string[] = []
  const appendOutput = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'))
    while (output.join('').length > 32_000) output.shift()
  }
  child.stdout?.on('data', appendOutput)
  child.stderr?.on('data', appendOutput)

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, 240_000)
    timeout.unref()

    child.once('error', error => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0 && !timedOut) {
        resolvePromise()
        return
      }
      const detail = output
        .join('')
        .replaceAll(targetDatabaseUrl, '<isolated test database URL>')
        .slice(-8_000)
      rejectPromise(
        new Error(
          `${pin.label} migration runner ${timedOut ? 'timed out' : `exited ${code ?? signal}`}\n${detail}`
        )
      )
    })
  })
}

function receiptSetSha256(receipts: readonly string[]): string {
  return createHash('sha256')
    .update(`${[...receipts].sort().join('\n')}\n`)
    .digest('hex')
}

async function withMigrationApplyObserver<T>(
  observe: ReadonlySet<string>,
  work: () => Promise<T>
): Promise<{ result: T; applyCounts: Map<string, number>; applyOrder: string[] }> {
  const originals = new Map<string, (db: DbClient) => Promise<void>>()
  const applyCounts = new Map<string, number>()
  const applyOrder: string[] = []
  for (const migration of CONTROL_API_MIGRATIONS) {
    if (!observe.has(migration.version)) continue
    const original = migration.apply
    originals.set(migration.version, original)
    migration.apply = async db => {
      applyCounts.set(migration.version, (applyCounts.get(migration.version) ?? 0) + 1)
      applyOrder.push(migration.version)
      await original(db)
    }
  }

  try {
    return { result: await work(), applyCounts, applyOrder }
  } finally {
    for (const migration of CONTROL_API_MIGRATIONS) {
      const original = originals.get(migration.version)
      if (original) migration.apply = original
    }
  }
}

async function currentMigrationSchemaAndPrivileges(pool: Pool): Promise<{
  objects: Record<string, string | null>
  privileges: string[]
}> {
  const objectNames = [
    'external_user_sessions',
    'external_v1_session_revocations',
    'authorization_resource_revisions',
    'invitation_delivery_commands',
  ]
  const objectRows = await pool.query<{ name: string; relation: string | null }>(
    `SELECT name, to_regclass(format('public.%I', name))::text AS relation
       FROM unnest($1::text[]) AS names(name)`,
    [objectNames]
  )
  const privilegeRows = await pool.query<{ privilege: string; allowed: boolean }>(
    `SELECT relation || ':' || privilege AS privilege,
            has_table_privilege('control_api_runtime', relation, privilege) AS allowed
       FROM (VALUES
         ('schema_migrations'::text, 'SELECT'::text),
         ('schema_migrations', 'INSERT'),
         ('schema_migrations', 'UPDATE'),
         ('schema_migrations', 'DELETE')
       ) AS required(relation, privilege)`,
    []
  )
  return {
    objects: Object.fromEntries(objectRows.rows.map(row => [row.name, row.relation])),
    privileges: privilegeRows.rows.map(row => `${row.privilege}:${row.allowed}`).sort(),
  }
}

async function passwordMigrationPrivileges(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ privilege: string; allowed: boolean }>(
    `SELECT relation || ':' || privilege AS privilege,
            has_table_privilege('control_api_runtime', relation, privilege) AS allowed
       FROM (VALUES
         ('password_identifier_state'::text, 'SELECT'::text),
         ('password_identifier_state', 'INSERT'),
         ('password_identifier_state', 'UPDATE'),
         ('password_identifier_state', 'DELETE'),
         ('password_verification_work', 'SELECT'),
         ('password_verification_work', 'INSERT'),
         ('password_verification_work', 'UPDATE'),
         ('password_verification_work', 'DELETE')
       ) AS required(relation, privilege)`,
    []
  )
  return result.rows.map(row => `${row.privilege}:${row.allowed}`).sort()
}

async function versions(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  )
  return result.rows.map(row => row.version)
}

async function removeMigrationReceiptForReplay(pool: Pool, version: string): Promise<void> {
  const versionsToRemove =
    version === '0129_user_access_foundation'
      ? [version, '0143_authorization_revision_delete_compatibility']
      : [version]
  await pool.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [
    versionsToRemove,
  ])
}

describeRealPostgres('D34 migration execution on real PostgreSQL', () => {
  const database = `control_api_d34_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool
  const isolatedDatabases: string[] = []

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        for (const isolatedDatabase of isolatedDatabases) {
          await adminPool.query(
            `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()`,
            [isolatedDatabase]
          )
          await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(isolatedDatabase)}`)
        }
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('classifies, creates, and reruns all PR1 indexes without replay', async () => {
    const firstVersions = await versions(databasePool)
    expect(PR1_ONLINE_INDEX_PLAN).toHaveLength(26)
    expect(FRESH_TABLE_INDEXES).toHaveLength(14)

    const allNames = [...PR1_ONLINE_INDEX_PLAN.map(index => index.name), ...FRESH_TABLE_INDEXES]
    expect(new Set(allNames)).toHaveLength(40)
    const indexes = await databasePool.query<{ relname: string; indisvalid: boolean }>(
      `SELECT relation.relname, index.indisvalid
         FROM pg_class relation
         JOIN pg_index index ON index.indexrelid = relation.oid
        WHERE relation.relname = ANY($1::text[])`,
      [allNames]
    )
    expect(indexes.rows).toHaveLength(40)
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
    await removeMigrationReceiptForReplay(databasePool, entry.migrationVersion)

    await initDb({ connect: () => databasePool.connect() })

    const after = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [entry.name]
    )
    expect(after.rows[0]?.oid).toBe(before.rows[0]?.oid)
    expect(await versions(databasePool)).toContain(entry.migrationVersion)
  })

  it('reuses a deparsed partial index without rebuilding its physical index', async () => {
    const entry = PR1_ONLINE_INDEX_PLAN.find(
      index => index.name === 'workflow_runs_actor_catalog_idx'
    )!
    const before = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [entry.name]
    )
    await removeMigrationReceiptForReplay(databasePool, entry.migrationVersion)

    await initDb({ connect: () => databasePool.connect() })

    const after = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [entry.name]
    )
    expect(after.rows[0]?.oid).toBe(before.rows[0]?.oid)
    expect(await versions(databasePool)).toContain(entry.migrationVersion)
  })

  it('rejects same-name indexes with changed identity, grouping, predicate, or order', async () => {
    const suffix = randomBytes(4).toString('hex')
    const table = `d34_index_semantics_${suffix}`
    await databasePool.query(`
      CREATE TABLE ${table} (
        userid text,
        "userId" text,
        id integer,
        a integer,
        b integer,
        c integer,
        included_a text,
        included_b text
      )
    `)
    const cases = [
      {
        name: `d34_quoted_identity_${suffix}`,
        expected: `(${quoteIdentifier('userId')})`,
        actual: '(userid)',
      },
      {
        name: `d34_grouping_${suffix}`,
        expected: '(((a + b) * c))',
        actual: '((a + b * c))',
      },
      {
        name: `d34_predicate_${suffix}`,
        expected: '(userid) WHERE userid IS NOT NULL',
        actual: `(userid) WHERE userid <> ''`,
      },
      {
        name: `d34_key_order_${suffix}`,
        expected: '(userid, id)',
        actual: '(id, userid)',
      },
      {
        name: `d34_include_order_${suffix}`,
        expected: '(userid) INCLUDE (included_a, included_b)',
        actual: '(userid) INCLUDE (included_b, included_a)',
      },
    ]

    for (const candidate of cases) {
      await databasePool.query(`CREATE INDEX ${candidate.name} ON ${table} ${candidate.actual}`)
      const entry: OnlineIndexDefinition = {
        migrationVersion: '0129_user_access_foundation',
        name: candidate.name,
        table,
        createSql: `CREATE INDEX CONCURRENTLY ${candidate.name} ON ${table} ${candidate.expected}`,
      }
      await expect(ensureOnlineIndex(databasePool, entry)).rejects.toThrow(
        `Non-equivalent existing index: ${candidate.name}`
      )
    }

    const uniqueName = `d34_unique_mismatch_${suffix}`
    await databasePool.query(`CREATE INDEX ${uniqueName} ON ${table} (userid)`)
    await expect(
      ensureOnlineIndex(databasePool, {
        migrationVersion: '0129_user_access_foundation',
        name: uniqueName,
        table,
        unique: true,
        createSql: `CREATE UNIQUE INDEX CONCURRENTLY ${uniqueName} ON ${table} (userid)`,
      })
    ).rejects.toThrow(`Non-equivalent existing index: ${uniqueName}`)
  })

  it('repairs an equivalent interrupted index and enforces the online bound', async () => {
    const name = `d34_interrupted_${randomBytes(4).toString('hex')}`
    const entry: OnlineIndexDefinition = {
      migrationVersion: '0129_user_access_foundation',
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
      migrationVersion: '0129_user_access_foundation',
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
    await removeMigrationReceiptForReplay(databasePool, entry.migrationVersion)

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
        WHERE version IN ('0132_composable_catalog_revisions', '0133_gfs_catalog_revision_components')`
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
    expect(failedVersions).not.toContain('0132_composable_catalog_revisions')
    expect(failedVersions).not.toContain('0133_gfs_catalog_revision_components')
    await initDb({ connect: () => databasePool.connect() })
  }, 20_000)

  it('cancels and rolls back one ordinary migration statement within 15 seconds', async () => {
    const client = await databasePool.connect()
    const appliedVersions = new Set([
      ...DEV_POST_0106_MIGRATION_VERSIONS,
      ...PR1_MIGRATION_VERSIONS.slice(0, 3),
      '0143_authorization_revision_delete_compatibility',
    ])
    const recordTable = `d34_record_${randomBytes(4).toString('hex')}`
    await client.query(`CREATE TEMP TABLE ${recordTable}(version text PRIMARY KEY)`)
    const migrations = [
      ...DEV_POST_0106_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: async () => undefined,
      })),
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: async (db: DbClient) => {
          if (version === '0132_composable_catalog_revisions') {
            await db.query('SELECT pg_sleep(20)')
          }
        },
      })),
    ]
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
      expect(appliedVersions).not.toContain('0133_gfs_catalog_revision_components')
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
    await removeMigrationReceiptForReplay(databasePool, entry.migrationVersion)
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

  it('converges every synchronized PR2 legacy identity through the canonical runner', async () => {
    const legacyIdentities: Array<{ canonical: string; aliases: readonly string[] }> = [
      {
        canonical: '0131_workflow_authority_bindings',
        aliases: ['0115_workflow_authority_bindings', '010f_workflow_authority_bindings'],
      },
      {
        canonical: '0132_gfs_upload_authority_bindings',
        aliases: ['0116_gfs_upload_authority_bindings', '0110_gfs_upload_authority_bindings'],
      },
      {
        canonical: '0133_pr2_readiness_evidence',
        aliases: [
          '0119_pr2_readiness_evidence',
          '0117_pr2_readiness_evidence',
          '0111_pr2_readiness_evidence',
        ],
      },
      {
        canonical: '0134_pr2_runtime_privileges',
        aliases: [
          '011a_pr2_runtime_privileges',
          '0118_pr2_runtime_privileges',
          '0112_pr2_runtime_privileges',
        ],
      },
      {
        canonical: '0135_workflow_recipe_authority_entity',
        aliases: [
          '011b_workflow_recipe_authority_entity',
          '0119_workflow_recipe_authority_entity',
          '0113_workflow_recipe_authority_entity',
        ],
      },
      {
        canonical: '0136_workflow_run_failure_reason',
        aliases: [
          '011c_workflow_run_failure_reason',
          '011a_workflow_run_failure_reason',
          '0114_workflow_run_failure_reason',
        ],
      },
      {
        canonical: '0115_llm_allowed_models_image_input',
        aliases: ['011b_llm_allowed_models_image_input'],
      },
    ]

    for (const { canonical, aliases } of legacyIdentities) {
      for (const legacy of aliases) {
        await databasePool.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [
          [canonical, ...aliases],
        ])
        await databasePool.query(
          `INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING`,
          [legacy]
        )

        await initDb({ connect: () => databasePool.connect() })
        const applied = await versions(databasePool)
        expect(applied).toContain(canonical)
        expect(applied).toContain(legacy)

        await initDb({ connect: () => databasePool.connect() })
        expect(await versions(databasePool)).toEqual(applied)
      }
    }
  })

  it('reconciles real historical Task 106 receipts without replaying migration bodies', async () => {
    const databaseName = `r61_historical_task106_${randomBytes(6).toString('hex')}`
    const isolatedUrl = databaseUrl(adminUrl!, databaseName)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    isolatedDatabases.push(databaseName)
    const isolatedPool = new Pool({ connectionString: isolatedUrl })
    try {
      await runPinnedMigrationProducer(HISTORICAL_TASK106_RUNNER, isolatedUrl)

      const historicalReceipts = await versions(isolatedPool)
      const historicalReceiptSet = new Set(historicalReceipts)
      for (const [historicalReceipt] of DISPLACED_TASK106_RECEIPTS) {
        expect(
          historicalReceiptSet.has(historicalReceipt),
          `${historicalReceipt} producer receipt`
        ).toBe(true)
      }
      for (const [, currentVersion] of DISPLACED_TASK106_RECEIPTS) {
        expect(
          historicalReceiptSet.has(currentVersion),
          `${currentVersion} not in old producer`
        ).toBe(false)
      }

      const schemaAndPrivilegesBefore = await currentMigrationSchemaAndPrivileges(isolatedPool)
      const observedVersions = new Set<string>([
        ...PR1_MIGRATION_VERSIONS,
        '0126_bug192_password_admission',
        '0127_password_evaluation_retention',
        '0128_password_work_ownership',
      ])
      const currentRun = await withMigrationApplyObserver(observedVersions, async () =>
        initDb({ connect: () => isolatedPool.connect() })
      )

      const receiptsAfterReconciliation = await versions(isolatedPool)
      const reconciledSet = new Set(receiptsAfterReconciliation)
      for (const [historicalReceipt, currentVersion] of DISPLACED_TASK106_RECEIPTS) {
        const migration = CONTROL_API_MIGRATIONS.find(
          candidate => candidate.version === currentVersion
        )
        expect(migration?.legacyVersions, `${historicalReceipt} alias owner`).toContain(
          historicalReceipt
        )
        expect(reconciledSet.has(historicalReceipt), `${historicalReceipt} preserved`).toBe(true)
        expect(reconciledSet.has(currentVersion), `${currentVersion} canonical receipt`).toBe(true)
        expect(
          currentRun.applyCounts.get(currentVersion) ?? 0,
          `${currentVersion} body replay`
        ).toBe(0)
      }
      for (const version of [
        '0126_bug192_password_admission',
        '0127_password_evaluation_retention',
        '0128_password_work_ownership',
      ]) {
        expect(currentRun.applyCounts.get(version), `${version} applies to old Task 106 DB`).toBe(1)
        expect(reconciledSet.has(version), `${version} receipt`).toBe(true)
      }

      await assertDbReady(isolatedPool)
      const schemaAndPrivilegesAfter = await currentMigrationSchemaAndPrivileges(isolatedPool)
      expect(schemaAndPrivilegesAfter.objects).toEqual(schemaAndPrivilegesBefore.objects)
      expect(schemaAndPrivilegesAfter.privileges).toEqual(schemaAndPrivilegesBefore.privileges)
      expect(Object.values(schemaAndPrivilegesAfter.objects).every(Boolean)).toBe(true)
      expect(await passwordMigrationPrivileges(isolatedPool)).toEqual([
        'password_identifier_state:DELETE:true',
        'password_identifier_state:INSERT:true',
        'password_identifier_state:SELECT:true',
        'password_identifier_state:UPDATE:true',
        'password_verification_work:DELETE:true',
        'password_verification_work:INSERT:true',
        'password_verification_work:SELECT:true',
        'password_verification_work:UPDATE:false',
      ])

      const afterFirstRerun = await versions(isolatedPool)
      const secondRun = await withMigrationApplyObserver(observedVersions, async () =>
        initDb({ connect: () => isolatedPool.connect() })
      )
      expect(await versions(isolatedPool)).toEqual(afterFirstRerun)
      expect([...secondRun.applyCounts.values()]).toEqual([])
      await assertDbReady(isolatedPool)
    } finally {
      await endPoolAndWaitForClients(isolatedPool)
    }
  })

  it('upgrades the exact observed DEV migration identity set with real migration producers', async () => {
    const databaseName = `r61_observed_dev_${randomBytes(6).toString('hex')}`
    const isolatedUrl = databaseUrl(adminUrl!, databaseName)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    isolatedDatabases.push(databaseName)
    const isolatedPool = new Pool({ connectionString: isolatedUrl })
    try {
      await runPinnedMigrationProducer(OBSERVED_DEV_RUNNER, isolatedUrl)

      const observedDevReceipts = await versions(isolatedPool)
      expect(observedDevReceipts).toHaveLength(OBSERVED_DEV_RECEIPT_COUNT)
      expect(receiptSetSha256(observedDevReceipts)).toBe(OBSERVED_DEV_RECEIPT_SET_SHA256)
      for (const version of [
        '0126_bug192_password_admission',
        '0127_password_evaluation_retention',
        '0128_password_work_ownership',
      ]) {
        expect(observedDevReceipts).toContain(version)
      }
      expect(
        DISPLACED_TASK106_RECEIPTS.some(([historicalReceipt]) =>
          observedDevReceipts.includes(historicalReceipt)
        )
      ).toBe(false)

      const observedDevSet = new Set(observedDevReceipts)
      const firstRun = await withMigrationApplyObserver(
        new Set<string>([
          ...PR1_MIGRATION_VERSIONS,
          '0126_bug192_password_admission',
          '0127_password_evaluation_retention',
          '0128_password_work_ownership',
        ]),
        async () => initDb({ connect: () => isolatedPool.connect() })
      )
      const upgradedReceipts = await versions(isolatedPool)
      const upgradedSet = new Set(upgradedReceipts)
      expect(upgradedReceipts).toHaveLength(
        OBSERVED_DEV_RECEIPT_COUNT + PR1_MIGRATION_VERSIONS.length
      )
      expect(upgradedReceipts.filter(version => !observedDevSet.has(version))).toEqual(
        [...PR1_MIGRATION_VERSIONS].sort()
      )
      expect(upgradedReceipts.filter(version => observedDevSet.has(version))).toEqual(
        observedDevReceipts
      )
      for (const version of PR1_MIGRATION_VERSIONS) {
        expect(firstRun.applyCounts.get(version), `${version} applies from DEV`).toBe(1)
        expect(upgradedSet.has(version), `${version} current receipt`).toBe(true)
      }
      for (const version of [
        '0126_bug192_password_admission',
        '0127_password_evaluation_retention',
        '0128_password_work_ownership',
      ]) {
        expect(firstRun.applyCounts.get(version) ?? 0, `${version} DEV body replay`).toBe(0)
      }
      const foundationIndex = firstRun.applyOrder.indexOf('0129_user_access_foundation')
      expect(firstRun.applyOrder[foundationIndex + 1]).toBe(
        '0143_authorization_revision_delete_compatibility'
      )
      await assertDbReady(isolatedPool)

      const afterUpgrade = await versions(isolatedPool)
      const secondRun = await withMigrationApplyObserver(
        new Set<string>(PR1_MIGRATION_VERSIONS),
        async () => initDb({ connect: () => isolatedPool.connect() })
      )
      expect(await versions(isolatedPool)).toEqual(afterUpgrade)
      expect([...secondRun.applyCounts.values()]).toEqual([])
      await assertDbReady(isolatedPool)
    } finally {
      await endPoolAndWaitForClients(isolatedPool)
    }
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
