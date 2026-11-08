import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { CONTROL_API_MIGRATIONS, type DbClient, assertDbReady, initDb } from '../src/db.js'
import { migrationSessionBoundsSql } from '../src/migrations/migrationExecutionPolicy.js'
import {
  PR1_MIGRATION_VERSIONS,
  PR2_MIGRATION_VERSIONS,
  applyPendingPr1Migrations,
} from '../src/migrations/migrationRunner.js'
import {
  PR1_ONLINE_INDEX_PLAN,
  ensureOnlineIndex,
  expectedIndexDefinition,
  onlineIndex,
} from '../src/migrations/pr1OnlineIndexPlan.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const certificationInputs = JSON.parse(
  readFileSync(new URL('../../tests/contracts/certification-inputs.json', import.meta.url), 'utf8')
) as {
  producers: Record<string, { env: string; commit: string; sourceHashes: Record<string, string> }>
}
const observedProducer = certificationInputs.producers.observedDev
const latestProducer = certificationInputs.producers.latestDev
const OBSERVED_DEV_SOURCE_COMMIT = observedProducer.commit
const OBSERVED_DEV_DB_SOURCE_SHA256 = observedProducer.sourceHashes['control-api/src/db.ts']
const OBSERVED_DEV_RECEIPT_SET_SHA256 =
  'acb72ad12e1d342310832cf7628ab8351a80cee7311111039b4c2b9720077307'
const LATEST_DEV_SOURCE_COMMIT = latestProducer.commit
const LATEST_DEV_DB_SOURCE_SHA256 = latestProducer.sourceHashes['control-api/src/db.ts']
const LATEST_DEV_MIGRATION_ENTRY_SOURCE_SHA256 =
  latestProducer.sourceHashes['control-api/src/migrate.ts']
const DEV_PASSWORD_SUCCESS_ADMISSION_VERSION = '0130_password_login_success_admission'

const OBSERVED_DEV_SOURCE_DIR = process.env[observedProducer.env]
const LATEST_DEV_SOURCE_DIR = process.env[latestProducer.env]
if (
  process.env.CONTROL_API_REAL_PG_REQUIRED === '1' &&
  (!OBSERVED_DEV_SOURCE_DIR || !LATEST_DEV_SOURCE_DIR)
) {
  throw new Error(
    'R61-B1 real PostgreSQL lane requires all pinned historical/current producer source directories'
  )
}

type HistoricalRunnerPin = {
  label: string
  sourceDir: string | undefined
  commit: string
  sourceFiles: ReadonlyArray<readonly [string, string]>
}

const OBSERVED_DEV_RUNNER: HistoricalRunnerPin = {
  label: 'observed DEV',
  sourceDir: OBSERVED_DEV_SOURCE_DIR,
  commit: OBSERVED_DEV_SOURCE_COMMIT,
  sourceFiles: [['control-api/src/db.ts', OBSERVED_DEV_DB_SOURCE_SHA256]],
}

const LATEST_DEV_RUNNER: HistoricalRunnerPin = {
  label: 'latest fetched DEV',
  sourceDir: LATEST_DEV_SOURCE_DIR,
  commit: LATEST_DEV_SOURCE_COMMIT,
  sourceFiles: [
    ['control-api/src/db.ts', LATEST_DEV_DB_SOURCE_SHA256],
    ['control-api/src/migrate.ts', LATEST_DEV_MIGRATION_ENTRY_SOURCE_SHA256],
  ],
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
])

const EARLIER_HEAD_DOC_REFERENCE =
  'see docs/deploy/user-access-foundation-upgrade.md#databases-that-ran-an-earlier-head-of-this-change'

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

// The upgrade delta is derived from head, so a dev merge that brings migrations needs
// no edit here: the pinned producer describes the start, and head describes the rest.
async function upgradeFromProducerReceipts(
  pool: Pool,
  producerReceipts: readonly string[]
): Promise<{ pending: string[] }> {
  const headVersions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
  const pending = headVersions.filter(version => !producerReceipts.includes(version))
  // Witness: the derived delta ends in the versions this change owns.
  expect(pending.slice(-PR1_MIGRATION_VERSIONS.length)).toEqual([...PR1_MIGRATION_VERSIONS])
  const upgrade = await withMigrationApplyObserver(new Set(headVersions), async () =>
    initDb({ connect: () => pool.connect() })
  )
  expect(upgrade.applyOrder).toEqual(pending)
  expect(new Set(await versions(pool))).toEqual(new Set(headVersions))
  return { pending }
}

async function removeMigrationReceiptForReplay(pool: Pool, version: string): Promise<void> {
  const removed = await pool.query('DELETE FROM schema_migrations WHERE version = $1', [version])
  if (removed.rowCount !== 1) throw new Error(`${version} receipt was not recorded`)
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
    expect(PR1_ONLINE_INDEX_PLAN).toHaveLength(5)
    expect(FRESH_TABLE_INDEXES).toHaveLength(4)

    const allNames = [...PR1_ONLINE_INDEX_PLAN.map(index => index.name), ...FRESH_TABLE_INDEXES]
    expect(new Set(allNames)).toHaveLength(9)
    const indexes = await databasePool.query<{ relname: string; indisvalid: boolean }>(
      `SELECT relation.relname, index.indisvalid
         FROM pg_class relation
         JOIN pg_index index ON index.indexrelid = relation.oid
        WHERE relation.relname = ANY($1::text[])`,
      [allNames]
    )
    expect(indexes.rows).toHaveLength(9)
    expect(indexes.rows.every(row => row.indisvalid)).toBe(true)

    await initDb({ connect: () => databasePool.connect() })
    expect(await versions(databasePool)).toEqual(firstVersions)
  })

  it('builds every planned index with exactly the expected PostgreSQL definition', async () => {
    for (const entry of PR1_ONLINE_INDEX_PLAN) {
      const actual = await databasePool.query<{ definition: string }>(
        'SELECT pg_get_indexdef($1::regclass) AS definition',
        [entry.name]
      )
      expect(actual.rows, entry.name).toEqual([
        { definition: expectedIndexDefinition(entry, 'public') },
      ])
    }
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

  it('reuses every deparsed planned index without rebuilding its physical index', async () => {
    const oids = async () =>
      (
        await databasePool.query<{ index_name: string; oid: string }>(
          `SELECT index_name, index_name::regclass::oid::text AS oid
             FROM unnest($1::text[]) AS index_name
            ORDER BY index_name`,
          [PR1_ONLINE_INDEX_PLAN.map(index => index.name)]
        )
      ).rows
    const before = await oids()
    expect(before).toHaveLength(PR1_ONLINE_INDEX_PLAN.length)
    await removeMigrationReceiptForReplay(databasePool, '0137_user_access_foundation')

    await initDb({ connect: () => databasePool.connect() })

    expect(await oids()).toEqual(before)
    expect(await versions(databasePool)).toContain('0137_user_access_foundation')
  })

  it('rejects same-name indexes with changed order, predicate, expression, uniqueness or table', async () => {
    const suffix = randomBytes(4).toString('hex')
    const table = `d34_index_semantics_${suffix}`
    const otherTable = `d34_index_other_${suffix}`
    await databasePool.query(`
      CREATE TABLE ${table} (
        userid text,
        id integer,
        a integer,
        b integer,
        included_a text,
        included_b text
      )
    `)
    await databasePool.query(`CREATE TABLE ${otherTable} (userid text)`)
    const structural = (name: string, keys: string[], extra: { include?: string[] } = {}) =>
      onlineIndex({
        migrationVersion: '0137_user_access_foundation',
        name,
        table,
        keys,
        ...extra,
      })

    // Positive control: an index built exactly as planned is reused, not rebuilt.
    const exact = structural(`d34_exact_${suffix}`, ['userid', 'id'], { include: ['included_a'] })
    await databasePool.query(
      `CREATE INDEX ${exact.name} ON ${table} (userid, id) INCLUDE (included_a)`
    )
    const exactOid = await databasePool.query<{ oid: string }>(
      'SELECT $1::regclass::oid::text AS oid',
      [exact.name]
    )
    await ensureOnlineIndex(databasePool, exact)
    expect(
      (
        await databasePool.query<{ oid: string }>('SELECT $1::regclass::oid::text AS oid', [
          exact.name,
        ])
      ).rows
    ).toEqual(exactOid.rows)

    const cases = [
      {
        entry: structural(`d34_key_order_${suffix}`, ['userid', 'id']),
        actual: `ON ${table} (id, userid)`,
      },
      {
        entry: structural(`d34_include_order_${suffix}`, ['userid'], {
          include: ['included_a', 'included_b'],
        }),
        actual: `ON ${table} (userid) INCLUDE (included_b, included_a)`,
      },
      {
        entry: structural(`d34_predicate_${suffix}`, ['userid']),
        actual: `ON ${table} (userid) WHERE userid IS NOT NULL`,
      },
      {
        entry: structural(`d34_expression_${suffix}`, ['a']),
        actual: `ON ${table} ((a + b))`,
      },
      {
        entry: structural(`d34_other_table_${suffix}`, ['userid']),
        actual: `ON ${otherTable} (userid)`,
      },
    ]
    for (const candidate of cases) {
      await databasePool.query(`CREATE INDEX ${candidate.entry.name} ${candidate.actual}`)
      await expect(ensureOnlineIndex(databasePool, candidate.entry)).rejects.toThrow(
        `Non-equivalent existing index: ${candidate.entry.name}`
      )
    }

    const uniqueName = `d34_unique_mismatch_${suffix}`
    await databasePool.query(`CREATE INDEX ${uniqueName} ON ${table} (userid)`)
    await expect(
      ensureOnlineIndex(
        databasePool,
        onlineIndex({
          migrationVersion: '0137_user_access_foundation',
          name: uniqueName,
          table,
          unique: true,
          keys: ['userid'],
        })
      )
    ).rejects.toThrow(`Non-equivalent existing index: ${uniqueName}`)
  })

  it('repairs an equivalent interrupted index and enforces the online bound', async () => {
    const name = `d34_interrupted_${randomBytes(4).toString('hex')}`
    const entry = onlineIndex({
      migrationVersion: '0137_user_access_foundation',
      name,
      table: 'd34_interrupted_index',
      unique: true,
      keys: ['value'],
    })
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
    const repaired = await databasePool.query<{ indisvalid: boolean }>(
      `SELECT index.indisvalid
         FROM pg_class relation
         JOIN pg_index index ON index.indexrelid = relation.oid
        WHERE relation.relname = $1`,
      [name]
    )
    expect(repaired.rows).toEqual([{ indisvalid: true }])
  })

  it('cancels online index construction at 120 seconds and leaves classified state', async () => {
    const suffix = randomBytes(4).toString('hex')
    const table = `d34_slow_index_${suffix}`
    const entry = onlineIndex({
      migrationVersion: '0137_user_access_foundation',
      name: `d34_slow_index_${suffix}_idx`,
      table,
      keys: ['value'],
    })
    await databasePool.query(`CREATE TABLE ${table}(value integer NOT NULL)`)
    await databasePool.query(`INSERT INTO ${table}(value) VALUES (1)`)
    // An open writer keeps CREATE INDEX CONCURRENTLY waiting after it has
    // committed the invalid catalog entry. Both sessions are fresh (initDb's
    // session bounds live on databasePool's connections): the writer has no
    // idle-in-transaction timeout and the online client no lock timeout, so
    // only the 120 s statement bound can end that wait.
    const writerPool = new Pool({ connectionString, max: 1 })
    const onlinePool = new Pool({ connectionString, max: 1 })
    const writer = await writerPool.connect()
    try {
      const idleTimeout = await writer.query<{ idle_in_transaction_session_timeout: string }>(
        'SHOW idle_in_transaction_session_timeout'
      )
      expect(idleTimeout.rows).toEqual([{ idle_in_transaction_session_timeout: '0' }])
      await writer.query('BEGIN')
      await writer.query(`INSERT INTO ${table}(value) VALUES (2)`)
      const lockTimeout = await onlinePool.query<{ lock_timeout: string }>('SHOW lock_timeout')
      expect(lockTimeout.rows).toEqual([{ lock_timeout: '0' }])

      const started = Date.now()
      await expect(ensureOnlineIndex(onlinePool, entry)).rejects.toMatchObject({ code: '57014' })
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(119_000)
      expect(elapsed).toBeLessThan(130_000)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      await endPoolAndWaitForClients(onlinePool)
      await endPoolAndWaitForClients(writerPool)
    }
    const interrupted = await databasePool.query<{ indisvalid: boolean }>(
      `SELECT index.indisvalid
         FROM pg_class relation
         JOIN pg_index index ON index.indexrelid = relation.oid
        WHERE relation.relname = $1`,
      [entry.name]
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

  it('releases the migration advisory lock when its owning process is terminated mid-statement', async () => {
    // The child applies the migration session bounds exactly as initDb does,
    // takes the advisory lock and blocks in a long statement. Without the
    // connection check its backend would keep the lock until the 15 s
    // statement bound cancels the sleep.
    const childScript = `
      const { Client } = require('pg');
      (async () => {
        const client = new Client({ connectionString: process.env.D34_DATABASE_URL });
        await client.connect();
        for (const sql of JSON.parse(process.env.D34_SESSION_BOUNDS_SQL)) await client.query(sql);
        const backend = await client.query('SELECT pg_backend_pid() AS pid');
        await client.query("SELECT pg_advisory_lock(hashtext('control-api-init-db-v1')::bigint)");
        process.stdout.write('locked ' + backend.rows[0].pid + '\\n');
        await client.query('SELECT pg_sleep(60)');
      })().catch(error => {
        process.stderr.write(String(error));
        process.exit(1);
      });
    `
    const child = spawn(process.execPath, ['-e', childScript], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        D34_DATABASE_URL: connectionString,
        D34_SESSION_BOUNDS_SQL: JSON.stringify(migrationSessionBoundsSql(false)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const backendPid = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('child did not acquire advisory lock')),
        10_000
      )
      child.stdout.on('data', chunk => {
        const match = /locked (\d+)/.exec(String(chunk))
        if (!match) return
        clearTimeout(timer)
        resolve(Number(match[1]))
      })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
    const pid = await backendPid

    // Liveness witness: the child's backend is running the sleep, with the
    // connection check applied, before the process is killed.
    const sleepDeadline = Date.now() + 5_000
    let sleeping = false
    while (!sleeping) {
      const activity = await databasePool.query<{ running: boolean }>(
        `SELECT state = 'active' AND query = 'SELECT pg_sleep(60)' AS running
           FROM pg_stat_activity
          WHERE pid = $1`,
        [pid]
      )
      sleeping = activity.rows[0]?.running === true
      if (!sleeping) {
        if (Date.now() > sleepDeadline) throw new Error('child backend never started its sleep')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    child.kill('SIGKILL')
    await once(child, 'exit')

    const killedAt = Date.now()
    const lockCheck = await databasePool.connect()
    try {
      let acquired = false
      while (!acquired && Date.now() - killedAt < 5_000) {
        const attempt = await lockCheck.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext('control-api-init-db-v1')::bigint) AS acquired`
        )
        acquired = attempt.rows[0]?.acquired === true
        if (!acquired) await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(acquired).toBe(true)
      await lockCheck.query(`SELECT pg_advisory_unlock(hashtext('control-api-init-db-v1')::bigint)`)
    } finally {
      lockCheck.release()
    }
  }, 20_000)

  it('bounds ordinary DDL lock acquisition and never runs the later version', async () => {
    const locker = await databasePool.connect()
    // 0137 replays without touching users (its CREATE TABLE IF NOT EXISTS
    // skips existing tables); 0138's SELECT FROM users is the first statement
    // that waits on the lock.
    await removeMigrationReceiptForReplay(databasePool, '0137_user_access_foundation')
    await removeMigrationReceiptForReplay(
      databasePool,
      '0138_legacy_password_security_epoch_backfill'
    )
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE')
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
    expect(failedVersions).toContain('0137_user_access_foundation')
    expect(failedVersions).not.toContain('0138_legacy_password_security_epoch_backfill')
    await initDb({ connect: () => databasePool.connect() })
  }, 20_000)

  it('cancels and rolls back one ordinary migration statement within 15 seconds', async () => {
    const client = await databasePool.connect()
    const appliedVersions = new Set<string>(PR1_MIGRATION_VERSIONS.slice(0, 1))
    const recordTable = `d34_record_${randomBytes(4).toString('hex')}`
    await client.query(`CREATE TEMP TABLE ${recordTable}(version text PRIMARY KEY)`)
    const migrations = [
      ...PR1_MIGRATION_VERSIONS.map(version => ({
        version,
        apply: async (db: DbClient) => {
          if (version === '0138_legacy_password_security_epoch_backfill') {
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
      expect(appliedVersions).not.toContain('0138_legacy_password_security_epoch_backfill')
    } finally {
      client.release(true)
    }
  }, 25_000)

  async function withFreshHeadDatabase(work: (pool: Pool) => Promise<void>): Promise<void> {
    const databaseName = `r7_earlier_head_${randomBytes(6).toString('hex')}`
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    isolatedDatabases.push(databaseName)
    const isolatedPool = new Pool({ connectionString: databaseUrl(adminUrl!, databaseName) })
    try {
      await initDb({ connect: () => isolatedPool.connect() })
      await work(isolatedPool)
    } finally {
      await endPoolAndWaitForClients(isolatedPool)
    }
  }

  it('rejects a database that recorded an earlier-head migration version', async () => {
    await withFreshHeadDatabase(async pool => {
      for (const earlierVersion of [
        '0133_catalog_utf8_ordering',
        '0126_user_access_foundation',
        '010a_invitation_delivery_commands',
        '0131_user_access_foundation',
        '0132_legacy_password_security_epoch_backfill',
      ]) {
        await pool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [earlierVersion])
        const rejection = initDb({ connect: () => pool.connect() })
        await expect(rejection).rejects.toThrow(
          `recorded versions [${earlierVersion}]; functions []; tables []; ${EARLIER_HEAD_DOC_REFERENCE}`
        )
        await pool.query('DELETE FROM schema_migrations WHERE version = $1', [earlierVersion])
      }
      // Witness that the rejections came from the recorded versions alone.
      await initDb({ connect: () => pool.connect() })
    })
  })

  it('rejects earlier-head objects, and accepts the database after the cleanup SQL', async () => {
    await withFreshHeadDatabase(async pool => {
      // Witness that the baseline is a real HEAD database, not an empty table.
      const freshReceipts = await versions(pool)
      expect(freshReceipts).toEqual(
        expect.arrayContaining([
          '0137_user_access_foundation',
          '0138_legacy_password_security_epoch_backfill',
        ])
      )
      await pool.query(`
        CREATE FUNCTION authorization_bump_user_row_revision() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER users_authorization_revision
          AFTER UPDATE ON users
          FOR EACH ROW EXECUTE FUNCTION authorization_bump_user_row_revision();
        CREATE FUNCTION authorization_bump_user_revision(target_user_id uuid) RETURNS void
          LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
        CREATE TABLE authorization_catalog_writer_components(component text PRIMARY KEY);
        INSERT INTO schema_migrations(version) VALUES
          ('0131_invitation_delivery_commands'),
          ('010a_invitation_delivery_commands'),
          ('012b_user_access_foundation_definer_temp_shadow_hardening');
      `)

      const rejection = initDb({ connect: () => pool.connect() })
      for (const named of [
        'authorization_bump_user_row_revision()',
        'authorization_bump_user_revision(uuid)',
        'authorization_catalog_writer_components',
        '0131_invitation_delivery_commands',
        '010a_invitation_delivery_commands',
        '012b_user_access_foundation_definer_temp_shadow_hardening',
        EARLIER_HEAD_DOC_REFERENCE,
      ]) {
        await expect(rejection, named).rejects.toThrow(named)
      }

      // The operator's check query, exactly as the upgrade doc prints it.
      const upgradeDoc = readFileSync(
        new URL('../../docs/deploy/user-access-foundation-upgrade.md', import.meta.url),
        'utf8'
      )
      const section = upgradeDoc
        .split('\n## Databases that ran an earlier head of this change\n')[1]
        ?.split('\n## ')[0]
      const sqlBlocks = [...(section ?? '').matchAll(/```sql\n([\s\S]+?)```/g)]
      if (sqlBlocks.length !== 1) {
        throw new Error(
          `expected exactly one sql block in the upgrade doc's earlier-head section, found ${sqlBlocks.length}`
        )
      }
      const checkQuery = sqlBlocks[0]![1]!
      const found = (await pool.query<{ kind: string; name: string }>(checkQuery)).rows
        .map(row => `${row.kind}:${row.name}`)
        .sort()
      expect(found).toEqual(
        [
          'function:authorization_bump_user_revision(uuid)',
          'function:authorization_bump_user_row_revision()',
          'table:authorization_catalog_writer_components',
          'version:010a_invitation_delivery_commands',
          'version:0131_invitation_delivery_commands',
          'version:012b_user_access_foundation_definer_temp_shadow_hardening',
        ].sort()
      )

      const cleanupSql = readFileSync(
        new URL(
          '../../docs/deploy/sql/user-access-foundation-earlier-head-cleanup.sql',
          import.meta.url
        ),
        'utf8'
      )
      await pool.query(cleanupSql)

      const remaining = await pool.query<{
        row_trigger_function: string | null
        argument_function: string | null
        trigger_count: number
        writer_components: string | null
      }>(
        `SELECT to_regprocedure('authorization_bump_user_row_revision()')::text
                  AS row_trigger_function,
                to_regprocedure('authorization_bump_user_revision(uuid)')::text
                  AS argument_function,
                (SELECT count(*)::int FROM pg_trigger
                  WHERE tgname = 'users_authorization_revision') AS trigger_count,
                to_regclass('authorization_catalog_writer_components')::text
                  AS writer_components`
      )
      expect(remaining.rows).toEqual([
        {
          row_trigger_function: null,
          argument_function: null,
          trigger_count: 0,
          writer_components: null,
        },
      ])
      // Zero earlier-head receipts remain, independent of the regex under test.
      expect(await versions(pool)).toEqual(freshReceipts)
      expect((await pool.query(checkQuery)).rows).toEqual([])

      await initDb({ connect: () => pool.connect() })
      const sessionTableNames = [
        'external_user_sessions',
        'external_user_session_security_epochs',
        'external_v1_session_revocations',
      ]
      const sessionTables = await pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM unnest($1::text[]) AS table_name
          WHERE to_regclass(table_name) IS NOT NULL`,
        [sessionTableNames]
      )
      expect(sessionTables.rows.map(row => row.table_name).sort()).toEqual(
        [...sessionTableNames].sort()
      )
      const receipts = await versions(pool)
      expect(receipts).toContain('0137_user_access_foundation')
      expect(receipts).toContain('0138_legacy_password_security_epoch_backfill')
    })
  })

  it('upgrades a database from the latest DEV producer with only this change and accepts its migrator', async () => {
    const databaseName = `r61_latest_dev_${randomBytes(6).toString('hex')}`
    const isolatedUrl = databaseUrl(adminUrl!, databaseName)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    isolatedDatabases.push(databaseName)
    const isolatedPool = new Pool({ connectionString: isolatedUrl })
    try {
      await runPinnedMigrationProducer(LATEST_DEV_RUNNER, isolatedUrl)

      // A real pre-PR1 Admin UI row must remain writable after the upgrade.
      const legacyAdminRun = await isolatedPool.query<{ run_id: string }>(
        `INSERT INTO workflow_runs(recipe_namespace, recipe_name, phase, actor_type, actor_id,
           trigger_source, usage_team_id)
         VALUES ('sandbox-recipes', 'legacy-admin-revision', 'Pending', 'admin', $1,
           'onDemand', 'control-plane-admin-ui') RETURNING run_id::text`,
        [randomUUID()]
      )
      expect(legacyAdminRun.rowCount).toBe(1)

      const latestDevReceipts = await versions(isolatedPool)
      expect(
        CONTROL_API_MIGRATIONS.map(migration => migration.version).filter(
          version => !latestDevReceipts.includes(version)
        ),
        'latestDev is stale: move it in tests/contracts/certification-inputs.json to the merge base with dev'
      ).toEqual([...PR1_MIGRATION_VERSIONS])
      expect(latestDevReceipts).toContain(DEV_PASSWORD_SUCCESS_ADMISSION_VERSION)

      const { pending } = await upgradeFromProducerReceipts(isolatedPool, latestDevReceipts)
      expect(pending).toEqual([...PR1_MIGRATION_VERSIONS])
      // Each PR1 migration commits in its own bounded transaction.
      const receiptTransactions = await isolatedPool.query<{ version: string; xmin: string }>(
        'SELECT version, xmin::text AS xmin FROM schema_migrations WHERE version = ANY($1::text[])',
        [[...PR1_MIGRATION_VERSIONS]]
      )
      expect(receiptTransactions.rows).toHaveLength(PR1_MIGRATION_VERSIONS.length)
      expect(new Set(receiptTransactions.rows.map(row => row.xmin)).size).toBe(
        PR1_MIGRATION_VERSIONS.length
      )
      expect(
        (
          await isolatedPool.query(
            // The pre-PR1 Admin UI row keeps its usage-team sentinel and stays
            // writable after the upgrade.
            "UPDATE workflow_runs SET phase = 'Running', actor_id = $2 WHERE run_id = $1 RETURNING run_id",
            [legacyAdminRun.rows[0]!.run_id, randomUUID()]
          )
        ).rowCount
      ).toBe(1)
      expect(
        (
          await isolatedPool.query('DELETE FROM workflow_runs WHERE run_id = $1 RETURNING run_id', [
            legacyAdminRun.rows[0]!.run_id,
          ])
        ).rowCount
      ).toBe(1)
      await assertDbReady(isolatedPool)

      // Rollback: the DEV image's migrator runs against the upgraded database.
      const beforeRollbackRunner = await versions(isolatedPool)
      await runPinnedMigrationProducer(LATEST_DEV_RUNNER, isolatedUrl)
      expect(await versions(isolatedPool)).toEqual(beforeRollbackRunner)
      await assertDbReady(isolatedPool)

      const firstReceipts = await versions(isolatedPool)
      const replay = await withMigrationApplyObserver(
        new Set(CONTROL_API_MIGRATIONS.map(migration => migration.version)),
        async () => initDb({ connect: () => isolatedPool.connect() })
      )
      expect(await versions(isolatedPool)).toEqual(firstReceipts)
      expect([...replay.applyCounts.values()]).toEqual([])
      await assertDbReady(isolatedPool)
    } finally {
      await endPoolAndWaitForClients(isolatedPool)
    }
  })

  it('upgrades a database from the pinned pre-fence DEV producer without replay', async () => {
    const databaseName = `r61_observed_dev_${randomBytes(6).toString('hex')}`
    const isolatedUrl = databaseUrl(adminUrl!, databaseName)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    isolatedDatabases.push(databaseName)
    const isolatedPool = new Pool({ connectionString: isolatedUrl })
    try {
      await runPinnedMigrationProducer(OBSERVED_DEV_RUNNER, isolatedUrl)

      const observedDevReceipts = await versions(isolatedPool)
      expect(receiptSetSha256(observedDevReceipts)).toBe(OBSERVED_DEV_RECEIPT_SET_SHA256)
      for (const version of [
        '0126_bug192_password_admission',
        '0127_password_evaluation_retention',
        '0128_password_work_ownership',
      ]) {
        expect(observedDevReceipts).toContain(version)
      }
      // This start reaches the password-login fence, which no later DEV state can.
      expect(observedDevReceipts).not.toContain(DEV_PASSWORD_SUCCESS_ADMISSION_VERSION)

      const { pending } = await upgradeFromProducerReceipts(isolatedPool, observedDevReceipts)
      expect(pending).toContain(DEV_PASSWORD_SUCCESS_ADMISSION_VERSION)
      await assertDbReady(isolatedPool)

      const afterUpgrade = await versions(isolatedPool)
      const secondRun = await withMigrationApplyObserver(
        new Set<string>([...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS]),
        async () => initDb({ connect: () => isolatedPool.connect() })
      )
      expect(await versions(isolatedPool)).toEqual(afterUpgrade)
      expect([...secondRun.applyCounts.values()]).toEqual([])
      await assertDbReady(isolatedPool)
    } finally {
      await endPoolAndWaitForClients(isolatedPool)
    }
  })
})
