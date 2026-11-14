import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express, { type Request as ExpressRequest } from 'express'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import {
  type GfsSubject,
  auditMutation,
  writeGfsGrantBatchInTransaction,
} from '../src/routes/gfs/grants.js'
import { writeGfsShareBatchInTransaction } from '../src/routes/gfs/shares.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { getCurrentTeam, getTeamAgents, getUserAgents } from '../src/services/directory/index.js'
import { runWithAdministrativeRequestContext } from '../src/services/tracing/adminOperationContext.js'
import { PostgresAdministrativeIntentLookup } from '../src/services/tracing/adminOperationService.js'
import { AdministrativeEventService } from '../src/services/tracing/administrativeEvents.js'
import { AgentRunEventService } from '../src/services/tracing/agentRunEvents.js'
import { CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1 } from '../src/services/tracing/controlApiLocalAdministrativeBindingResolver.js'
import { appendControlApiPermissionEventsInTransaction } from '../src/services/tracing/controlApiPermissionEvents.js'
import {
  DirectRunAttributionBindingService,
  DirectRunBindingConflictError,
} from '../src/services/tracing/directRunAttributionBindingService.js'
import { MaintenanceCostRepository } from '../src/services/tracing/maintenance/maintenanceCostRepository.js'
import { runRetentionBatch } from '../src/services/tracing/maintenance/retention.js'
import { PostgresGovernedEventReadRepository } from '../src/services/tracing/postgresGovernedEventReadRepository.js'
import { PostgresGovernedSessionReplayRepository } from '../src/services/tracing/postgresGovernedSessionReplayRepository.js'
import { projectAcceptedUsageEvents } from '../src/services/tracing/usageProjection.js'
import { ingestUsageEventsInTransaction } from '../src/services/usageEvents.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

type PrivilegeExpectation = Record<string, Set<string>>

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function expectPrivileges(actual: string[], expected: string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort())
}

function deploymentRuntimeAccessQueries(): string[] {
  const script = readFileSync(
    new URL('../../deploy/scripts/run-control-api-db-migration.sh', import.meta.url),
    'utf8'
  )
  const start = script.indexOf('\nruntime_access_contract_values() {')
  const end = script.indexOf('\nverify_trace_maintenance_access_contract() {', start)
  if (start < 0 || end < 0) throw new Error('Deployment runtime access verifier is missing')

  // Execute the real profile parser and verifier to capture their SQL, without
  // entering the migration script's Kubernetes operations or copying its policy.
  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
RUNTIME_ACCESS_PROFILES_FILE="$1"
RUNTIME_SEQUENCE_ACCESS_PROFILES_FILE="$2"
die() { printf '%s\\n' "$*" >&2; exit 1; }
assert_db_query_equals() { printf '%s\\0' "$3"; }
${script.slice(start, end)}
verify_runtime_access_contract`,
      'deployment-runtime-access',
      fileURLToPath(
        new URL('../../deploy/scripts/control-api-runtime-access-profiles.tsv', import.meta.url)
      ),
      fileURLToPath(
        new URL(
          '../../deploy/scripts/control-api-runtime-sequence-access-profiles.tsv',
          import.meta.url
        )
      ),
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  const queries = output.split('\0').filter(Boolean)
  expect(queries).toHaveLength(2)
  return queries
}

function traceMaintenanceRuntimeAccessQueries(): string[] {
  const script = readFileSync(
    new URL('../../deploy/scripts/run-control-api-db-migration.sh', import.meta.url),
    'utf8'
  )
  const start = script.indexOf('\nmaintenance_access_contract_values() {')
  const end = script.indexOf('\nverify_workflow_recipes_runtime_boundary() {', start)
  if (start < 0 || end < 0) throw new Error('Trace maintenance access verifier is missing')

  // Capture SQL from the production profile parser and verifier without entering Kubernetes.
  const output = execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
MAINTENANCE_ACCESS_PROFILES_FILE="$1"
MAINTENANCE_SEQUENCE_ACCESS_PROFILES_FILE="$2"
MAINTENANCE_FUNCTION_ACCESS_PROFILES_FILE="$3"
die() { printf '%s\\n' "$*" >&2; exit 1; }
assert_db_query_equals() { printf '%s\\0' "$3"; }
${script.slice(start, end)}
verify_trace_maintenance_access_contract`,
      'trace-maintenance-runtime-access',
      fileURLToPath(
        new URL(
          '../../deploy/scripts/trace-maintenance-runtime-access-profiles.tsv',
          import.meta.url
        )
      ),
      fileURLToPath(
        new URL(
          '../../deploy/scripts/trace-maintenance-runtime-sequence-access-profiles.tsv',
          import.meta.url
        )
      ),
      fileURLToPath(
        new URL(
          '../../deploy/scripts/trace-maintenance-runtime-function-access-profiles.tsv',
          import.meta.url
        )
      ),
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  const queries = output.split('\0').filter(Boolean)
  expect(queries).toHaveLength(3)
  return queries
}

const deniedRuntimeColumnPrivileges = [
  { privilege: 'SELECT', relation: 'gfs_blob_manifests', column: 'blob_key' },
  { privilege: 'INSERT', relation: 'gfs_blob_manifests', column: 'blob_key' },
  {
    privilege: 'UPDATE',
    relation: 'password_verification_work',
    column: 'owner_instance',
  },
  {
    privilege: 'REFERENCES',
    relation: 'gfs_blob_manifests',
    column: 'blob_key',
  },
] as const

const columnPrivilegeFixtures = deniedRuntimeColumnPrivileges.flatMap(grant => [
  { ...grant, principal: 'direct' as const },
  { ...grant, principal: 'public' as const },
  { ...grant, principal: 'inherited' as const },
])

async function relationPrivileges(pool: Pool, roleName: string): Promise<PrivilegeExpectation> {
  const result = await pool.query<{
    relation_name: string
    privilege_name: string
    allowed: boolean
  }>(
    `
    SELECT relation.relname AS relation_name,
           privilege.privilege_name,
           has_table_privilege($1, relation.oid, privilege.privilege_name) AS allowed
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN (VALUES
        ('SELECT'),
        ('INSERT'),
        ('UPDATE'),
        ('DELETE'),
        ('TRUNCATE'),
        ('REFERENCES'),
        ('TRIGGER')
      ) privilege(privilege_name)
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm')
     ORDER BY relation.relname, privilege.privilege_name
  `,
    [roleName]
  )

  const actual: PrivilegeExpectation = {}
  for (const row of result.rows) {
    actual[row.relation_name] ??= new Set()
    if (row.allowed) actual[row.relation_name].add(row.privilege_name)
  }
  return actual
}

async function sequencePrivileges(pool: Pool, roleName: string): Promise<PrivilegeExpectation> {
  const result = await pool.query<{
    sequence_name: string
    privilege_name: string
    allowed: boolean
  }>(
    `
    SELECT sequence.relname AS sequence_name,
           privilege.privilege_name,
           has_sequence_privilege($1, sequence.oid, privilege.privilege_name) AS allowed
      FROM pg_class sequence
      JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
      CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) privilege(privilege_name)
     WHERE namespace.nspname = 'public'
       AND sequence.relkind = 'S'
     ORDER BY sequence.relname, privilege.privilege_name
  `,
    [roleName]
  )
  const actual: PrivilegeExpectation = {}
  for (const row of result.rows) {
    actual[row.sequence_name] ??= new Set()
    if (row.allowed) actual[row.sequence_name].add(row.privilege_name)
  }
  return actual
}

const DAY_MS = 24 * 60 * 60 * 1_000

describeRealPostgres('control-api real Postgres migrations', () => {
  const database = `control_api_migration_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let dbPool: Pool

  async function finishDisposableMigrationFixture(
    pool: Pool | undefined,
    database: string,
    databaseCreated: boolean,
    testFailure?: { error: unknown }
  ): Promise<void> {
    let cleanupFailure: { error: unknown } | undefined
    try {
      await endPoolAndWaitForClients(pool)
      if (databaseCreated) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname=$1 AND pid<>pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } catch (error) {
      cleanupFailure = { error }
    }

    if (testFailure && cleanupFailure) {
      throw new AggregateError(
        [testFailure.error, cleanupFailure.error],
        'migration fixture failed and its disposable database cleanup also failed'
      )
    }
    if (testFailure) throw testFailure.error
    if (cleanupFailure) throw cleanupFailure.error
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    // Roles are cluster-global in PostgreSQL and may own objects in the
    // shared `profiles` database.  Never drop them while preparing an
    // isolated migration database; initDb is idempotent and reconciles the
    // existing role attributes and grants in the database under test.
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    dbPool = new Pool({ connectionString })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(dbPool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('verifies the deployment access contract against migrated schema and rejects drift', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => dbPool.connect() })
    const [relationQuery, sequenceQuery] = deploymentRuntimeAccessQueries()
    const violations = async (sql: string) =>
      Number((await dbPool.query({ text: sql, rowMode: 'array' })).rows[0][0])

    expect(await violations(relationQuery)).toBe(0)
    expect(await violations(sequenceQuery)).toBe(0)
    const privileges = await relationPrivileges(dbPool, 'control_api_runtime')
    for (const relation of ['password_identifier_state', 'password_verification_pace']) {
      expectPrivileges([...privileges[relation]], ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
    }
    expectPrivileges([...privileges.password_admission_rollout_state], [])
    expectPrivileges([...privileges.password_verification_work], ['SELECT', 'INSERT', 'DELETE'])

    try {
      await dbPool.query('GRANT UPDATE ON password_verification_work TO control_api_runtime')
      expect(await violations(relationQuery)).toBe(1)
    } finally {
      await dbPool.query('REVOKE UPDATE ON password_verification_work FROM control_api_runtime')
    }
    try {
      await dbPool.query('REVOKE DELETE ON password_verification_work FROM control_api_runtime')
      expect(await violations(relationQuery)).toBe(1)
    } finally {
      await dbPool.query('GRANT DELETE ON password_verification_work TO control_api_runtime')
    }
    try {
      await dbPool.query('CREATE TABLE runtime_access_contract_probe (id INTEGER)')
      expect(await violations(relationQuery)).toBe(1)
    } finally {
      await dbPool.query('DROP TABLE IF EXISTS runtime_access_contract_probe')
    }
    expect(await violations(relationQuery)).toBe(0)
  }, 60_000)

  it('requires the owner stage and preserves history through a staged legacy admission upgrade', async () => {
    const db = await import('../src/db.js')
    const legacyDatabase = `control_api_legacy_admission_${randomBytes(6).toString('hex')}`
    let legacyPool: Pool | undefined
    let databaseCreated = false
    await db.initDb({ connect: () => dbPool.connect() })
    let testFailure: { error: unknown } | undefined
    try {
      await adminPool.query(`CREATE DATABASE ${quoteIdent(legacyDatabase)}`)
      databaseCreated = true
      legacyPool = new Pool({ connectionString: databaseUrl(adminUrl ?? '', legacyDatabase) })

      const admissionMigrationIndex = db.CONTROL_API_MIGRATIONS.findIndex(
        migration => migration.version === '0126_bug192_password_admission'
      )
      const ownerMigrationIndex = db.CONTROL_API_MIGRATIONS.findIndex(
        migration => migration.version === '0128_password_work_ownership'
      )
      const ownerMigration = db.CONTROL_API_MIGRATIONS[ownerMigrationIndex]
      const beforeAdmissionMigrations = db.CONTROL_API_MIGRATIONS.slice(0, admissionMigrationIndex)
      const beforeOwnerMigrations = db.CONTROL_API_MIGRATIONS.slice(0, ownerMigrationIndex)
      expect(admissionMigrationIndex).toBeGreaterThan(0)
      expect(ownerMigrationIndex).toBeGreaterThan(0)
      expect(ownerMigration?.version).toBe('0128_password_work_ownership')
      expect(beforeOwnerMigrations.at(-2)?.version).toBe('0126_bug192_password_admission')
      expect(beforeOwnerMigrations.at(-1)?.version).toBe('0127_password_evaluation_retention')
      if (!ownerMigration) throw new Error('durable owner migration missing')

      await legacyPool.query(
        `CREATE TABLE schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      )
      await legacyPool.query('BEGIN')
      await legacyPool.query('SET LOCAL synchronous_commit = on')
      for (const migration of beforeAdmissionMigrations) {
        await migration.apply(legacyPool)
        await legacyPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
          migration.version,
        ])
      }
      await legacyPool.query('COMMIT')

      await expect(db.initDb({ connect: () => legacyPool!.connect() })).rejects.toThrow(
        'password admission upgrade is blocked: pre-existing application schema or migration history has no identifier admission state'
      )
      const preAdmissionTables = await legacyPool.query(
        `SELECT to_regclass('public.password_identifier_state') AS identifier_state,
                to_regclass('public.password_verification_work') AS work_owner`
      )
      expect(preAdmissionTables.rows[0]).toEqual({ identifier_state: null, work_owner: null })
      const preAdmissionVersions = await legacyPool.query(
        'SELECT version FROM schema_migrations ORDER BY version'
      )
      expect(preAdmissionVersions.rows.map(row => row.version)).toEqual(
        beforeAdmissionMigrations.map(migration => migration.version)
      )

      await legacyPool.query('DELETE FROM schema_migrations')
      await expect(db.initDb({ connect: () => legacyPool!.connect() })).rejects.toThrow(
        'password admission upgrade is blocked: pre-existing application schema or migration history has no identifier admission state'
      )
      const missingReceiptState = await legacyPool.query(
        `SELECT to_regclass('public.users') AS users,
                to_regclass('public.password_identifier_state') AS identifier_state,
                count(*)::integer AS receipt_count
           FROM schema_migrations`
      )
      expect(missingReceiptState.rows[0]).toEqual({
        users: 'users',
        identifier_state: null,
        receipt_count: 0,
      })
      await legacyPool.query('BEGIN')
      await legacyPool.query('SET LOCAL synchronous_commit = on')
      for (const migration of beforeAdmissionMigrations) {
        await legacyPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
          migration.version,
        ])
      }
      await legacyPool.query('COMMIT')

      // The already-approved owner-aware release stages the legacy admission schema and owner.
      await legacyPool.query('BEGIN')
      await legacyPool.query('SET LOCAL synchronous_commit = on')
      for (const migration of beforeOwnerMigrations.slice(admissionMigrationIndex)) {
        await migration.apply(legacyPool)
        await legacyPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
          migration.version,
        ])
      }
      await legacyPool.query('COMMIT')

      const key = 'c'.repeat(64)
      const attemptAt = Date.now() - 5_000
      await legacyPool.query(
        'INSERT INTO password_identifier_state(identifier_key, attempts) VALUES ($1, $2)',
        [key, [String(attemptAt)]]
      )
      const stateBefore = await legacyPool.query(
        'SELECT attempts, failures, locked_until_ms FROM password_identifier_state WHERE identifier_key=$1',
        [key]
      )

      await expect(db.initDb({ connect: () => legacyPool!.connect() })).rejects.toThrow(
        'password admission upgrade is blocked: existing identifier state has no durable verifier owner'
      )

      const appliedVersions = await legacyPool.query(
        'SELECT version FROM schema_migrations ORDER BY version'
      )
      expect(appliedVersions.rows.map(row => row.version)).toEqual([
        ...beforeOwnerMigrations.map(migration => migration.version),
      ])
      const ownerTable = await legacyPool.query(
        "SELECT to_regclass('public.password_verification_work') AS relation"
      )
      expect(ownerTable.rows[0].relation).toBeNull()
      const stateAfter = await legacyPool.query(
        'SELECT attempts, failures, locked_until_ms FROM password_identifier_state WHERE identifier_key=$1',
        [key]
      )
      expect(stateAfter.rows).toEqual(stateBefore.rows)
      const outcomeColumns = await legacyPool.query(
        `SELECT count(*)::integer AS count FROM information_schema.columns
          WHERE table_schema='public' AND table_name='password_identifier_state'
            AND column_name IN ('successes', 'uncertain', 'provisional_operation')`
      )
      expect(outcomeColumns.rows[0].count).toBe(0)

      // The staged owner-aware release has installed 0126/0127/0128. The next current-version
      // startup can now fence, drain and apply the Spec 092 outcome schema.
      await legacyPool.query('BEGIN')
      await legacyPool.query('SET LOCAL synchronous_commit = on')
      await ownerMigration.apply(legacyPool)
      await legacyPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
        ownerMigration.version,
      ])
      await legacyPool.query('COMMIT')

      // Existing objects without the owner migration receipt are not proof that the
      // owner-aware release completed its schema transaction. Fail before fencing or
      // applying outcome-accounting migrations until the receipt is restored.
      await legacyPool.query('DELETE FROM schema_migrations WHERE version=$1', [
        ownerMigration.version,
      ])
      await expect(db.initDb({ connect: () => legacyPool!.connect() })).rejects.toThrow(
        'password admission upgrade is blocked: existing admission tables lack required migration receipts 0128_password_work_ownership'
      )
      const missingOwnerReceiptVersions = await legacyPool.query(
        'SELECT version FROM schema_migrations ORDER BY version'
      )
      expect(missingOwnerReceiptVersions.rows.map(row => row.version)).not.toContain(
        ownerMigration.version
      )
      expect(missingOwnerReceiptVersions.rows.map(row => row.version)).not.toContain(
        '0130_password_login_success_admission'
      )
      const missingOwnerReceiptState = await legacyPool.query(
        `SELECT attempts, failures, locked_until_ms
           FROM password_identifier_state WHERE identifier_key=$1`,
        [key]
      )
      expect(missingOwnerReceiptState.rows).toEqual(stateBefore.rows)
      const missingOwnerReceiptSchema = await legacyPool.query(
        `SELECT to_regclass('public.password_admission_rollout_state') AS rollout_state,
                count(*) FILTER (WHERE column_name IN ('successes', 'uncertain'))::integer AS outcome_columns
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='password_identifier_state'`
      )
      expect(missingOwnerReceiptSchema.rows[0]).toEqual({
        rollout_state: null,
        outcome_columns: 0,
      })

      await legacyPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
        ownerMigration.version,
      ])
      await expect(db.initDb({ connect: () => legacyPool!.connect() })).resolves.toBeUndefined()

      const readiness = await legacyPool.query(
        'SELECT password_admission_rollout_is_ready() AS ready'
      )
      expect(readiness.rows[0].ready).toBe(true)
      const stagedVersions = await legacyPool.query(
        `SELECT version FROM schema_migrations
          WHERE version IN ('0128_password_work_ownership', '0129_workflow_schedules_concurrency_policy',
                            '0130_password_login_success_admission')
          ORDER BY version`
      )
      expect(stagedVersions.rows.map(row => row.version)).toEqual([
        '0128_password_work_ownership',
        '0129_workflow_schedules_concurrency_policy',
        '0130_password_login_success_admission',
      ])
      const upgradedState = await legacyPool.query(
        `SELECT attempts, failures, locked_until_ms, successes, uncertain,
                legacy_hold_until_ms::text
           FROM password_identifier_state WHERE identifier_key=$1`,
        [key]
      )
      expect(upgradedState.rows[0].attempts).toEqual([String(attemptAt)])
      expect(upgradedState.rows[0].failures).toEqual([])
      expect(upgradedState.rows[0].successes).toEqual([])
      expect(upgradedState.rows[0].uncertain).toEqual([])
      expect(Number(upgradedState.rows[0].legacy_hold_until_ms)).toBeGreaterThan(Date.now())
    } catch (error) {
      testFailure = { error }
    }

    await finishDisposableMigrationFixture(legacyPool, legacyDatabase, databaseCreated, testFailure)
  }, 60_000)

  it('blocks an owner schema with a missing migration receipt before changing admission state', async () => {
    const db = await import('../src/db.js')
    const database = `control_api_missing_owner_receipt_${randomBytes(6).toString('hex')}`
    let isolatedPool: Pool | undefined
    let databaseCreated = false
    await db.initDb({ connect: () => dbPool.connect() })
    let testFailure: { error: unknown } | undefined
    try {
      await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
      databaseCreated = true
      isolatedPool = new Pool({ connectionString: databaseUrl(adminUrl ?? '', database) })

      const ownerMigrationIndex = db.CONTROL_API_MIGRATIONS.findIndex(
        migration => migration.version === '0128_password_work_ownership'
      )
      const ownerMigration = db.CONTROL_API_MIGRATIONS[ownerMigrationIndex]
      expect(ownerMigrationIndex).toBeGreaterThan(0)
      expect(ownerMigration?.version).toBe('0128_password_work_ownership')
      if (!ownerMigration) throw new Error('durable owner migration missing')

      await isolatedPool.query(
        `CREATE TABLE schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      )
      await isolatedPool.query('BEGIN')
      await isolatedPool.query('SET LOCAL synchronous_commit = on')
      for (const migration of db.CONTROL_API_MIGRATIONS.slice(0, ownerMigrationIndex + 1)) {
        await migration.apply(isolatedPool)
        await isolatedPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
          migration.version,
        ])
      }
      await isolatedPool.query('COMMIT')

      const key = 'd'.repeat(64)
      const attempts = [String(Date.now() - 3_000)]
      await isolatedPool.query(
        'INSERT INTO password_identifier_state(identifier_key, attempts) VALUES ($1, $2)',
        [key, attempts]
      )
      for (const missingReceipt of [
        '0128_password_work_ownership',
        '0127_password_evaluation_retention',
        '0126_bug192_password_admission',
      ]) {
        await isolatedPool.query('DELETE FROM schema_migrations WHERE version=$1', [missingReceipt])
        if (missingReceipt === '0126_bug192_password_admission') {
          await isolatedPool.query('DELETE FROM schema_migrations WHERE version=$1', [
            '0125_bug192_password_admission',
          ])
        }

        await expect(db.initDb({ connect: () => isolatedPool!.connect() })).rejects.toThrow(
          `password admission upgrade is blocked: existing admission tables lack required migration receipts ${missingReceipt}`
        )

        const state = await isolatedPool.query(
          'SELECT attempts, failures, locked_until_ms FROM password_identifier_state WHERE identifier_key=$1',
          [key]
        )
        expect(state.rows).toEqual([{ attempts, failures: [], locked_until_ms: '0' }])
        const rolloutAndOutcomeSchema = await isolatedPool.query(
          `SELECT to_regclass('public.password_admission_rollout_state') AS rollout_state,
                  count(*) FILTER (WHERE column_name IN ('successes', 'uncertain'))::integer AS outcome_columns
             FROM information_schema.columns
            WHERE table_schema='public' AND table_name='password_identifier_state'`
        )
        expect(rolloutAndOutcomeSchema.rows[0]).toEqual({ rollout_state: null, outcome_columns: 0 })
        const pendingReceipts = await isolatedPool.query(
          `SELECT version FROM schema_migrations
            WHERE version = '0130_password_login_success_admission'
            ORDER BY version`
        )
        expect(pendingReceipts.rows).toEqual([])

        await isolatedPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
          missingReceipt,
        ])
      }

      await isolatedPool.query('DELETE FROM schema_migrations WHERE version=$1', [
        '0126_bug192_password_admission',
      ])
      await isolatedPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
        '0125_bug192_password_admission',
      ])
      await expect(db.initDb({ connect: () => isolatedPool!.connect() })).resolves.toBeUndefined()
      const readiness = await isolatedPool.query(
        'SELECT password_admission_rollout_is_ready() AS ready'
      )
      expect(readiness.rows[0].ready).toBe(true)
      const canonicalizedLegacyReceipt = await isolatedPool.query(
        `SELECT version FROM schema_migrations
          WHERE version IN ('0125_bug192_password_admission', '0126_bug192_password_admission')
          ORDER BY version`
      )
      expect(canonicalizedLegacyReceipt.rows.map(row => row.version)).toEqual([
        '0125_bug192_password_admission',
        '0126_bug192_password_admission',
      ])
    } catch (error) {
      testFailure = { error }
    }

    await finishDisposableMigrationFixture(isolatedPool, database, databaseCreated, testFailure)
  }, 60_000)

  it('fences and drains legacy verifiers before migration, then fails closed on rollback', async () => {
    const db = await import('../src/db.js')
    const admissionSchema = await import('../src/services/auth/passwordAdmissionSchema.js')
    const workOwnershipSchema = await import('../src/services/auth/passwordWorkOwnershipSchema.js')
    const migrationVersion = '0130_password_login_success_admission'
    const key = 'b'.repeat(64)
    const attemptAt = Date.now() - 1_000
    const heldOperation = randomUUID()
    const heldOwner = randomUUID()
    const heldHost = 'legacy-verifier-test'
    const heldPid = process.pid
    let legacyCompletionClient: PoolClient | null = null
    let legacyCompletionFenceLowerBoundMs: number | null = null
    let migrationSettled = false
    let migrationError: unknown
    let migrationPromise: Promise<void> | undefined
    let fence: { phase: string; fenced_at_ms: string } | undefined
    let legacyOwnerReleased = false
    const releaseLegacyOwner = async () => {
      const releaseClient = await dbPool.connect()
      try {
        await releaseClient.query('SET ROLE control_api_runtime')
        await releaseClient.query(
          'DELETE FROM password_verification_work WHERE singleton AND operation_id=$1 AND owner_instance=$2',
          [heldOperation, heldOwner]
        )
        await releaseClient.query('RESET ROLE')
      } finally {
        releaseClient.release()
      }
      legacyOwnerReleased = true
    }
    const expectLegacyWriteRejected = async (sql: string, values: unknown[] = []) => {
      const runtime = await dbPool.connect()
      try {
        await runtime.query('SET ROLE control_api_runtime')
        await expect(runtime.query(sql, values)).rejects.toMatchObject({
          code: '55000',
        })
        await runtime.query('RESET ROLE')
      } finally {
        runtime.release()
      }
    }

    // Reconstruct the supported 0128 owner-aware pre-0130 schema in this throwaway
    // database after the ordinary migration test has initialized all migrations.
    await dbPool.query(`
      DROP TRIGGER IF EXISTS password_admission_protocol_fence ON password_identifier_state;
      DROP TRIGGER IF EXISTS password_admission_rollout_state_guard ON password_identifier_state;
      DROP TRIGGER IF EXISTS password_admission_rollout_owner_guard ON password_verification_work;
      DROP FUNCTION IF EXISTS password_admission_protocol_fence();
      DROP FUNCTION IF EXISTS password_admission_rollout_state_guard();
      DROP FUNCTION IF EXISTS password_admission_rollout_owner_guard();
      DROP FUNCTION IF EXISTS password_admission_rollout_is_ready();
      DROP FUNCTION IF EXISTS password_reconcile_running_admission(
        text, uuid, bigint, uuid, bigint, uuid, text, integer, text
      );
      ALTER TABLE password_identifier_state
        DROP COLUMN IF EXISTS successes,
        DROP COLUMN IF EXISTS uncertain,
        DROP COLUMN IF EXISTS legacy_hold_until_ms,
        DROP COLUMN IF EXISTS provisional_operation,
        DROP COLUMN IF EXISTS provisional_phase,
        DROP COLUMN IF EXISTS provisional_scope,
        DROP COLUMN IF EXISTS provisional_epoch,
        DROP COLUMN IF EXISTS provisional_expires_at_ms,
        DROP COLUMN IF EXISTS provisional_quota_masked,
        DROP COLUMN IF EXISTS provisional_started_at_ms,
        DROP COLUMN IF EXISTS provisional_owner_instance,
        DROP COLUMN IF EXISTS provisional_owner_host,
        DROP COLUMN IF EXISTS provisional_owner_pid,
        DROP COLUMN IF EXISTS provisional_user_id,
        DROP COLUMN IF EXISTS provisional_generation,
        DROP COLUMN IF EXISTS terminal_operation,
        DROP COLUMN IF EXISTS terminal_disposition,
        DROP COLUMN IF EXISTS terminal_at_ms,
        DROP COLUMN IF EXISTS terminal_epoch;
      DROP TABLE IF EXISTS password_admission_rollout_state;
      DELETE FROM schema_migrations WHERE version = '${migrationVersion}';
    `)
    await admissionSchema.applyPasswordAdmissionSchema(dbPool)
    await admissionSchema.applyPasswordEvaluationRetentionSchema(dbPool)
    await workOwnershipSchema.applyPasswordWorkOwnershipSchema(dbPool)
    await dbPool.query(
      `INSERT INTO password_identifier_state(identifier_key, attempts)
       VALUES ($1, ARRAY[$2::bigint])`,
      [key, String(attemptAt)]
    )

    const legacyClient = await dbPool.connect()
    try {
      await legacyClient.query('SET ROLE control_api_runtime')
      await legacyClient.query('BEGIN')
      await legacyClient.query(
        `INSERT INTO password_verification_work
          (singleton, operation_id, owner_instance, owner_host, owner_pid)
         VALUES (TRUE, $1, $2, $3, $4)`,
        [heldOperation, heldOwner, heldHost, heldPid]
      )
      await legacyClient.query('COMMIT')
      await legacyClient.query('RESET ROLE')
    } finally {
      legacyClient.release()
    }

    // Model a legacy completion transaction that released its durable work owner but still
    // holds the identifier row while writing its outcome. Trigger installation must wait for
    // this transaction, then timestamp the fence after it commits.
    try {
      legacyCompletionClient = await dbPool.connect()
      await legacyCompletionClient.query('SET ROLE control_api_runtime')
      await legacyCompletionClient.query('BEGIN')
      await legacyCompletionClient.query(
        'UPDATE password_identifier_state SET revision = revision + 1 WHERE identifier_key = $1',
        [key]
      )
      const legacyCompletionBackendPid = Number(
        (await legacyCompletionClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      )

      migrationPromise = db
        .initDb({ connect: () => dbPool.connect() })
        .then(() => {
          migrationSettled = true
        })
        .catch(error => {
          migrationError = error
          migrationSettled = true
        })

      let guardInstallWaiting = false
      const guardDeadline = Date.now() + 10_000
      while (Date.now() < guardDeadline) {
        const waiting = await dbPool.query(
          `SELECT EXISTS (
             SELECT 1
               FROM pg_stat_activity AS activity
               JOIN pg_locks AS waiting_lock
                 ON waiting_lock.pid = activity.pid
                AND waiting_lock.granted = FALSE
                AND waiting_lock.relation = 'public.password_identifier_state'::regclass
              WHERE activity.datname = current_database()
                AND activity.pid <> pg_backend_pid()
                AND activity.wait_event_type = 'Lock'
                AND activity.query LIKE '%password_admission_rollout_state%'
                AND $1 = ANY(pg_blocking_pids(activity.pid))
           ) AS waiting`,
          [legacyCompletionBackendPid]
        )
        if (waiting.rows[0].waiting) {
          guardInstallWaiting = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(guardInstallWaiting).toBe(true)
      expect(migrationSettled).toBe(false)
      legacyCompletionFenceLowerBoundMs = Number(
        (
          await dbPool.query(
            'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now'
          )
        ).rows[0].now
      )
      expect(Number.isFinite(legacyCompletionFenceLowerBoundMs)).toBe(true)
      await legacyCompletionClient.query('COMMIT')
      await legacyCompletionClient.query('RESET ROLE')
      legacyCompletionClient.release()
      legacyCompletionClient = null

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (migrationSettled) {
          throw new Error(`migration stopped before drain fence: ${String(migrationError)}`)
        }
        const rolloutTable = await dbPool.query(
          "SELECT to_regclass('public.password_admission_rollout_state') AS relation"
        )
        if (!rolloutTable.rows[0].relation) {
          await new Promise(resolve => setTimeout(resolve, 20))
          continue
        }
        const result = await dbPool.query(
          `SELECT phase, fenced_at_ms::text FROM password_admission_rollout_state WHERE singleton`
        )
        fence = result.rows[0] as typeof fence
        if (fence?.phase === 'draining') break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(fence?.phase).toBe('draining')
      expect(migrationSettled).toBe(false)
      await dbPool.query(`
        CREATE OR REPLACE FUNCTION reject_password_admission_upgrade() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced password admission migration failure';
        END $$;
        CREATE TRIGGER z_reject_password_admission_upgrade
          BEFORE UPDATE ON password_identifier_state
          FOR EACH ROW EXECUTE FUNCTION reject_password_admission_upgrade();
      `)
      expect(
        Number(
          (
            await dbPool.query(
              `SELECT count(*)::integer AS count FROM information_schema.columns
              WHERE table_schema='public' AND table_name='password_identifier_state'
                AND column_name='successes'`
            )
          ).rows[0].count
        )
      ).toBe(0)
      expect(
        Number(
          (
            await dbPool.query(
              `SELECT count(*)::integer AS count FROM schema_migrations WHERE version=$1`,
              [migrationVersion]
            )
          ).rows[0].count
        )
      ).toBe(0)

      await expectLegacyWriteRejected(
        `INSERT INTO password_verification_work
        (singleton, operation_id, owner_instance, owner_host, owner_pid)
       VALUES (TRUE, $1, $2, $3, $4)`,
        [randomUUID(), randomUUID(), heldHost, heldPid]
      )
      await expectLegacyWriteRejected(
        'UPDATE password_identifier_state SET attempts = attempts || ARRAY[123::bigint] WHERE identifier_key=$1',
        [key]
      )

      const ownerBeforeRelease = await dbPool.query(
        'SELECT operation_id FROM password_verification_work WHERE singleton'
      )
      expect(ownerBeforeRelease.rows[0]).toEqual({
        operation_id: heldOperation,
      })
      await releaseLegacyOwner()

      await migrationPromise
    } finally {
      if (legacyCompletionClient) {
        let cleanupFailed = false
        try {
          await legacyCompletionClient.query('ROLLBACK')
        } catch {
          cleanupFailed = true
          // Preserve the original failure while releasing the lock held for this fixture.
        }
        try {
          await legacyCompletionClient.query('RESET ROLE')
        } catch {
          cleanupFailed = true
          // Do not return a session with an unknown role state to the shared test pool.
        }
        legacyCompletionClient.release(
          cleanupFailed ? new Error('legacy completion fixture cleanup failed') : undefined
        )
        legacyCompletionClient = null
      }
      if (!legacyOwnerReleased) await releaseLegacyOwner()
      await migrationPromise
    }
    expect(migrationSettled).toBe(true)
    expect(String(migrationError)).toContain('forced password admission migration failure')
    expect(Number(fence?.fenced_at_ms)).toBeGreaterThanOrEqual(
      legacyCompletionFenceLowerBoundMs ?? 0
    )
    await expectLegacyWriteRejected(
      'UPDATE password_identifier_state SET revision = revision + 1 WHERE identifier_key=$1',
      [key]
    )
    const stateAfterFailedUpgrade = await dbPool.query(
      'SELECT attempts FROM password_identifier_state WHERE identifier_key=$1',
      [key]
    )
    expect(stateAfterFailedUpgrade.rows[0].attempts).toEqual([String(attemptAt)])
    const retainedFence = await dbPool.query(
      `SELECT phase, fenced_at_ms::text FROM password_admission_rollout_state WHERE singleton`
    )
    expect(retainedFence.rows[0].phase).toBe('draining')
    expect(Number(retainedFence.rows[0].fenced_at_ms)).toBeGreaterThanOrEqual(
      Number(fence?.fenced_at_ms)
    )

    await dbPool.query(
      `DROP TRIGGER z_reject_password_admission_upgrade ON password_identifier_state`
    )
    await dbPool.query(`DROP FUNCTION reject_password_admission_upgrade()`)
    await db.initDb({ connect: () => dbPool.connect() })

    const rolloutReady = await dbPool.query('SELECT password_admission_rollout_is_ready() AS ready')
    expect(rolloutReady.rows[0].ready).toBe(true)
    const upgradedState = await dbPool.query(
      `SELECT attempts, legacy_hold_until_ms::text, failures, successes, uncertain
         FROM password_identifier_state WHERE identifier_key=$1`,
      [key]
    )
    expect(upgradedState.rows[0].attempts).toEqual([String(attemptAt)])
    expect(Number(upgradedState.rows[0].legacy_hold_until_ms)).toBeGreaterThanOrEqual(
      Number(fence?.fenced_at_ms) + 900_000
    )

    const operation = randomUUID()
    const ownerInstance = randomUUID()
    const now = Number(
      (
        await dbPool.query(
          `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now`
        )
      ).rows[0].now
    )
    const v2Client = await dbPool.connect()
    try {
      await v2Client.query('BEGIN')
      await v2Client.query('SET LOCAL synchronous_commit = on')
      await v2Client.query("SET LOCAL app.password_admission_protocol = 'v2'")
      await v2Client.query(
        `UPDATE password_identifier_state
            SET failures=ARRAY[$2::bigint], successes=ARRAY[$3::bigint], uncertain=ARRAY[$4::bigint],
                locked_until_ms=$5, provisional_operation=$6, provisional_phase='running',
                provisional_scope='public_login', provisional_epoch=revision,
                provisional_expires_at_ms=$7, provisional_quota_masked=FALSE,
                provisional_started_at_ms=$8, provisional_owner_instance=$9,
                provisional_owner_host=$10, provisional_owner_pid=$11
          WHERE identifier_key=$1`,
        [
          key,
          now - 3,
          now - 2,
          now - 1,
          now + 900_000,
          operation,
          now + 60_000,
          now,
          ownerInstance,
          heldHost,
          heldPid,
        ]
      )
      await v2Client.query(
        `INSERT INTO password_verification_work
          (singleton, operation_id, owner_instance, owner_host, owner_pid)
         VALUES (TRUE, $1, $2, $3, $4)`,
        [operation, ownerInstance, heldHost, heldPid]
      )
      await v2Client.query('COMMIT')
    } finally {
      v2Client.release()
    }

    await expectLegacyWriteRejected(
      `UPDATE password_identifier_state SET failures='{}', locked_until_ms=0
        WHERE identifier_key=$1`,
      [key]
    )
    await expectLegacyWriteRejected(
      'DELETE FROM password_verification_work WHERE singleton AND operation_id=$1',
      [operation]
    )
    const stateAfterLegacyRollbackAttempt = await dbPool.query(
      `SELECT failures, successes, uncertain, locked_until_ms::text,
              provisional_operation, provisional_phase
         FROM password_identifier_state WHERE identifier_key=$1`,
      [key]
    )
    expect(stateAfterLegacyRollbackAttempt.rows[0]).toMatchObject({
      failures: [String(now - 3)],
      successes: [String(now - 2)],
      uncertain: [String(now - 1)],
      locked_until_ms: String(now + 900_000),
      provisional_operation: operation,
      provisional_phase: 'running',
    })
    expect(
      Number(
        (
          await dbPool.query(
            'SELECT count(*)::integer AS count FROM password_verification_work WHERE singleton AND operation_id=$1',
            [operation]
          )
        ).rows[0].count
      )
    ).toBe(1)
  }, 60_000)

  it.each(columnPrivilegeFixtures)(
    'rejects $principal column-level $privilege on $relation',
    async ({ privilege, relation, column, principal }) => {
      const { initDb } = await import('../src/db.js')
      await initDb({ connect: () => dbPool.connect() })
      const [relationQuery] = deploymentRuntimeAccessQueries()
      const relationName = quoteIdent(relation)
      const columnName = quoteIdent(column)
      const inheritedRole = `runtime_column_acl_probe_${randomBytes(6).toString('hex')}`
      const grantee = principal === 'public' ? 'PUBLIC' : quoteIdent('control_api_runtime')
      const inherited = principal === 'inherited'
      const assertClean = async () => {
        const result = await dbPool.query<{
          table_access: boolean
          column_access: boolean
        }>(
          `SELECT has_table_privilege('control_api_runtime', $1, $2) AS table_access,
                  has_any_column_privilege('control_api_runtime', $1, $2) AS column_access`,
          [relation, privilege]
        )
        expect(result.rows[0]).toEqual({
          table_access: false,
          column_access: true,
        })
        const violationCount = Number(
          (await dbPool.query({ text: relationQuery, rowMode: 'array' })).rows[0][0]
        )
        expect(violationCount).toBe(1)
      }

      try {
        if (inherited) {
          await dbPool.query(`CREATE ROLE ${quoteIdent(inheritedRole)} NOLOGIN INHERIT`)
        }
        const grantTarget = inherited ? quoteIdent(inheritedRole) : grantee
        await dbPool.query(
          `GRANT ${privilege} (${columnName}) ON TABLE ${relationName} TO ${grantTarget}`
        )
        if (inherited) {
          await dbPool.query(`GRANT ${quoteIdent(inheritedRole)} TO control_api_runtime`)
        }

        await assertClean()
      } finally {
        if (inherited) {
          await dbPool.query(`REVOKE ${quoteIdent(inheritedRole)} FROM control_api_runtime`)
          await dbPool.query(
            `REVOKE ${privilege} (${columnName}) ON TABLE ${relationName} FROM ${quoteIdent(inheritedRole)}`
          )
          await dbPool.query(`DROP ROLE IF EXISTS ${quoteIdent(inheritedRole)}`)
        } else {
          await dbPool.query(
            `REVOKE ${privilege} (${columnName}) ON TABLE ${relationName} FROM ${grantee}`
          )
        }
      }
    }
  )

  it.each(['direct', 'public', 'inherited'] as const)(
    'rejects %s column-level UPDATE on governed_event_stream for trace maintenance',
    async principal => {
      const { initDb } = await import('../src/db.js')
      await initDb({ connect: () => dbPool.connect() })
      const [relationQuery, sequenceQuery, functionQuery] = traceMaintenanceRuntimeAccessQueries()
      const relation = 'governed_event_stream'
      const column = 'event_id'
      const relationName = quoteIdent(relation)
      const columnName = quoteIdent(column)
      const inheritedRole = `trace_maintenance_acl_probe_${randomBytes(6).toString('hex')}`
      const grantee = principal === 'public' ? 'PUBLIC' : quoteIdent('trace_maintenance_runtime')
      const inherited = principal === 'inherited'
      const violationCount = async (query: string) =>
        Number((await dbPool.query({ text: query, rowMode: 'array' })).rows[0][0])

      expect(await violationCount(relationQuery)).toBe(0)
      expect(await violationCount(sequenceQuery)).toBe(0)
      expect(await violationCount(functionQuery)).toBe(0)

      try {
        if (inherited) {
          await dbPool.query(`CREATE ROLE ${quoteIdent(inheritedRole)} NOLOGIN INHERIT`)
        }
        const grantTarget = inherited ? quoteIdent(inheritedRole) : grantee
        await dbPool.query(
          `GRANT UPDATE (${columnName}) ON TABLE ${relationName} TO ${grantTarget}`
        )
        if (inherited) {
          await dbPool.query(`GRANT ${quoteIdent(inheritedRole)} TO trace_maintenance_runtime`)
        }

        const privileges = await dbPool.query<{
          table_access: boolean
          column_access: boolean
        }>(
          `SELECT has_table_privilege('trace_maintenance_runtime', $1, 'UPDATE') AS table_access,
                  has_any_column_privilege('trace_maintenance_runtime', $1, 'UPDATE') AS column_access`,
          [relation]
        )
        expect(privileges.rows[0]).toEqual({
          table_access: false,
          column_access: true,
        })
        expect(await violationCount(relationQuery)).toBe(1)
        expect(await violationCount(sequenceQuery)).toBe(0)
        expect(await violationCount(functionQuery)).toBe(0)
      } finally {
        if (inherited) {
          await dbPool.query(`REVOKE ${quoteIdent(inheritedRole)} FROM trace_maintenance_runtime`)
          await dbPool.query(
            `REVOKE UPDATE (${columnName}) ON TABLE ${relationName} FROM ${quoteIdent(inheritedRole)}`
          )
          await dbPool.query(`DROP ROLE IF EXISTS ${quoteIdent(inheritedRole)}`)
        } else {
          await dbPool.query(
            `REVOKE UPDATE (${columnName}) ON TABLE ${relationName} FROM ${grantee}`
          )
        }
      }
    }
  )

  it('applies initDb twice and leaves the exact runtime privilege envelopes', async () => {
    const { initDb } = await import('../src/db.js')
    const connector = { connect: () => dbPool.connect() }

    await initDb(connector)
    const firstVersions = await dbPool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    )

    await initDb(connector)
    const secondVersions = await dbPool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    )

    expect(secondVersions.rows.map(row => row.version)).toEqual(
      firstVersions.rows.map(row => row.version)
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0063_workflow_approval_trace_binding'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0064_agent_decision_source_catalog'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0065_governed_session_replay_and_prompt_history'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0054_workflow_run_completed_notification_download_detection'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0066_governed_trace_target_principal_projection'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0067_llm_runtime_access_profiles'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0094_desktop_user_retirement_lifecycle'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0095_gfs_lifecycle_authority_projection'
    )
    expect(secondVersions.rows.map(row => row.version)).toContain(
      '0096_control_admin_session_version_default'
    )

    const sessionVersionContract = await dbPool.query<{
      column_default: string | null
      is_nullable: string
      constraint_validated: boolean
    }>(
      `SELECT column_default,
              is_nullable,
              EXISTS (
                SELECT 1
                  FROM pg_constraint
                 WHERE conrelid = 'control_admin_users'::regclass
                   AND conname = 'control_admin_session_version_positive'
                   AND convalidated
              ) AS constraint_validated
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'control_admin_users'
          AND column_name = 'session_version'`
    )
    expect(sessionVersionContract.rows).toEqual([
      {
        column_default: '1',
        is_nullable: 'NO',
        constraint_validated: true,
      },
    ])

    const contractAdminId = randomUUID()
    await dbPool.query(
      `INSERT INTO control_admin_users (id, username, password_hash)
       VALUES ($1, $2, 'migration-test-hash')`,
      [contractAdminId, `migration-contract-${contractAdminId}`]
    )
    const defaultEpoch = await dbPool.query<{ session_version: number }>(
      `SELECT session_version FROM control_admin_users WHERE id = $1`,
      [contractAdminId]
    )
    expect(defaultEpoch.rows).toEqual([{ session_version: 1 }])
    await expect(
      dbPool.query(
        `INSERT INTO control_admin_users (id, username, password_hash, session_version)
         VALUES ($1, $2, 'migration-test-hash', 0)`,
        [randomUUID(), `migration-invalid-${randomUUID()}`]
      )
    ).rejects.toThrow(/session_version|control_admin_session_version_positive/)
    await dbPool.query(`DELETE FROM control_admin_users WHERE id = $1`, [contractAdminId])

    await dbPool.query(`
      DELETE FROM schema_migrations
       WHERE version = '0066_governed_trace_target_principal_projection';
      CREATE OR REPLACE FUNCTION governed_trace_safe_metadata(value JSONB)
      RETURNS BOOLEAN
      LANGUAGE sql
      IMMUTABLE
      AS $$
        SELECT jsonb_typeof(value) = 'object'
           AND NOT (value ? 'target_principal_kind')
           AND NOT (value ? 'target_principal_ref');
      $$;
    `)
    await initDb(connector)
    const upgradedTargetPrincipal = await dbPool.query<{ accepted: boolean }>(
      `SELECT governed_trace_safe_metadata(
         '{"target_principal_kind":"host","target_principal_ref":"host:1st:mcp-host/chatllm"}'::jsonb
       ) AS accepted`
    )
    expect(upgradedTargetPrincipal.rows).toEqual([{ accepted: true }])
    const restoredMigration = await dbPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM schema_migrations
        WHERE version = '0066_governed_trace_target_principal_projection'`
    )
    expect(restoredMigration.rows).toEqual([{ count: '1' }])

    const currentGovernedVersions = [
      '0061_governed_run_trace_schema_foundation',
      '0062_governed_trace_runtime_roles',
      '0063_workflow_approval_trace_binding',
      '0064_agent_decision_source_catalog',
      '0065_governed_session_replay_and_prompt_history',
      '0066_governed_trace_target_principal_projection',
      '0067_llm_runtime_access_profiles',
    ]
    const legacyGovernedVersions = [
      '0054_governed_run_trace_schema_foundation',
      '0055_governed_trace_runtime_roles',
      '0056_workflow_approval_trace_binding',
      '0057_agent_decision_source_catalog',
      '0058_governed_session_replay_and_prompt_history',
      '0059_workflow_run_completed_notification_download_detection',
      '0060_governed_trace_target_principal_projection',
    ]
    await dbPool.query(`DELETE FROM schema_migrations WHERE version = ANY($1::text[])`, [
      currentGovernedVersions,
    ])
    await dbPool.query(
      `INSERT INTO schema_migrations(version)
       SELECT unnest($1::text[])
       ON CONFLICT (version) DO NOTHING`,
      [legacyGovernedVersions]
    )

    await initDb(connector)
    const upgradedLegacyVersions = await dbPool.query<{ version: string }>(
      `SELECT version
         FROM schema_migrations
        WHERE version = ANY($1::text[])
        ORDER BY version`,
      [currentGovernedVersions]
    )
    expect(upgradedLegacyVersions.rows.map(row => row.version)).toEqual(currentGovernedVersions)

    const requiredTables = await dbPool.query<{ table_name: string }>(
      `
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name
    `,
      [
        [
          'agent_run_events',
          'administrative_events',
          'governed_event_stream',
          'governed_run_attribution_bindings',
          'governed_approval_prompt_history',
          'infrastructure_cost_daily',
          'infrastructure_cost_daily_components',
          'infrastructure_price_snapshots',
          'infrastructure_telemetry_events',
          'llm_allowed_models',
          'llm_allowed_models_audit',
          'llm_catalog_sync_runs',
          'llm_provider_attempt_tickets',
          'llm_provider_attempts',
          'codex_subscription_connections',
          'codex_subscription_oauth_states',
          'notification_deliveries',
          'workflow_approval_requests',
          'workflow_run_steps',
          'workflow_runs',
          'workflow_schedules',
        ],
      ]
    )
    expect(requiredTables.rows.map(row => row.table_name)).toEqual([
      'administrative_events',
      'agent_run_events',
      'codex_subscription_connections',
      'codex_subscription_oauth_states',
      'governed_approval_prompt_history',
      'governed_event_stream',
      'governed_run_attribution_bindings',
      'infrastructure_cost_daily',
      'infrastructure_cost_daily_components',
      'infrastructure_price_snapshots',
      'infrastructure_telemetry_events',
      'llm_allowed_models',
      'llm_allowed_models_audit',
      'llm_catalog_sync_runs',
      'llm_provider_attempt_tickets',
      'llm_provider_attempts',
      'notification_deliveries',
      'workflow_approval_requests',
      'workflow_run_steps',
      'workflow_runs',
      'workflow_schedules',
    ])

    const functionAndTriggerState = await dbPool.query<{
      notify_security_definer: boolean
      notify_search_path: string[] | null
      wrc_can_execute_notify: boolean
      workflow_runs_notify: boolean
      notification_deliveries_notify: boolean
    }>(`
      SELECT
        (SELECT prosecdef
           FROM pg_proc
          WHERE oid = 'public.notify_workflow_run_update()'::regprocedure)
          AS notify_security_definer,
        (SELECT proconfig
           FROM pg_proc
          WHERE oid = 'public.notify_workflow_run_update()'::regprocedure)
          AS notify_search_path,
        has_function_privilege(
          'workflow_recipes_runtime',
          'public.notify_workflow_run_update()',
          'EXECUTE'
        ) AS wrc_can_execute_notify,
        EXISTS (
          SELECT 1
            FROM pg_trigger
           WHERE tgname = 'workflow_runs_notify'
             AND tgrelid = 'public.workflow_runs'::regclass
             AND NOT tgisinternal
        ) AS workflow_runs_notify,
        EXISTS (
          SELECT 1
            FROM pg_trigger
           WHERE tgname = 'notification_deliveries_notify'
             AND tgrelid = 'public.notification_deliveries'::regclass
             AND NOT tgisinternal
        ) AS notification_deliveries_notify
    `)
    expect(functionAndTriggerState.rows[0]).toMatchObject({
      notify_security_definer: true,
      notify_search_path: ['search_path=pg_catalog'],
      wrc_can_execute_notify: false,
      workflow_runs_notify: true,
      notification_deliveries_notify: true,
    })

    const roles = await dbPool.query<{
      rolname: string
      rolsuper: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
      rolreplication: boolean
      rolbypassrls: boolean
    }>(
      `
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = ANY($1::text[])
       ORDER BY rolname
    `,
      [['control_api_runtime', 'trace_maintenance_runtime', 'workflow_recipes_runtime']]
    )
    expect(roles.rows).toHaveLength(3)
    for (const role of roles.rows) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      })
    }

    const exactControlApiRelations = [
      'administrative_events',
      'agent_run_events',
      'governed_event_read_v1',
      'governed_event_stream',
      'governed_approval_prompt_history',
      'governed_run_attribution_bindings',
      'infrastructure_cost_daily',
      'infrastructure_cost_daily_components',
      'infrastructure_price_snapshots',
      'infrastructure_telemetry_events',
      'llm_allowed_models',
      'llm_allowed_models_audit',
      'llm_catalog_sync_runs',
      'llm_provider_attempt_tickets',
      'llm_provider_attempts',
      'codex_subscription_connections',
      'codex_subscription_oauth_states',
      'gfs_desktop_operator_links',
      'desktop_user_retirement_operations',
      'dynamic_clients',
    ] as const
    const controlApiRelations = await relationPrivileges(dbPool, 'control_api_runtime')
    const expectedControlApiRelations: Record<string, string[]> = {
      administrative_events: ['INSERT', 'SELECT'],
      agent_run_events: ['INSERT', 'SELECT'],
      governed_event_read_v1: ['SELECT'],
      governed_event_stream: ['INSERT', 'SELECT'],
      governed_approval_prompt_history: ['INSERT', 'SELECT'],
      governed_run_attribution_bindings: ['INSERT', 'SELECT'],
      infrastructure_cost_daily: ['SELECT'],
      infrastructure_cost_daily_components: ['SELECT'],
      infrastructure_price_snapshots: ['SELECT'],
      infrastructure_telemetry_events: ['INSERT', 'SELECT'],
      llm_allowed_models: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      llm_allowed_models_audit: ['INSERT', 'SELECT'],
      llm_catalog_sync_runs: ['INSERT', 'SELECT'],
      llm_provider_attempt_tickets: ['INSERT', 'SELECT', 'UPDATE'],
      llm_provider_attempts: ['INSERT', 'SELECT', 'UPDATE'],
      codex_subscription_connections: ['INSERT', 'SELECT', 'UPDATE'],
      codex_subscription_oauth_states: ['INSERT', 'SELECT', 'UPDATE'],
      gfs_desktop_operator_links: ['INSERT', 'SELECT', 'UPDATE'],
      desktop_user_retirement_operations: ['INSERT', 'SELECT', 'UPDATE'],
      // dynamicClientStore does INSERT ... ON CONFLICT DO UPDATE, SELECT and
      // DELETE, so the runtime role needs the full legacy_dml envelope.
      dynamic_clients: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
    }
    for (const relation of exactControlApiRelations) {
      expectPrivileges(
        [...(controlApiRelations[relation] ?? new Set())],
        expectedControlApiRelations[relation] ?? []
      )
    }
    expectPrivileges([...(controlApiRelations.gfs_blob_manifests ?? new Set())], [])
    expectPrivileges([...(controlApiRelations.gfs_upload_parts ?? new Set())], [])
    expectPrivileges([...(controlApiRelations.gfs_upload_sessions ?? new Set())], [])

    // The identity sequence must carry the legacy_rw (USAGE/SELECT/UPDATE)
    // envelope; without it BIGSERIAL default fails on INSERT under the role.
    const controlApiSequences = await sequencePrivileges(dbPool, 'control_api_runtime')
    expectPrivileges(
      [...(controlApiSequences.dynamic_clients_id_seq ?? new Set())],
      ['SELECT', 'UPDATE', 'USAGE']
    )

    const linkUserId = randomUUID()
    const linkAdminId = randomUUID()
    const linkRuntimeClient = await dbPool.connect()
    try {
      await linkRuntimeClient.query('BEGIN')
      await linkRuntimeClient.query(
        `INSERT INTO users (id, email, name)
         VALUES ($1, $2, 'GFS desktop operator privilege test')`,
        [linkUserId, `gfs-link-${linkUserId}@example.test`]
      )
      await linkRuntimeClient.query(
        `INSERT INTO control_admin_users (
           id, username, password_hash, role, status
         ) VALUES ($1, $2, 'gfs-link-test-hash', 'admin', 'active')`,
        [linkAdminId, `gfs-link-${linkAdminId}`]
      )

      const privilegeState = await linkRuntimeClient.query<{
        privilege_name: string
        allowed: boolean
      }>(
        `SELECT privilege.privilege_name,
                has_table_privilege(
                  'control_api_runtime',
                  'public.gfs_desktop_operator_links',
                  privilege.privilege_name
                ) AS allowed
           FROM (VALUES
             ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
             ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
           ) privilege(privilege_name)
          ORDER BY privilege.privilege_name`
      )
      expect(privilegeState.rows).toEqual([
        { privilege_name: 'DELETE', allowed: false },
        { privilege_name: 'INSERT', allowed: true },
        { privilege_name: 'REFERENCES', allowed: false },
        { privilege_name: 'SELECT', allowed: true },
        { privilege_name: 'TRIGGER', allowed: false },
        { privilege_name: 'TRUNCATE', allowed: false },
        { privilege_name: 'UPDATE', allowed: true },
      ])

      await linkRuntimeClient.query('SET LOCAL ROLE control_api_runtime')
      await linkRuntimeClient.query(
        `INSERT INTO gfs_desktop_operator_links
           (id, lineage_id, generation, user_id, control_admin_id, state, source, created_by, row_version)
         VALUES (gen_random_uuid(), gen_random_uuid(), 1, $1, $2, 'active', 'initial_setup', $2, 1)`,
        [linkUserId, linkAdminId]
      )
      const linked = await linkRuntimeClient.query<{
        user_id: string
        control_admin_id: string
      }>(
        `SELECT user_id::text, control_admin_id::text
           FROM gfs_desktop_operator_links
          WHERE user_id = $1`,
        [linkUserId]
      )
      expect(linked.rows).toEqual([{ user_id: linkUserId, control_admin_id: linkAdminId }])

      const lifecycle = await linkRuntimeClient.query<{
        lifecycle_state: string
        lifecycle_version: string
      }>(
        `SELECT lifecycle_state, lifecycle_version::text AS lifecycle_version
           FROM users
          WHERE id = $1`,
        [linkUserId]
      )
      expect(lifecycle.rows).toEqual([{ lifecycle_state: 'active', lifecycle_version: '1' }])

      await linkRuntimeClient.query(
        `UPDATE gfs_desktop_operator_links
            SET state = 'revoked', revoked_at = NOW(), revoked_by_type = 'control_admin',
                revoked_by_id = $2, revoked_by_control_admin_id = $2,
                revoked_by_desktop_user_id = NULL,
                revocation_reason = 'privilege-test', row_version = row_version + 1
          WHERE user_id = $1`,
        [linkUserId, linkAdminId]
      )

      const operation = await linkRuntimeClient.query<{ id: string }>(
        `INSERT INTO desktop_user_retirement_operations(
           actor_type,
           actor_control_admin_id,
           target_user_id,
           idempotency_key_hash,
           request_fingerprint,
           reason,
           request_id
         )
         VALUES ('control_admin', $1, $2, repeat('a', 64), repeat('b', 64), 'privilege-test', 'request-1')
         RETURNING id::text AS id`,
        [linkAdminId, linkUserId]
      )
      await linkRuntimeClient.query(
        `UPDATE desktop_user_retirement_operations
            SET status = 'completed',
                outcome = 'retired',
                lifecycle_version = 2,
                lifecycle_operation_id = id,
                completed_at = NOW()
          WHERE id = $1::uuid`,
        [operation.rows[0]!.id]
      )

      await linkRuntimeClient.query('SAVEPOINT deny_link_truncate')
      await expect(
        linkRuntimeClient.query('TRUNCATE TABLE gfs_desktop_operator_links')
      ).rejects.toThrow(/permission denied/)
      await linkRuntimeClient.query('ROLLBACK TO SAVEPOINT deny_link_truncate')

      await linkRuntimeClient.query('SAVEPOINT deny_link_delete')
      await expect(
        linkRuntimeClient.query(`DELETE FROM gfs_desktop_operator_links WHERE user_id = $1`, [
          linkUserId,
        ])
      ).rejects.toThrow(/permission denied/)
      await linkRuntimeClient.query('ROLLBACK TO SAVEPOINT deny_link_delete')
    } finally {
      await linkRuntimeClient.query('ROLLBACK')
      linkRuntimeClient.release()
    }

    const maintenanceRelations = await relationPrivileges(dbPool, 'trace_maintenance_runtime')
    const expectedMaintenanceRelations: Record<string, string[]> = {
      administrative_events: ['SELECT'],
      agent_run_events: ['SELECT'],
      governed_event_read_v1: ['SELECT'],
      governed_event_stream: ['INSERT', 'SELECT'],
      infrastructure_cost_daily: ['INSERT', 'SELECT'],
      infrastructure_cost_daily_components: ['INSERT', 'SELECT'],
      infrastructure_price_snapshots: ['INSERT', 'SELECT'],
      infrastructure_telemetry_events: ['INSERT', 'SELECT'],
    }
    for (const [relation, actual] of Object.entries(maintenanceRelations)) {
      expectPrivileges([...actual], expectedMaintenanceRelations[relation] ?? [])
    }

    const maintenanceSequences = await sequencePrivileges(dbPool, 'trace_maintenance_runtime')
    const expectedMaintenanceSequences: Record<string, string[]> = {
      governed_event_stream_stream_sequence_seq: ['SELECT', 'USAGE'],
      infrastructure_telemetry_events_ingest_sequence_seq: ['SELECT', 'USAGE'],
    }
    for (const [sequence, actual] of Object.entries(maintenanceSequences)) {
      expectPrivileges([...actual], expectedMaintenanceSequences[sequence] ?? [])
    }

    const directRunId = randomUUID()
    const bindAsRuntime = new DirectRunAttributionBindingService(async work => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE control_api_runtime')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    })
    const directBinding = {
      runId: directRunId,
      hostRef: 'sandbox-recipes/runtime-boundary-test',
      hostNamespace: null,
      sessionId: 'session-real-pg',
      origin: 'direct_chat' as const,
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: 'subject-real-pg',
      userId: null,
      teamId: null,
    }
    await expect(bindAsRuntime.bind(directBinding)).resolves.toMatchObject({
      runId: directRunId,
      status: 'created',
    })
    await expect(bindAsRuntime.bind(directBinding)).resolves.toMatchObject({
      runId: directRunId,
      status: 'existing',
    })
    await expect(
      bindAsRuntime.bind({ ...directBinding, sessionId: 'different-session' })
    ).rejects.toBeInstanceOf(DirectRunBindingConflictError)

    const immutableBindingClient = await dbPool.connect()
    try {
      await immutableBindingClient.query('BEGIN')
      await immutableBindingClient.query(
        'GRANT UPDATE ON governed_run_attribution_bindings TO control_api_runtime'
      )
      await immutableBindingClient.query('SET LOCAL ROLE control_api_runtime')
      await expect(
        immutableBindingClient.query(
          'UPDATE governed_run_attribution_bindings SET session_id = $2 WHERE run_id = $1',
          [directRunId, 'mutated-session']
        )
      ).rejects.toThrow(/append-only/)
    } finally {
      await immutableBindingClient.query('ROLLBACK')
      immutableBindingClient.release()
    }

    const expiredPromptId = randomUUID()
    const retainedPromptId = randomUUID()
    const promptInsertClient = await dbPool.connect()
    try {
      await promptInsertClient.query('BEGIN')
      await promptInsertClient.query('SET LOCAL ROLE control_api_runtime')
      for (const [approvalRequestId, capturedAt, expiresAt] of [
        [expiredPromptId, '2026-07-10T00:00:00.000Z', '2026-07-10T01:00:00.000Z'],
        [retainedPromptId, '2099-07-10T00:00:00.000Z', '2099-07-10T01:00:00.000Z'],
      ]) {
        await promptInsertClient.query(
          `INSERT INTO governed_approval_prompt_history (
             approval_request_id, approval_kind, ciphertext, nonce, key_version,
             plaintext_sha256, plaintext_bytes, redaction_summary, source_kind,
             captured_at, expires_at
           ) VALUES ($1, 'workflow', $2, $3, 'v1', $4, 1,
                     '{"redacted":false,"replacementCount":0}'::jsonb,
                     'control_api_local', $5, $6)`,
          [
            approvalRequestId,
            Buffer.alloc(17, 1),
            Buffer.alloc(12, 2),
            'a'.repeat(64),
            capturedAt,
            expiresAt,
          ]
        )
      }
      await promptInsertClient.query('COMMIT')
    } catch (error) {
      await promptInsertClient.query('ROLLBACK')
      throw error
    } finally {
      promptInsertClient.release()
    }

    const promptCleanupClient = await dbPool.connect()
    try {
      await promptCleanupClient.query('BEGIN')
      await promptCleanupClient.query('SET LOCAL ROLE trace_maintenance_runtime')
      const deleted = await promptCleanupClient.query(
        'SELECT approval_request_id FROM governed_trace_prune_expired_prompts(250)'
      )
      expect(deleted.rows).toContainEqual({
        approval_request_id: expiredPromptId,
      })
      await promptCleanupClient.query('COMMIT')
    } catch (error) {
      await promptCleanupClient.query('ROLLBACK')
      throw error
    } finally {
      promptCleanupClient.release()
    }
    const promptPrivilegeClient = await dbPool.connect()
    try {
      await promptPrivilegeClient.query('BEGIN')
      await promptPrivilegeClient.query('SET LOCAL ROLE trace_maintenance_runtime')
      await expect(
        promptPrivilegeClient.query('SELECT * FROM governed_approval_prompt_history')
      ).rejects.toThrow(/permission denied/)
    } finally {
      await promptPrivilegeClient.query('ROLLBACK')
      promptPrivilegeClient.release()
    }
    const retainedPrompts = await dbPool.query<{ approval_request_id: string }>(
      `SELECT approval_request_id
         FROM governed_approval_prompt_history
        WHERE approval_request_id = ANY($1::uuid[])
        ORDER BY approval_request_id`,
      [[expiredPromptId, retainedPromptId]]
    )
    expect(retainedPrompts.rows).toEqual([{ approval_request_id: retainedPromptId }])

    const requiredFilterIndexes = [
      'idx_agent_run_events_session_window',
      'idx_agent_run_events_tool_session_filter',
      'idx_agent_run_events_approval_session_filter',
      'idx_administrative_events_list_filter',
      'idx_infrastructure_telemetry_list_filter',
      'idx_governed_event_stream_family_time',
    ]
    const filterIndexes = await dbPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])
        ORDER BY indexname`,
      [requiredFilterIndexes]
    )
    expect(filterIndexes.rows.map(row => row.indexname)).toEqual([...requiredFilterIndexes].sort())

    const governedStreamFamilyTimeIndex = await dbPool.query<{
      table_name: string
      access_method: string
      definition: string
      is_valid: boolean
      is_ready: boolean
      is_unique: boolean
      key_columns: string[]
      has_no_predicate: boolean
      has_no_expressions: boolean
    }>(`
      SELECT table_relation.relname AS table_name,
             access_method.amname AS access_method,
             pg_get_indexdef(index_metadata.indexrelid) AS definition,
             index_metadata.indisvalid AS is_valid,
             index_metadata.indisready AS is_ready,
             index_metadata.indisunique AS is_unique,
             array_agg(attribute.attname::text ORDER BY index_key.ordinality) AS key_columns,
             index_metadata.indpred IS NULL AS has_no_predicate,
             index_metadata.indexprs IS NULL AS has_no_expressions
        FROM pg_index AS index_metadata
        JOIN pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
        JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
        JOIN pg_class AS table_relation ON table_relation.oid = index_metadata.indrelid
        JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
        CROSS JOIN LATERAL unnest(index_metadata.indkey) WITH ORDINALITY
          AS index_key(attnum, ordinality)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = index_key.attnum
       WHERE index_namespace.nspname = 'public'
         AND index_relation.relname = 'idx_governed_event_stream_family_time'
         AND index_key.ordinality <= index_metadata.indnkeyatts
       GROUP BY table_relation.relname, access_method.amname, index_metadata.indexrelid,
                index_metadata.indisvalid, index_metadata.indisready, index_metadata.indisunique,
                index_metadata.indpred IS NULL, index_metadata.indexprs IS NULL
    `)
    expect(governedStreamFamilyTimeIndex.rows).toEqual([
      {
        table_name: 'governed_event_stream',
        access_method: 'btree',
        definition:
          'CREATE INDEX idx_governed_event_stream_family_time ON public.governed_event_stream USING btree (event_family, occurred_at, stream_sequence)',
        is_valid: true,
        is_ready: true,
        is_unique: false,
        key_columns: ['event_family', 'occurred_at', 'stream_sequence'],
        has_no_predicate: true,
        has_no_expressions: true,
      },
    ])

    // These perf fixtures stay in the database when the retention wake below
    // runs, and governed_trace_prune_expired_events prunes relative to
    // clock_timestamp() (90 days for agent_run/administrative/reconcile
    // telemetry). Anchor them to the wall clock so they can never age into
    // the retention window and steal the wake's delete budget.
    const perfFixtureBase = new Date(Math.floor((Date.now() - 2 * DAY_MS) / 1_000) * 1_000)
    const perfFixtureBaseIso = perfFixtureBase.toISOString()
    const perfWindowFrom = new Date(perfFixtureBase.getTime() - 13 * DAY_MS).toISOString()
    const perfWindowTo = new Date(perfFixtureBase.getTime() + 17 * DAY_MS).toISOString()
    await dbPool.query(
      `
      WITH sessions AS (
        SELECT ordinal, gen_random_uuid() AS run_id, 'perf-session-' || ordinal AS session_id
          FROM generate_series(1, 300) ordinal
      ), fixture AS (
        SELECT sessions.*, event.ordinal AS event_ordinal, event.event_type, event.outcome
          FROM sessions
          CROSS JOIN (VALUES
            (1, 'run_start', 'started'),
            (2, 'tool_call', 'succeeded'),
            (3, 'approval', 'denied'),
            (4, 'run_end', 'succeeded')
          ) event(ordinal, event_type, outcome)
      ), inserted AS (
        INSERT INTO agent_run_events (
          source_kind, source_service, source_event_id, idempotency_key, run_id, session_id,
          span_id, origin, event_type, outcome, agent_sub, effective_scopes, decision,
          decision_source_kind, decision_source_ref, host_ref, payload_metadata,
          payload_sha256, occurred_at
        )
        SELECT 'mcp_host_runtime', 'mcp-host',
               'perf-agent-' || ordinal || '-' || event_ordinal,
               md5('perf-agent-' || ordinal || '-' || event_ordinal) ||
                 md5('perf-agent-extra-' || ordinal || '-' || event_ordinal),
               run_id, session_id, 'span-' || event_ordinal, 'direct_chat', event_type, outcome,
               'mcp-host:perf-host', ARRAY[]::text[],
               CASE WHEN event_type='approval' THEN 'require_approval' ELSE 'not_applicable' END,
               CASE WHEN event_type='approval' THEN 'approval_request' ELSE NULL END,
               CASE WHEN event_type='approval' THEN 'perf-approval' ELSE NULL END,
               'perf-host',
               CASE WHEN event_type='tool_call' THEN '{"tool_name":"shell.exec"}'::jsonb
                    WHEN event_type='approval' THEN '{"status":"denied"}'::jsonb
                    ELSE '{}'::jsonb END,
               md5('perf-payload-' || ordinal || '-' || event_ordinal) ||
                 md5('perf-payload-extra-' || ordinal || '-' || event_ordinal),
               $1::timestamptz + (ordinal * interval '1 second') +
                 (event_ordinal * interval '1 millisecond')
          FROM fixture
        ON CONFLICT DO NOTHING
        RETURNING event_id, occurred_at, ingested_at, run_id, payload_sha256
      )
      INSERT INTO governed_event_stream
        (event_family,event_id,schema_version,occurred_at,ingested_at,environment,run_id,payload_sha256)
      SELECT 'agent_run',event_id,1,occurred_at,ingested_at,'integration',run_id,payload_sha256
        FROM inserted
    `,
      [perfFixtureBaseIso]
    )
    await dbPool.query(
      `
      WITH inserted AS (
        INSERT INTO administrative_events (
          source_kind,source_service,source_event_id,idempotency_key,event_kind,action,outcome,
          service_sub,target_type,target_ref,payload_sha256,occurred_at
        )
        SELECT 'control_api_local','control-api','perf-admin-' || ordinal,
               md5('perf-admin-' || ordinal) || md5('perf-admin-extra-' || ordinal),
               'service_action','permission_grant','succeeded','control-api','permission',
               'permission/' || ordinal,
               md5('perf-admin-payload-' || ordinal) || md5('perf-admin-payload-extra-' || ordinal),
               $1::timestamptz + interval '1 hour' + ordinal * interval '1 second'
          FROM generate_series(1, 400) ordinal
        ON CONFLICT DO NOTHING
        RETURNING event_id,occurred_at,ingested_at,payload_sha256
      )
      INSERT INTO governed_event_stream
        (event_family,event_id,schema_version,occurred_at,ingested_at,environment,payload_sha256)
      SELECT 'administrative',event_id,1,occurred_at,ingested_at,'integration',payload_sha256
        FROM inserted
    `,
      [perfFixtureBaseIso]
    )
    await dbPool.query(
      `
      WITH inserted AS (
        INSERT INTO infrastructure_telemetry_events (
          source_service,source_kind,source_occurrence_id,telemetry_type,trigger_kind,outcome,
          reason_code,environment,cluster_name,namespace,workload_kind,workload_ref,
          kubernetes_kind,kubernetes_name,metadata_generation,payload_sha256,occurred_at,idempotency_key
        )
        SELECT 'control-api','trace_maintenance','perf-infra-' || ordinal,
               'reconcile_outcome','controller_reconcile','succeeded','ready','integration',
               'cluster-1','control-plane','Deployment','deployment/perf-' || ordinal,
               'Deployment','perf-' || ordinal,1,
               md5('perf-infra-payload-' || ordinal) || md5('perf-infra-payload-extra-' || ordinal),
               $1::timestamptz + interval '2 hours' + ordinal * interval '1 second',
               md5('perf-infra-' || ordinal) || md5('perf-infra-extra-' || ordinal)
          FROM generate_series(1, 400) ordinal
        ON CONFLICT DO NOTHING
        RETURNING event_id,occurred_at,ingested_at,workload_ref,payload_sha256
      )
      INSERT INTO governed_event_stream
        (event_family,event_id,schema_version,occurred_at,ingested_at,environment,workload_ref,payload_sha256)
      SELECT 'infrastructure_telemetry',event_id,1,occurred_at,ingested_at,'integration',workload_ref,payload_sha256
        FROM inserted
    `,
      [perfFixtureBaseIso]
    )
    await dbPool.query(
      'ANALYZE agent_run_events, administrative_events, infrastructure_telemetry_events, governed_event_stream'
    )

    const explained: Array<{
      label: string
      executionMs: number
      planningMs: number
      forcedIndexNames: string[]
      forcedNodeTypes: string[]
    }> = []
    type ExplainNode = {
      'Index Name'?: string
      'Node Type'?: string
      Plans?: ExplainNode[]
    }
    const collectIndexNames = (
      node: ExplainNode | undefined,
      names = new Set<string>()
    ): string[] => {
      if (!node) return [...names]
      if (node['Index Name']) names.add(node['Index Name'])
      for (const child of node.Plans ?? []) collectIndexNames(child, names)
      return [...names].sort()
    }
    const collectNodeTypes = (
      node: ExplainNode | undefined,
      names = new Set<string>()
    ): string[] => {
      if (!node) return [...names]
      if (node['Node Type']) names.add(node['Node Type'])
      for (const child of node.Plans ?? []) collectNodeTypes(child, names)
      return [...names].sort()
    }
    const explainClient = (label: string) => ({
      query: async (text: string, values?: readonly unknown[]) => {
        const planResult = await dbPool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
          values as unknown[] | undefined
        )
        const root = (planResult.rows[0] as Record<string, unknown>)['QUERY PLAN'] as Array<{
          'Execution Time': number
          'Planning Time': number
          Plan: ExplainNode
        }>
        const forcedClient = await dbPool.connect()
        let forcedIndexNames: string[] = []
        let forcedNodeTypes: string[] = []
        try {
          await forcedClient.query('BEGIN')
          await forcedClient.query('SET LOCAL enable_seqscan=off')
          const forcedResult = await forcedClient.query(
            `EXPLAIN (COSTS OFF, FORMAT JSON) ${text}`,
            values as unknown[] | undefined
          )
          const forcedRoot = (forcedResult.rows[0] as Record<string, unknown>)[
            'QUERY PLAN'
          ] as Array<{
            Plan: ExplainNode
          }>
          forcedIndexNames = collectIndexNames(forcedRoot[0]?.Plan)
          forcedNodeTypes = collectNodeTypes(forcedRoot[0]?.Plan)
          await forcedClient.query('ROLLBACK')
        } catch (error) {
          await forcedClient.query('ROLLBACK')
          throw error
        } finally {
          forcedClient.release()
        }
        explained.push({
          label,
          executionMs: root[0]?.['Execution Time'] ?? Number.POSITIVE_INFINITY,
          planningMs: root[0]?.['Planning Time'] ?? Number.POSITIVE_INFINITY,
          forcedIndexNames,
          forcedNodeTypes,
        })
        return { rows: [], rowCount: 0 }
      },
    })
    await new PostgresGovernedSessionReplayRepository(explainClient('session_list') as never).list({
      filters: {
        occurredFrom: perfWindowFrom,
        occurredTo: perfWindowTo,
        outcome: [],
        sourceService: [],
        sessionId: [],
        hostRef: [],
        humanUserId: [],
        agentSub: [],
        origin: [],
        toolName: ['shell.exec'],
        approvalState: ['denied'],
      },
      highWatermark: '9223372036854775807',
      after: null,
      limit: 50,
      promptState: 'disabled',
      order: 'latest',
    })
    for (const [label, family, filters] of [
      ['administrative_list', 'administrative', { action: ['permission_grant'] }],
      ['infrastructure_list', 'infrastructure_telemetry', { workloadKind: ['Deployment'] }],
    ] as const) {
      await new PostgresGovernedEventReadRepository(explainClient(label) as never).readAfter({
        scope: { kind: 'stream' },
        families: [family],
        order: 'latest',
        afterSequence: '9223372036854775807',
        highWatermark: '9223372036854775807',
        limit: 50,
        occurredFrom: perfWindowFrom,
        occurredTo: perfWindowTo,
        filters,
      })
    }
    expect(explained.map(plan => plan.label)).toEqual([
      'session_list',
      'administrative_list',
      'infrastructure_list',
    ])
    for (const plan of explained) {
      expect(plan.executionMs).toBeLessThan(2_000)
      expect(plan.planningMs).toBeLessThan(2_000)
      expect(plan.forcedIndexNames.length).toBeGreaterThan(0)
      expect(plan.forcedNodeTypes).not.toContain('Seq Scan')
    }
    const planByLabel = Object.fromEntries(explained.map(plan => [plan.label, plan]))
    expect(planByLabel.session_list?.forcedIndexNames).toEqual(
      expect.arrayContaining(['governed_event_stream_event_family_event_id_key'])
    )
    expect(
      planByLabel.session_list?.forcedIndexNames.some(name =>
        name.startsWith('idx_agent_run_events_')
      )
    ).toBe(true)
    // The family/time index is required and checked in pg_catalog above. The
    // planner may instead start from a filtered source table and join through
    // the unique (event_family, event_id) index. Keep that valid access path
    // while rejecting scans and plans with no governed-stream index at all.
    const governedStreamAccessIndexes = [
      'idx_governed_event_stream_family_time',
      'governed_event_stream_event_family_event_id_key',
    ]
    for (const label of ['administrative_list', 'infrastructure_list'] as const) {
      expect(
        planByLabel[label]?.forcedIndexNames.some(indexName =>
          governedStreamAccessIndexes.includes(indexName)
        )
      ).toBe(true)
    }
    expect(planByLabel.administrative_list?.forcedIndexNames).toEqual(
      expect.arrayContaining([
        'idx_administrative_events_list_filter',
        'administrative_events_pkey',
      ])
    )
    expect(planByLabel.infrastructure_list?.forcedIndexNames).toEqual(
      expect.arrayContaining(['infrastructure_telemetry_events_pkey'])
    )

    const priceEvidence = [
      {
        cloudProvider: 'gcp' as const,
        cloudProjectId: 'project-1',
        region: 'europe-west1',
        clusterClass: 'standard',
        resourceClass: 'cpu' as const,
        unit: 'vCPU_hour' as const,
        unitPrice: '1.000000000',
        currency: 'USD',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        sourceRef: 'pricing-export:2026-07-01:cpu',
        sourceSha256: 'a'.repeat(64),
      },
      {
        cloudProvider: 'gcp' as const,
        cloudProjectId: 'project-1',
        region: 'europe-west1',
        clusterClass: 'standard',
        resourceClass: 'memory' as const,
        unit: 'GiB_hour' as const,
        unitPrice: '0.500000000',
        currency: 'USD',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        sourceRef: 'pricing-export:2026-07-01:memory',
        sourceSha256: 'b'.repeat(64),
      },
    ]
    const costKey = {
      utcDay: '2026-07-10',
      cloudProvider: 'gcp' as const,
      cloudProjectId: 'project-1',
      clusterLocation: 'europe-west1',
      clusterName: 'cluster-1',
      environment: 'integration',
      namespace: 'control-plane',
      workloadKind: 'Deployment',
      workloadRef: 'control-api',
      currency: 'USD',
    }
    const costClient = await dbPool.connect()
    let persistedCostId = ''
    try {
      await costClient.query('BEGIN')
      const costRepository = new MaintenanceCostRepository(costClient)
      await expect(costRepository.persistPriceSnapshots(priceEvidence)).resolves.toBe(2)
      await expect(costRepository.persistPriceSnapshots(priceEvidence)).resolves.toBe(0)
      const prices = await costRepository.loadApprovedRequestedCapacityPriceSnapshots({
        key: costKey,
        clusterClass: 'standard',
        effectiveAt: '2026-07-10T00:00:00.000Z',
      })
      expect(prices).toHaveLength(2)
      const persistedCost = await costRepository.persistDailyCostVersion({
        key: costKey,
        valuationKind: 'estimated',
        selectedBasis: 'requested_capacity',
        publicationState: 'provisional',
        completenessStatus: 'complete',
        asOfUtc: '2026-07-11T01:00:00.000Z',
        sourceIntervalStart: '2026-07-10T00:00:00.000Z',
        sourceIntervalEnd: '2026-07-11T00:00:00.000Z',
        billingExportWatermark: null,
        sourceCount: 2,
        sourceSha256: 'c'.repeat(64),
        grossAmount: '1.500000000',
        creditsAmount: '0.000000000',
        netAmount: '1.500000000',
        components: prices.map(price => ({
          componentKey: price.resourceClass,
          resourceClass: price.resourceClass,
          allocationBucket: null,
          unitHours: '1.000000000',
          priceSnapshotId: price.id,
          providerService: null,
          providerSku: null,
          billingViewVersion: null,
          sourceRowCount: null,
          sourceSha256: price.sourceSha256,
          billingExportWatermark: null,
          grossAmount: price.unitPrice,
          creditsAmount: '0.000000000',
          netAmount: price.unitPrice,
        })),
      })
      expect(persistedCost).toMatchObject({
        rollupVersion: 1,
        predecessorVersion: null,
      })
      persistedCostId = persistedCost.id
      await costClient.query('COMMIT')
    } catch (error) {
      await costClient.query('ROLLBACK')
      throw error
    } finally {
      costClient.release()
    }
    const componentCount = await dbPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM infrastructure_cost_daily_components WHERE daily_cost_id = $1',
      [persistedCostId]
    )
    expect(componentCount.rows[0]?.count).toBe('2')

    const wrcRelations = await relationPrivileges(dbPool, 'workflow_recipes_runtime')
    const expectedWrcRelations: Record<string, string[]> = {
      team_workflow_triggers: ['DELETE'],
      user_workflow_triggers: ['DELETE'],
      workflow_approval_requests: ['SELECT', 'UPDATE'],
      workflow_recipe_allowed_teams: ['DELETE'],
      workflow_run_steps: ['INSERT', 'SELECT', 'UPDATE'],
      workflow_runs: ['SELECT', 'UPDATE'],
      workflow_schedules: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
    }
    for (const [relation, actual] of Object.entries(wrcRelations)) {
      expectPrivileges([...actual], expectedWrcRelations[relation] ?? [])
    }

    const cleanupPredicateColumns = await dbPool.query<{
      table_name: string
      recipe_namespace: boolean
      recipe_name: boolean
    }>(
      `
      SELECT relation.relname AS table_name,
             has_column_privilege(
               'workflow_recipes_runtime', relation.oid, 'recipe_namespace', 'SELECT'
             ) AS recipe_namespace,
             has_column_privilege(
               'workflow_recipes_runtime', relation.oid, 'recipe_name', 'SELECT'
             ) AS recipe_name
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = ANY($1::text[])
       ORDER BY relation.relname
    `,
      [['team_workflow_triggers', 'user_workflow_triggers', 'workflow_recipe_allowed_teams']]
    )
    expect(cleanupPredicateColumns.rows).toEqual([
      {
        table_name: 'team_workflow_triggers',
        recipe_namespace: true,
        recipe_name: true,
      },
      {
        table_name: 'user_workflow_triggers',
        recipe_namespace: true,
        recipe_name: true,
      },
      {
        table_name: 'workflow_recipe_allowed_teams',
        recipe_namespace: true,
        recipe_name: true,
      },
    ])

    const cleanupUserId = randomUUID()
    const cleanupTeamId = randomUUID()
    await dbPool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      cleanupUserId,
      `runtime-cleanup-${cleanupUserId}@example.test`,
    ])
    await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Runtime cleanup test')`, [
      cleanupTeamId,
    ])
    await dbPool.query(
      `INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
       VALUES ($1, 'sandbox-recipes', 'runtime-cleanup-test')`,
      [cleanupUserId]
    )
    await dbPool.query(
      `INSERT INTO team_workflow_triggers (team_id, recipe_namespace, recipe_name)
       VALUES ($1, 'sandbox-recipes', 'runtime-cleanup-test')`,
      [cleanupTeamId]
    )
    await dbPool.query(
      `INSERT INTO workflow_recipe_allowed_teams (team_id, recipe_namespace, recipe_name)
       VALUES ($1, 'sandbox-recipes', 'runtime-cleanup-test')`,
      [cleanupTeamId]
    )

    const cleanupClient = await dbPool.connect()
    try {
      await cleanupClient.query('BEGIN')
      await cleanupClient.query('SET LOCAL ROLE workflow_recipes_runtime')
      for (const table of [
        'user_workflow_triggers',
        'team_workflow_triggers',
        'workflow_recipe_allowed_teams',
      ]) {
        const result = await cleanupClient.query(
          `DELETE FROM ${table}
            WHERE recipe_namespace = $1 AND recipe_name = $2`,
          ['sandbox-recipes', 'runtime-cleanup-test']
        )
        expect(result.rowCount).toBe(1)
      }
      await cleanupClient.query('ROLLBACK')
    } catch (error) {
      await cleanupClient.query('ROLLBACK')
      throw error
    } finally {
      cleanupClient.release()
    }

    const sequenceAccess = await dbPool.query<{ violations: string }>(`
      SELECT COALESCE(string_agg(sequence.relname, ',' ORDER BY sequence.relname), '') AS violations
        FROM pg_class sequence
        JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
       WHERE namespace.nspname = 'public'
         AND sequence.relkind = 'S'
         AND (
           has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'USAGE')
           OR has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'SELECT')
           OR has_sequence_privilege('workflow_recipes_runtime', sequence.oid, 'UPDATE')
         )
    `)
    expect(sequenceAccess.rows[0]?.violations).toBe('')

    const functionAccess = await dbPool.query<{ violations: string }>(`
      SELECT COALESCE(string_agg(routine.oid::regprocedure::text, ',' ORDER BY routine.oid::regprocedure::text), '') AS violations
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname = 'public'
         AND routine.proname LIKE 'governed_trace_%'
         AND has_function_privilege('workflow_recipes_runtime', routine.oid, 'EXECUTE')
    `)
    expect(functionAccess.rows[0]?.violations).toBe('')

    const traceService = new AgentRunEventService({
      transaction: async () => {
        throw new Error('integration fixture supplies the transaction explicitly')
      },
      now: () => new Date(),
    })
    const tracePrincipal = {
      kind: 'mcp_host_runtime' as const,
      sourceService: 'mcp-host',
      serviceSub: 'retention-integration-host',
      credentialId: 'integration-fixture',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'retention-integration',
      hostRefs: ['retention-integration-host'],
      allowedEventTypes: ['run_start', 'approval'] as const,
    }
    const expiredEntries = Array.from({ length: 1_001 }, (_, index) => ({
      binding: {
        runId: randomUUID(),
        sessionId: null,
        spanId: `retention-root-${index}`,
        parentSpanId: null,
        origin: 'api' as const,
        identityIssuer: null,
        actorHumanSub: null,
        agentSub: 'mcp-host:retention-integration-host',
        actorMedium: 'api',
        resourceAud: null,
        effectiveScopes: [] as string[],
        decision: 'not_applicable' as const,
        decisionSourceKind: null,
        decisionSourceRef: null,
        approvalRequestId: null,
        tokenExchangeId: null,
        environment: 'integration',
        tenantId: null,
        teamId: null,
        userId: null,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'retention-integration',
        hostRef: 'retention-integration-host',
        outcome: 'started' as const,
        durationMs: null,
      },
      input: {
        sourceEventId: randomUUID(),
        occurredAt: '2025-01-01T00:00:00.000Z',
        eventType: 'run_start' as const,
      },
    }))

    const expiredEventIds: string[] = []
    for (let offset = 0; offset < expiredEntries.length; offset += 100) {
      const appendClient = await dbPool.connect()
      try {
        await appendClient.query('BEGIN')
        const appended = await traceService.appendManyInTransaction(
          appendClient,
          tracePrincipal,
          expiredEntries.slice(offset, offset + 100)
        )
        expiredEventIds.push(...appended.map(event => event.eventId))
        await appendClient.query('COMMIT')
      } catch (error) {
        await appendClient.query('ROLLBACK')
        throw error
      } finally {
        appendClient.release()
      }
    }

    async function runRetentionWake() {
      const maintenanceClient = await dbPool.connect()
      try {
        await maintenanceClient.query('BEGIN')
        await maintenanceClient.query('SET LOCAL ROLE trace_maintenance_runtime')
        const result = await runRetentionBatch(maintenanceClient)
        await maintenanceClient.query('COMMIT')
        return result
      } catch (error) {
        await maintenanceClient.query('ROLLBACK')
        throw error
      } finally {
        maintenanceClient.release()
      }
    }

    await expect(runRetentionWake()).resolves.toEqual({
      eventsDeleted: 1_000,
      costsDeleted: 0,
      promptsDeleted: 0,
      saturatedGrains: ['agent_run'],
    })
    const retainedAfterFirstBatch = await dbPool.query<{
      family_count: string
      stream_count: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text
           FROM agent_run_events
          WHERE event_id = ANY($1::uuid[])) AS family_count,
        (SELECT COUNT(*)::text
           FROM governed_event_stream
          WHERE event_family = 'agent_run'
            AND event_id = ANY($1::uuid[])) AS stream_count
    `,
      [expiredEventIds]
    )
    expect(retainedAfterFirstBatch.rows[0]).toEqual({
      family_count: '1',
      stream_count: '1',
    })
    await expect(runRetentionWake()).resolves.toEqual({
      eventsDeleted: 1,
      costsDeleted: 0,
      promptsDeleted: 0,
      saturatedGrains: [],
    })
    const retainedAfterSecondBatch = await dbPool.query<{
      family_count: string
      stream_count: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text
           FROM agent_run_events
          WHERE event_id = ANY($1::uuid[])) AS family_count,
        (SELECT COUNT(*)::text
           FROM governed_event_stream
          WHERE event_family = 'agent_run'
            AND event_id = ANY($1::uuid[])) AS stream_count
    `,
      [expiredEventIds]
    )
    expect(retainedAfterSecondBatch.rows[0]).toEqual({
      family_count: '0',
      stream_count: '0',
    })

    // Recent = well inside every retention window and not after ingestion
    // (occurred_at <= ingested_at + 5 minutes), relative to the wall clock.
    const recentOccurredAt = new Date(Date.now() - 60_000).toISOString()
    const recentApprovalOccurredAt = new Date(Date.now() - 59_000).toISOString()
    const recentClient = await dbPool.connect()
    let recentEventId = ''
    try {
      await recentClient.query('BEGIN')
      const recentBinding = {
        ...expiredEntries[0]!.binding,
        runId: randomUUID(),
        spanId: 'append-only-trigger-root',
      }
      const recent = await traceService.appendInTransaction(
        recentClient,
        tracePrincipal,
        recentBinding,
        {
          sourceEventId: randomUUID(),
          occurredAt: recentOccurredAt,
          eventType: 'run_start',
        }
      )
      recentEventId = recent.eventId
      const approvalSourceEventId = 'task:integration:approval:request-1:approved'
      const approval = await traceService.appendInTransaction(
        recentClient,
        tracePrincipal,
        {
          ...recentBinding,
          spanId: 'append-only-trigger-approval',
          parentSpanId: recentBinding.spanId,
          decision: 'allow',
          decisionSourceKind: 'legacy_gate',
          decisionSourceRef: approvalSourceEventId,
          outcome: 'approved',
        },
        {
          sourceEventId: approvalSourceEventId,
          occurredAt: recentApprovalOccurredAt,
          eventType: 'approval',
          payload: { status: 'approved' },
        }
      )
      await recentClient.query('COMMIT')

      const persistedApproval = await dbPool.query<{
        decision_source_kind: string
      }>('SELECT decision_source_kind FROM agent_run_events WHERE event_id = $1', [
        approval.eventId,
      ])
      expect(persistedApproval.rows[0]?.decision_source_kind).toBe('legacy_gate')
    } catch (error) {
      await recentClient.query('ROLLBACK')
      throw error
    } finally {
      recentClient.release()
    }

    for (const operation of [
      {
        privilege: 'UPDATE',
        sql: 'UPDATE agent_run_events SET duration_ms = duration_ms WHERE event_id = $1',
        params: [recentEventId],
      },
      {
        privilege: 'DELETE',
        sql: 'DELETE FROM agent_run_events WHERE event_id = $1',
        params: [recentEventId],
      },
      {
        privilege: 'TRUNCATE',
        sql: 'TRUNCATE TABLE agent_run_events',
        params: [] as string[],
      },
    ]) {
      const mutationClient = await dbPool.connect()
      try {
        await mutationClient.query('BEGIN')
        await mutationClient.query(
          `GRANT ${operation.privilege} ON TABLE agent_run_events TO control_api_runtime`
        )
        await mutationClient.query('SET LOCAL ROLE control_api_runtime')
        await expect(mutationClient.query(operation.sql, operation.params)).rejects.toThrow(
          /append-only/
        )
      } finally {
        await mutationClient.query('ROLLBACK')
        mutationClient.release()
      }
    }

    const appendOnlyIntegrity = await dbPool.query<{
      family_count: string
      stream_count: string
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM agent_run_events WHERE event_id = $1) AS family_count,
         (SELECT COUNT(*)::text
            FROM governed_event_stream
           WHERE event_family = 'agent_run' AND event_id = $1) AS stream_count`,
      [recentEventId]
    )
    expect(appendOnlyIntegrity.rows[0]).toEqual({
      family_count: '1',
      stream_count: '1',
    })

    const approvalRequestId = randomUUID()
    const workflowRunId = randomUUID()
    await dbPool.query(
      `INSERT INTO workflow_approval_requests (
         id, recipe_namespace, recipe_name, expires_at, status,
         target_user_id, payload, idempotency_key
       ) VALUES ($1, 'sandbox-recipes', 'runtime-boundary-test', NOW() + INTERVAL '1 hour',
                 'approved', $2, $3::jsonb, $4)`,
      [
        approvalRequestId,
        randomUUID(),
        JSON.stringify({
          metadata: {
            workflowTrigger: {
              providerBinding: {
                medium: 'telegram',
                providerChannelId: 'runtime-boundary-test',
              },
            },
          },
        }),
        `runtime-boundary-approval-${approvalRequestId}`,
      ]
    )
    await dbPool.query(
      `INSERT INTO workflow_approval_trigger_intents (
         approval_request_id, trigger_namespace, trigger_name, trigger_caller_key
       ) VALUES ($1, 'sandbox-recipes', 'runtime-boundary-test', 'integration-test')`,
      [approvalRequestId]
    )
    await dbPool.query(
      `INSERT INTO workflow_runs (
         run_id, recipe_namespace, recipe_name, phase, actor_type,
         trigger_source, approval_request_id
       ) VALUES ($1, 'sandbox-recipes', 'runtime-boundary-test', 'Running',
                 'user', 'onDemand', $2)`,
      [workflowRunId, approvalRequestId]
    )

    const wrcClient = await dbPool.connect()
    try {
      await wrcClient.query('BEGIN')
      await wrcClient.query('SET LOCAL ROLE workflow_recipes_runtime')
      await wrcClient.query(
        `UPDATE workflow_runs
            SET phase = 'Succeeded', completed_at = NOW(), updated_at = NOW()
          WHERE run_id = $1`,
        [workflowRunId]
      )
      await wrcClient.query('COMMIT')
    } catch (error) {
      await wrcClient.query('ROLLBACK')
      throw error
    } finally {
      wrcClient.release()
    }

    const notification = await dbPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM notification_deliveries
        WHERE dedupe_key = $1`,
      [`workflow.run.completed:${workflowRunId}:Succeeded`]
    )
    expect(notification.rows[0]?.count).toBe('1')
  }, 60_000)

  it('authorizes and binds the canonical Host route with signed JWTs and persisted grants', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => dbPool.connect() })

    const directUserId = randomUUID()
    const teamUserId = randomUUID()
    const deniedUserId = randomUUID()
    const teamId = randomUUID()
    const deniedTeamId = randomUUID()
    const hostRef = 'signed-jwt-host'
    await dbPool.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, $2, 'Direct Grant User'),
              ($3, $4, 'Team Grant User'),
              ($5, $6, 'Denied User')`,
      [
        directUserId,
        `direct-${directUserId}@example.test`,
        teamUserId,
        `team-${teamUserId}@example.test`,
        deniedUserId,
        `denied-${deniedUserId}@example.test`,
      ]
    )
    await dbPool.query(
      `INSERT INTO teams (id, name)
       VALUES ($1, 'Allowed Team'), ($2, 'Denied Team')`,
      [teamId, deniedTeamId]
    )
    await dbPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active'), ($3, $4, 'member', 'active')`,
      [teamId, teamUserId, deniedTeamId, deniedUserId]
    )
    await dbPool.query(`INSERT INTO user_agents (user_id, agent_name) VALUES ($1, $2)`, [
      directUserId,
      hostRef,
    ])
    await dbPool.query(`INSERT INTO team_agents (team_id, agent_name) VALUES ($1, $2)`, [
      teamId,
      hostRef,
    ])

    const bindingService = new DirectRunAttributionBindingService(async work => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE control_api_runtime')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    })
    const gateway = {
      listResource: async (plural: string, namespace: string) => {
        expect(plural).toBe('hosts')
        expect(namespace).toBe(config.hostsNamespace)
        return [{ metadata: { name: hostRef }, spec: { enabled: true } }]
      },
    } as unknown as K8sGateway
    const app = express()
    app.use(
      createRpcAccessUsersRouter(gateway, {
        bindingService,
        directory: {
          getUserAgents: userId => getUserAgents(userId, dbPool),
          getCurrentTeam: (userId, resolvedTeamId) =>
            getCurrentTeam(userId, resolvedTeamId, dbPool),
          getTeamAgents: resolvedTeamId => getTeamAgents(resolvedTeamId, dbPool),
        },
      })
    )

    const tokenFor = (sub: string, resolvedTeamId: string) =>
      signRpcAccessToken({
        sub,
        typ: 'user',
        teamId: resolvedTeamId,
        role: 'member',
        scopes: ['host:message:invoke'],
        hostRefs: [hostRef],
        jti: randomUUID(),
      })
    const postBinding = (
      userId: string,
      token: string,
      runId: string,
      sessionId = `session-${runId}`
    ) =>
      request(app)
        .post(`/rpc/access/users/${userId}/mcp-hosts/${hostRef}`)
        .set('x-rpc-access-token', token)
        .send({ runId, sessionId, origin: 'direct_chat' })

    const directRunId = randomUUID()
    await postBinding(directUserId, tokenFor(directUserId, deniedTeamId), directRunId)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          userId: directUserId,
          hostRef,
          bindingStatus: 'recorded',
        })
      })

    await postBinding(
      directUserId,
      tokenFor(directUserId, deniedTeamId),
      directRunId,
      `conflicting-session-${directRunId}`
    )
      .expect(409)
      .expect({ error: 'direct_run_binding_conflict' })

    const teamRunId = randomUUID()
    await postBinding(teamUserId, tokenFor(teamUserId, teamId), teamRunId)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          userId: teamUserId,
          hostRef,
          bindingStatus: 'recorded',
        })
      })

    const deniedRunId = randomUUID()
    await postBinding(deniedUserId, tokenFor(deniedUserId, deniedTeamId), deniedRunId).expect(403)

    await dbPool.query(
      `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
      [teamId, teamUserId]
    )
    const staleTeamRunId = randomUUID()
    await postBinding(teamUserId, tokenFor(teamUserId, teamId), staleTeamRunId).expect(403)

    const persisted = await dbPool.query<{
      run_id: string
      actor_human_sub: string
      user_id: string
      team_id: string
    }>(
      `SELECT run_id::text, actor_human_sub, user_id::text, team_id::text
         FROM governed_run_attribution_bindings
        WHERE run_id = ANY($1::uuid[])
        ORDER BY run_id`,
      [[directRunId, teamRunId, deniedRunId, staleTeamRunId]]
    )
    expect(persisted.rows).toHaveLength(2)
    expect(persisted.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: directRunId,
          actor_human_sub: directUserId,
          user_id: directUserId,
          team_id: deniedTeamId,
        }),
        expect.objectContaining({
          run_id: teamRunId,
          actor_human_sub: teamUserId,
          user_id: teamUserId,
          team_id: teamId,
        }),
      ])
    )
  }, 60_000)

  it('executes the GFS audit append against the real migrated schema', async () => {
    const auditId = await auditMutation(dbPool, {
      actorKey: 'operator:',
      targetKey: 'host:1st:mcp-host/chatllm',
      op: 'grant.put[read]',
      drive: 'main',
      resourceId: randomUUID(),
      outcome: 'allowed',
      requestId: 'real-pg-gfs-audit',
    })

    expect(auditId).toMatch(/^\d+$/)
    const stored = await dbPool.query<{ sequence_no: string; subject: string }>(
      `SELECT sequence_no::text, subject
         FROM gfs_audit
        WHERE sequence_no = $1::bigint`,
      [auditId]
    )
    expect(stored.rows).toEqual([{ sequence_no: auditId, subject: 'host:1st:mcp-host/chatllm' }])
  })

  it('adds workflow_schedules.concurrency_policy idempotently with a Forbid default', async () => {
    const { initDb } = await import('../src/db.js')
    const connector = { connect: () => dbPool.connect() }
    const version = '0129_workflow_schedules_concurrency_policy'

    await initDb(connector)
    // Forget the record so initDb re-runs the body over the existing column.
    await dbPool.query('DELETE FROM schema_migrations WHERE version = $1', [version])
    await initDb(connector)

    const recorded = await dbPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations WHERE version = $1',
      [version]
    )
    expect(recorded.rows[0]?.count).toBe('1')

    const column = await dbPool.query<{
      column_default: string | null
      is_nullable: string
      data_type: string
    }>(
      `SELECT column_default, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workflow_schedules'
          AND column_name = 'concurrency_policy'`
    )
    expect(column.rows).toEqual([
      {
        column_default: "'Forbid'::text",
        is_nullable: 'NO',
        data_type: 'text',
      },
    ])

    const checks = await dbPool.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'public.workflow_schedules'::regclass
          AND conname = 'workflow_schedules_concurrency_policy_check'`
    )
    expect(checks.rows).toHaveLength(1)

    const client = await dbPool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query<{ concurrency_policy: string }>(
        `INSERT INTO workflow_schedules (recipe_namespace, recipe_name, cron_expression, next_fire_at)
         VALUES ('p3-forbid-ns', 'p3-forbid-recipe', '*/5 * * * *', now())
         RETURNING concurrency_policy`
      )
      expect(inserted.rows[0]?.concurrency_policy).toBe('Forbid')
      await expect(
        client.query(
          `UPDATE workflow_schedules SET concurrency_policy = 'Sometimes'
            WHERE recipe_namespace = 'p3-forbid-ns' AND recipe_name = 'p3-forbid-recipe'`
        )
      ).rejects.toThrow(/workflow_schedules_concurrency_policy_check/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('recognizes deployed entity-change aliases without replaying migration DDL', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const connector = { connect: () => dbPool.connect() }
    await initDb(connector)

    const feedMigration = CONTROL_API_MIGRATIONS.find(
      migration => migration.version === '0122_durable_entity_change_feed'
    )
    const checkpointMigration = CONTROL_API_MIGRATIONS.find(
      migration => migration.version === '0123_entity_change_checkpoint_cursor_convergence'
    )
    expect(feedMigration?.legacyVersions).toEqual([
      '0116_durable_entity_change_feed',
      '0117_durable_entity_change_feed',
      '0119_durable_entity_change_feed',
    ])
    expect(checkpointMigration?.legacyVersions).toEqual([
      '0120_entity_change_checkpoint_cursor_convergence',
    ])
    if (!feedMigration || !checkpointMigration) return

    const captureDefinition = await dbPool.query<{ definition: string }>(
      `SELECT pg_get_functiondef('entity_change_capture_resource()'::regprocedure) AS definition`
    )
    const checkpointDefinition = await dbPool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'entity_change_read_checkpoint(uuid,integer)'::regprocedure
       ) AS definition`
    )

    const setLegacyVersion = async (legacyVersion: string, versions: readonly string[]) => {
      await dbPool.query(`DELETE FROM schema_migrations WHERE version = ANY($1::text[])`, [
        versions,
      ])
      await dbPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [legacyVersion])
    }

    try {
      for (const legacyVersion of feedMigration.legacyVersions ?? []) {
        await setLegacyVersion(legacyVersion, [
          feedMigration.version,
          ...(feedMigration.legacyVersions ?? []),
        ])
        await dbPool.query(`
          CREATE OR REPLACE FUNCTION entity_change_capture_resource() RETURNS trigger
            LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'legacy entity-change feed migration was reapplied';
          END;
          $$
        `)

        await initDb(connector)

        const recorded = await dbPool.query<{ version: string }>(
          `SELECT version FROM schema_migrations
            WHERE version = ANY($1::text[]) ORDER BY version`,
          [[feedMigration.version, legacyVersion]]
        )
        expect(recorded.rows.map(row => row.version)).toContain(feedMigration.version)
        await expect(
          dbPool.query(
            `INSERT INTO gfs_resources (drive, name, kind)
             VALUES ($1, 'legacy-alias-probe', 'file')`,
            [`legacy-alias-${randomUUID()}`]
          )
        ).rejects.toThrow('legacy entity-change feed migration was reapplied')

        await dbPool.query(captureDefinition.rows[0]!.definition)
      }

      await setLegacyVersion(checkpointMigration.legacyVersions?.[0] ?? '', [
        checkpointMigration.version,
        ...(checkpointMigration.legacyVersions ?? []),
      ])
      await dbPool.query(`
        CREATE OR REPLACE FUNCTION entity_change_read_checkpoint(
          requested_cursor UUID,
          maximum_recovery_events INTEGER
        ) RETURNS TABLE (
          needs_resync BOOLEAN,
          current_cursor UUID,
          current_sequence BIGINT,
          invalidated_scopes TEXT[]
        ) LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'legacy entity-change checkpoint migration was reapplied';
        END;
        $$
      `)

      await initDb(connector)

      const checkpointVersions = await dbPool.query<{ version: string }>(
        `SELECT version FROM schema_migrations
          WHERE version = ANY($1::text[]) ORDER BY version`,
        [[checkpointMigration.version, ...(checkpointMigration.legacyVersions ?? [])]]
      )
      expect(checkpointVersions.rows.map(row => row.version)).toContain(checkpointMigration.version)
      await expect(
        dbPool.query(
          `SELECT * FROM entity_change_read_checkpoint(
             '00000000-0000-0000-0000-000000000000'::uuid, 100
           )`
        )
      ).rejects.toThrow('legacy entity-change checkpoint migration was reapplied')
    } finally {
      await dbPool.query(captureDefinition.rows[0]!.definition)
      await dbPool.query(checkpointDefinition.rows[0]!.definition)
      await dbPool.query(`DELETE FROM schema_migrations WHERE version = ANY($1::text[])`, [
        [
          feedMigration.version,
          ...(feedMigration.legacyVersions ?? []),
          checkpointMigration.version,
          ...(checkpointMigration.legacyVersions ?? []),
        ],
      ])
      await dbPool.query('INSERT INTO schema_migrations(version) VALUES ($1), ($2)', [
        feedMigration.version,
        checkpointMigration.version,
      ])
    }
  })

  it('applies checkpoint convergence after a legacy feed-only migration record', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const connector = { connect: () => dbPool.connect() }
    await initDb(connector)

    const feedMigration = CONTROL_API_MIGRATIONS.find(
      migration => migration.version === '0122_durable_entity_change_feed'
    )
    const checkpointMigration = CONTROL_API_MIGRATIONS.find(
      migration => migration.version === '0123_entity_change_checkpoint_cursor_convergence'
    )
    expect(feedMigration?.legacyVersions).toContain('0116_durable_entity_change_feed')
    expect(checkpointMigration?.legacyVersions).toEqual([
      '0120_entity_change_checkpoint_cursor_convergence',
    ])
    if (!feedMigration || !checkpointMigration) return

    const oldVersions = [
      feedMigration.version,
      ...(feedMigration.legacyVersions ?? []),
      checkpointMigration.version,
      ...(checkpointMigration.legacyVersions ?? []),
    ]
    try {
      await dbPool.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [
        oldVersions,
      ])
      await dbPool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
        '0116_durable_entity_change_feed',
      ])
      await dbPool.query(`
        CREATE OR REPLACE FUNCTION entity_change_read_checkpoint(
          requested_cursor UUID,
          maximum_recovery_events INTEGER
        ) RETURNS TABLE (
          needs_resync BOOLEAN,
          current_cursor UUID,
          current_sequence BIGINT,
          invalidated_scopes TEXT[]
        ) LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'checkpoint convergence migration was not applied';
        END;
        $$
      `)

      await initDb(connector)

      const recordedVersions = await dbPool.query<{ version: string }>(
        `SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version`,
        [oldVersions]
      )
      expect(recordedVersions.rows.map(row => row.version)).toEqual([
        '0116_durable_entity_change_feed',
        feedMigration.version,
        checkpointMigration.version,
      ])
      const checkpoint = await dbPool.query(
        `SELECT * FROM entity_change_read_checkpoint(
           '00000000-0000-0000-0000-000000000000'::uuid, 100
         )`
      )
      expect(checkpoint.rows).toHaveLength(1)
      expect(typeof checkpoint.rows[0]?.needs_resync).toBe('boolean')
      expect(checkpoint.rows[0]?.current_cursor).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    } finally {
      await dbPool.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [
        oldVersions,
      ])
      await dbPool.query('INSERT INTO schema_migrations(version) VALUES ($1), ($2)', [
        feedMigration.version,
        checkpointMigration.version,
      ])
    }
  })

  it('prevents temp-type shadowing in entity-change SECURITY DEFINER triggers', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => dbPool.connect() })

    const attackerRole = `entity_change_shadow_${randomBytes(5).toString('hex')}`
    const attackerPassword = randomBytes(24).toString('hex')
    let attackerPool: Pool | undefined
    try {
      await adminPool.query(
        `CREATE ROLE ${quoteIdent(attackerRole)} LOGIN PASSWORD '${attackerPassword}'`
      )
      await adminPool.query(`GRANT gfs_controller TO ${quoteIdent(attackerRole)}`)
      const attackerUrl = new URL(connectionString)
      attackerUrl.username = attackerRole
      attackerUrl.password = attackerPassword
      attackerPool = new Pool({
        connectionString: attackerUrl.toString(),
        max: 1,
      })

      const attacker = await attackerPool.connect()
      try {
        await attacker.query('CREATE TEMP TABLE temp_schema_bootstrap (id INTEGER)')
        await attacker.query(`
          CREATE FUNCTION pg_temp.entity_change_shadow_check(value pg_catalog.text)
          RETURNS BOOLEAN LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'temporary type shadow executed as %', current_user;
          END;
          $$
        `)
        await attacker.query(`
          CREATE DOMAIN pg_temp.text AS pg_catalog.text
            CHECK (pg_temp.entity_change_shadow_check(VALUE))
        `)

        const resourceId = randomUUID()
        await expect(
          attacker.query(
            `INSERT INTO gfs_resources (resource_id, drive, name, kind, path_cache)
             VALUES ($1, $2, 'shadow-probe', 'file', '/shadow-probe')`,
            [resourceId, `shadow-${randomUUID()}`]
          )
        ).resolves.toBeDefined()
        const stored = await dbPool.query('SELECT 1 FROM gfs_resources WHERE resource_id = $1', [
          resourceId,
        ])
        expect(stored.rowCount).toBe(1)
      } finally {
        attacker.release()
      }

      const migrationVersions = await dbPool.query<{ version: string }>(
        `SELECT version FROM schema_migrations WHERE version = $1`,
        ['0124_entity_change_definer_search_path']
      )
      expect(migrationVersions.rows).toHaveLength(1)

      const functionPaths = await dbPool.query<{
        function_name: string
        config: string[] | null
      }>(`
        SELECT procedure.proname AS function_name, procedure.proconfig AS config
          FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure.proname IN (
             'entity_change_capture_resource',
             'entity_change_capture_scope',
             'entity_change_dispatch_batch',
             'entity_change_read_checkpoint'
           )
      `)
      expect(functionPaths.rows).toHaveLength(4)
      for (const { config } of functionPaths.rows) {
        expect(config).toContain('search_path=pg_catalog, public, pg_temp')
      }
    } finally {
      await endPoolAndWaitForClients(attackerPool)
      await dbPool.query(`DROP OWNED BY ${quoteIdent(attackerRole)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${quoteIdent(attackerRole)}`)
    }
  })

  it('commits GFS grant/share batches atomically and invalidates only after commit', async () => {
    const operator = await dbPool.query<{ id: string }>(
      `SELECT id::text FROM control_admin_users
        WHERE status = 'active' ORDER BY created_at, id LIMIT 1`
    )
    const operatorId = operator.rows[0]!.id
    const shareUserId = randomUUID()
    const shareTeamId = randomUUID()
    await dbPool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Issue 792 Share User')`,
      [shareUserId, `issue792-share-${shareUserId}@example.test`]
    )
    await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Issue 792 Share Team')`, [
      shareTeamId,
    ])
    const listener = await dbPool.connect()
    const notifications: string[] = []
    listener.on('notification', message => {
      if (message.channel === 'gfs_perm_invalidate') notifications.push(message.channel)
    })
    await listener.query('LISTEN gfs_perm_invalidate')

    type BatchCase = {
      kind: 'grant' | 'share'
      table: 'gfs_grants' | 'gfs_shares'
      targets: readonly GfsSubject[]
      write: (
        client: PoolClient,
        params: { req: ExpressRequest; drive: string; resourceId: string }
      ) => Promise<{ error: unknown }>
    }
    const caller = {
      isOperator: true,
      subjects: new Set(['operator:']),
      actorKey: 'operator:',
    }
    const cases: BatchCase[] = [
      {
        kind: 'grant',
        table: 'gfs_grants',
        targets: Array.from({ length: 3 }, () => ({
          type: 'host' as const,
          id: `1st:mcp-host/bulk-${randomUUID()}`,
        })),
        write: (client, params) =>
          writeGfsGrantBatchInTransaction(client, {
            ...params,
            caller,
            subjects: cases[0]!.targets,
            permissions: ['read'],
            inherit: false,
          }),
      },
      {
        kind: 'share',
        table: 'gfs_shares',
        targets: [
          { type: 'user', id: shareUserId },
          { type: 'team', id: shareTeamId },
        ],
        write: (client, params) =>
          writeGfsShareBatchInTransaction(client, {
            ...params,
            caller,
            subjects: cases[1]!.targets,
            permissions: ['read'],
            includeDescendants: true,
          }),
      },
    ]
    const createResource = async (drive: string): Promise<string> => {
      const rootId = randomUUID()
      const resourceId = randomUUID()
      // D32 permits inheritable shares below the drive root, not on the root itself.
      await dbPool.query(
        `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, $3, NULL, '', 'directory', '/'),
                ($2, $3, $1, 'batch', 'directory', '/batch')`,
        [rootId, resourceId, drive]
      )
      return resourceId
    }
    const runBatch = async (
      batchCase: BatchCase,
      resourceId: string,
      drive: string,
      requestId: string,
      beforeCommit?: (client: PoolClient) => Promise<void>
    ): Promise<void> => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        const req = {
          adminAuth: { sub: operatorId },
          correlationId: requestId,
          ip: '127.0.0.1',
        } as unknown as ExpressRequest
        const result = await batchCase.write(client, {
          req,
          drive,
          resourceId,
        })
        expect(result.error).toBeNull()
        await beforeCommit?.(client)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    const counts = async (
      batchCase: BatchCase,
      resourceId: string,
      requestId: string
    ): Promise<{ mutations: string; audits: string; events: string }> => {
      const result = await dbPool.query<{
        mutations: string
        audits: string
        events: string
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM ${batchCase.table}
             WHERE resource_id = $1::uuid) AS mutations,
           (SELECT COUNT(*)::text FROM gfs_audit WHERE request_id = $2) AS audits,
           (SELECT COUNT(*)::text FROM administrative_events WHERE request_id = $2) AS events`,
        [resourceId, requestId]
      )
      return result.rows[0]!
    }
    const settleListener = async (): Promise<void> => {
      await listener.query('SELECT 1')
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const waitForInvalidationCount = async (count: number): Promise<void> => {
      if (notifications.length >= count) return
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listener.off('notification', onNotification)
          reject(new Error('timed out waiting for GFS invalidation'))
        }, 2_000)
        const onNotification = (): void => {
          if (notifications.length < count) return
          clearTimeout(timeout)
          listener.off('notification', onNotification)
          resolve()
        }
        listener.on('notification', onNotification)
      })
    }

    try {
      let committedNotificationCount = 0
      for (const batchCase of cases) {
        const targetCount = String(batchCase.targets.length)
        const committedDrive = `issue792-${batchCase.kind}-commit-${randomUUID()}`
        const committedResourceId = await createResource(committedDrive)
        const committedRequestId = `issue792-${batchCase.kind}-commit-${randomUUID()}`
        await runBatch(
          batchCase,
          committedResourceId,
          committedDrive,
          committedRequestId,
          async client => {
            const inside = await client.query<{
              mutations: string
              audits: string
              events: string
            }>(
              `SELECT
                 (SELECT COUNT(*)::text FROM ${batchCase.table}
                   WHERE resource_id = $1::uuid) AS mutations,
                 (SELECT COUNT(*)::text FROM gfs_audit WHERE request_id = $2) AS audits,
                 (SELECT COUNT(*)::text FROM administrative_events
                   WHERE request_id = $2) AS events`,
              [committedResourceId, committedRequestId]
            )
            expect(inside.rows[0]).toEqual({
              mutations: targetCount,
              audits: targetCount,
              events: targetCount,
            })
            expect(notifications).toHaveLength(committedNotificationCount)
          }
        )
        committedNotificationCount += 1
        await waitForInvalidationCount(committedNotificationCount)
        expect(await counts(batchCase, committedResourceId, committedRequestId)).toEqual({
          mutations: targetCount,
          audits: targetCount,
          events: targetCount,
        })
        expect(notifications).toHaveLength(committedNotificationCount)

        for (const failure of [
          { stage: 'audit', table: 'gfs_audit' },
          { stage: 'event', table: 'administrative_events' },
        ] as const) {
          const requestId = `issue792-${batchCase.kind}-${failure.stage}-failure-${randomUUID()}`
          const functionName = `issue792_fail_${batchCase.kind}_${failure.stage}`
          const triggerName = `${functionName}_trigger`
          await dbPool.query(
            `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger
               LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.request_id = '${requestId}' THEN
                 RAISE EXCEPTION
                   'injected issue 792 ${batchCase.kind} ${failure.stage} failure';
               END IF;
               RETURN NEW;
             END;
             $$;
             CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${failure.table}
               FOR EACH ROW EXECUTE FUNCTION ${functionName}();`
          )
          const drive = `issue792-${batchCase.kind}-${failure.stage}-${randomUUID()}`
          const resourceId = await createResource(drive)
          try {
            await expect(runBatch(batchCase, resourceId, drive, requestId)).rejects.toThrow(
              `injected issue 792 ${batchCase.kind} ${failure.stage} failure`
            )
          } finally {
            await dbPool.query(
              `DROP TRIGGER IF EXISTS ${triggerName} ON ${failure.table};
               DROP FUNCTION IF EXISTS ${functionName}();`
            )
          }
          await settleListener()
          expect(await counts(batchCase, resourceId, requestId)).toEqual({
            mutations: '0',
            audits: '0',
            events: '0',
          })
          expect(notifications).toHaveLength(committedNotificationCount)
        }
      }
    } finally {
      await listener.query('UNLISTEN gfs_perm_invalidate')
      listener.release()
    }
  }, 60_000)

  it('resolves host intent tenant attribution from the canonical event stream', async () => {
    const operationId = randomUUID()
    const eventId = randomUUID()
    const operatorSub = randomUUID()
    const targetRef = 'mcp-host/tenant-stream-host'
    const namespace = 'mcp-host'
    const occurredAt = '2026-07-16T12:00:00.000Z'
    const service = new AdministrativeEventService({
      transaction: async work => {
        const client = await dbPool.connect()
        try {
          await client.query('BEGIN')
          const result = await work(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
      now: () => new Date(occurredAt),
      newEventId: () => eventId,
    })

    await service.append(
      {
        kind: 'control_api_local',
        sourceService: 'control-api',
        serviceSub: 'host-administration',
        credentialId: 'control-api-local',
        allowedKinds: ['intent'],
      },
      {
        action: 'host_mutation',
        outcome: 'attempted',
        operatorSub,
        operationId,
        relatedRunId: null,
        requestId: 'real-pg-host-intent-tenant',
        targetType: 'host',
        targetRef,
        environment: 'test',
        tenantId: 'tenant-real-pg',
        teamId: 'team-real-pg',
        namespace,
        sourceAuditRef: null,
      },
      {
        kind: 'intent',
        sourceEventId: `real-pg-host-intent:${operationId}`,
        occurredAt,
        reasonCode: 'host_update_requested',
        payload: { resource_class: 'Host', status: 'requested' },
      }
    )

    const schemaContract = await dbPool.query<{
      tenant_nullable_without_default: boolean
      canonical_unique: boolean
      administrative_trigger: boolean
      stream_trigger: boolean
    }>(`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'governed_event_stream'
           AND column_name = 'tenant_id'
           AND data_type = 'text'
           AND is_nullable = 'YES'
           AND column_default IS NULL
      ) AS tenant_nullable_without_default,
      EXISTS (
        SELECT 1
          FROM pg_constraint relation_constraint
         WHERE relation_constraint.conrelid = 'public.governed_event_stream'::regclass
           AND relation_constraint.contype = 'u'
           AND relation_constraint.conkey = ARRAY[
             (SELECT attnum
                FROM pg_attribute
               WHERE attrelid = relation_constraint.conrelid
                 AND attname = 'event_family'),
             (SELECT attnum
                FROM pg_attribute
               WHERE attrelid = relation_constraint.conrelid
                 AND attname = 'event_id')
           ]::smallint[]
      ) AS canonical_unique,
      EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgrelid = 'public.administrative_events'::regclass
           AND tgname = 'governed_administrative_event_stream_integrity'
           AND tgenabled = 'O'
           AND tgfoid = 'public.governed_trace_assert_stream_integrity()'::regprocedure
           AND tgconstraint <> 0
           AND tgdeferrable
           AND tginitdeferred
           AND tgtype = 13
      ) AS administrative_trigger,
      EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgrelid = 'public.governed_event_stream'::regclass
           AND tgname = 'governed_event_stream_family_integrity'
           AND tgenabled = 'O'
           AND tgfoid = 'public.governed_trace_assert_stream_integrity()'::regprocedure
           AND tgconstraint <> 0
           AND tgdeferrable
           AND tginitdeferred
           AND tgtype = 13
      ) AS stream_trigger
    `)
    expect(schemaContract.rows).toEqual([
      {
        tenant_nullable_without_default: true,
        canonical_unique: true,
        administrative_trigger: true,
        stream_trigger: true,
      },
    ])

    const runtimeClient = await dbPool.connect()
    try {
      await runtimeClient.query('BEGIN')
      await runtimeClient.query('SET LOCAL ROLE control_api_runtime')
      const activeRole = await runtimeClient.query<{ current_user: string }>('SELECT current_user')
      expect(activeRole.rows).toEqual([{ current_user: 'control_api_runtime' }])

      const lookup = new PostgresAdministrativeIntentLookup(runtimeClient)
      await expect(lookup.findHostIntent({ operationId, targetRef, namespace })).resolves.toEqual(
        expect.objectContaining({
          operatorSub,
          requestId: 'real-pg-host-intent-tenant',
          environment: 'test',
          tenantId: 'tenant-real-pg',
          teamId: 'team-real-pg',
        })
      )
    } finally {
      await runtimeClient.query('ROLLBACK')
      runtimeClient.release()
    }
  })

  it('persists permission changes and governed administrative identity atomically', async () => {
    const operator = await dbPool.query<{ id: string; username: string }>(
      `SELECT id::text, username
         FROM control_admin_users
        WHERE status = 'active'
     ORDER BY created_at, id
        LIMIT 1`
    )
    const operatorId = operator.rows[0]!.id
    const operatorName = operator.rows[0]!.username
    const targetUserId = randomUUID()
    await dbPool.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, $2, 'Trace Target')`,
      [targetUserId, `trace-target-${targetUserId}@example.test`]
    )
    await dbPool.query(
      `INSERT INTO profiles (user_id, display_name)
       VALUES ($1, 'Trace Target')`,
      [targetUserId]
    )

    const committedOperationId = randomUUID()
    const committed = await dbPool.connect()
    try {
      await committed.query('BEGIN')
      await committed.query(
        `INSERT INTO user_agents (user_id, agent_name) VALUES ($1, 'trace-integration-agent')`,
        [targetUserId]
      )
      await runWithAdministrativeRequestContext(
        { operatorSub: operatorId, requestId: 'real-pg-permission-commit' },
        () =>
          appendControlApiPermissionEventsInTransaction(committed, {
            operatorSub: operatorId,
            operationId: committedOperationId,
            changes: [
              {
                action: 'grant',
                resourceClass: 'agent_access',
                resourceRef: 'agent:trace-integration-agent',
                subject: { kind: 'user', id: targetUserId },
              },
            ],
          })
      )
      await committed.query('COMMIT')
    } catch (error) {
      await committed.query('ROLLBACK')
      throw error
    } finally {
      committed.release()
    }

    const persisted = await dbPool.query<{
      action: string
      operator_user_id: string
      target_user_id: string
      operator_name: string
      target_name: string
      authorization_decision: string
      payload_metadata: Record<string, unknown>
      stream_sequence: string
    }>(
      `SELECT event.action,
              event.operator_user_id::text,
              event.target_user_id::text,
              operator_admin.username AS operator_name,
              target_profile.display_name AS target_name,
              event.authorization_decision,
              event.payload_metadata,
              stream.stream_sequence::text
         FROM administrative_events event
         JOIN governed_event_stream stream
           ON stream.event_family = 'administrative' AND stream.event_id = event.event_id
         JOIN control_admin_users operator_admin ON operator_admin.id = event.operator_user_id
         JOIN profiles target_profile ON target_profile.user_id = event.target_user_id
        WHERE event.operation_id = $1`,
      [committedOperationId]
    )
    expect(persisted.rows).toEqual([
      expect.objectContaining({
        action: 'permission_grant',
        operator_user_id: operatorId,
        target_user_id: targetUserId,
        operator_name: operatorName,
        target_name: 'Trace Target',
        authorization_decision: 'allow',
        payload_metadata: expect.objectContaining({
          resource_class: 'agent_access',
          status: 'granted',
        }),
        stream_sequence: expect.stringMatching(/^[1-9][0-9]*$/),
      }),
    ])

    const readRepository = new PostgresGovernedEventReadRepository(dbPool)
    const highWatermark = await readRepository.captureHighWatermark()
    const readRows = await readRepository.readAfter({
      scope: { kind: 'stream' },
      families: ['administrative'],
      order: 'oldest',
      afterSequence: '0',
      highWatermark,
      limit: 200,
      occurredFrom: null,
      occurredTo: null,
      filters: {
        action: ['permission_grant'],
        targetUserId: [targetUserId],
      },
    })
    expect(readRows).toEqual([
      expect.objectContaining({
        eventType: 'permission_grant',
        operatorPrincipalId: operatorId,
        operatorPrincipalKind: 'control_admin',
        operatorDisplayName: operatorName,
        targetUserId,
        targetUserDisplayName: 'Trace Target',
        teamId: null,
        payload: expect.objectContaining({ resource_class: 'agent_access' }),
      }),
    ])

    const targetTeamId = randomUUID()
    await dbPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'Trace Operations')`, [
      targetTeamId,
    ])
    const teamOperationId = randomUUID()
    const teamChange = await dbPool.connect()
    try {
      await teamChange.query('BEGIN')
      await appendControlApiPermissionEventsInTransaction(teamChange, {
        operatorSub: operatorId,
        operatorKind: 'control_admin',
        operationId: teamOperationId,
        changes: [
          {
            action: 'grant',
            resourceClass: 'workflow_approval_target',
            resourceRef: 'workflow_recipe:sandbox-recipes/trace-team-target',
            subject: { kind: 'team', id: targetTeamId },
          },
        ],
      })
      await teamChange.query('COMMIT')
    } catch (error) {
      await teamChange.query('ROLLBACK')
      throw error
    } finally {
      teamChange.release()
    }
    const teamRows = await readRepository.readAfter({
      scope: { kind: 'stream' },
      families: ['administrative'],
      order: 'oldest',
      afterSequence: '0',
      highWatermark: await readRepository.captureHighWatermark(),
      limit: 200,
      occurredFrom: null,
      occurredTo: null,
      filters: { teamId: [targetTeamId] },
    })
    expect(teamRows).toEqual([
      expect.objectContaining({
        eventType: 'permission_grant',
        teamId: targetTeamId,
        targetTeamDisplayName: 'Trace Operations',
        targetUserId: null,
      }),
    ])

    const hostOperationId = randomUUID()
    const hostChange = await dbPool.connect()
    try {
      await hostChange.query('BEGIN')
      await appendControlApiPermissionEventsInTransaction(hostChange, {
        operatorSub: operatorId,
        operatorKind: 'control_admin',
        operationId: hostOperationId,
        changes: [
          {
            action: 'grant',
            resourceClass: 'gfs_folder_grant',
            resourceRef: 'gfs://main/trace-host-target',
            subject: {
              kind: 'service',
              id: 'host:1st:mcp-host/chatllm',
              principalKind: 'host',
            },
          },
        ],
      })
      await hostChange.query('COMMIT')
    } catch (error) {
      await hostChange.query('ROLLBACK')
      throw error
    } finally {
      hostChange.release()
    }
    const hostTarget = await dbPool.query<{
      payload_metadata: Record<string, unknown>
    }>(
      `SELECT payload_metadata
         FROM administrative_events
        WHERE operation_id = $1`,
      [hostOperationId]
    )
    expect(hostTarget.rows).toEqual([
      {
        payload_metadata: expect.objectContaining({
          target_principal_kind: 'host',
          target_principal_ref: 'host:1st:mcp-host/chatllm',
        }),
      },
    ])

    const deletedAdminId = randomUUID()
    const deletionOperationId = randomUUID()
    const deletionEventId = randomUUID()
    const deletion = await dbPool.connect()
    try {
      await deletion.query('BEGIN')
      const service = new AdministrativeEventService({
        transaction: async () => {
          throw new Error('real PostgreSQL deletion event must use the caller transaction')
        },
        now: () => new Date('2026-07-14T12:00:00.000Z'),
        newEventId: () => deletionEventId,
      })
      await service.appendInTransaction(
        deletion,
        CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
        {
          action: 'control_admin_deleted',
          outcome: 'committed',
          operatorSub: operatorId,
          operatorUserId: operatorId,
          operationId: deletionOperationId,
          relatedRunId: null,
          requestId: 'real-pg-control-admin-delete',
          targetType: 'control_admin',
          targetRef: `control_admin:${deletedAdminId}`,
          environment: 'test',
          tenantId: null,
          teamId: null,
          namespace: null,
          sourceAuditRef: `control_admin_deletion_audit:${deletionOperationId}`,
          identityIssuer: config.adminJwtIssuer,
          resourceAud: config.adminJwtAudience,
          effectiveScopes: [],
          authorizationDecision: 'allow',
          decisionActorSub: operatorId,
          targetIdentityIssuer: config.adminJwtIssuer,
          targetHumanSub: deletedAdminId,
          targetUserId: null,
        },
        {
          kind: 'service_action',
          sourceEventId: `control_admin_deletion_audit:${deletionOperationId}`,
          occurredAt: '2026-07-14T12:00:00.000Z',
          reasonCode: 'control_admin_access_revoked',
          payload: {
            resource_class: 'control_admin_access',
            status: 'revoked',
            target_label: 'deleted_admin',
          },
        }
      )
      await deletion.query('COMMIT')
    } catch (error) {
      await deletion.query('ROLLBACK')
      throw error
    } finally {
      deletion.release()
    }
    const deletedAdminEvent = await dbPool.query<{
      action: string
      target_type: string
      target_human_sub: string
      target_label: string
      stream_count: string
    }>(
      `SELECT event.action,
              event.target_type,
              event.target_human_sub,
              event.payload_metadata->>'target_label' AS target_label,
              COUNT(stream.event_id)::text AS stream_count
         FROM administrative_events event
         JOIN governed_event_stream stream
           ON stream.event_family = 'administrative' AND stream.event_id = event.event_id
        WHERE event.event_id = $1
        GROUP BY event.event_id`,
      [deletionEventId]
    )
    expect(deletedAdminEvent.rows).toEqual([
      {
        action: 'control_admin_deleted',
        target_type: 'control_admin',
        target_human_sub: deletedAdminId,
        target_label: 'deleted_admin',
        stream_count: '1',
      },
    ])

    const rolledBackOperationId = randomUUID()
    const rolledBack = await dbPool.connect()
    try {
      await rolledBack.query('BEGIN')
      await rolledBack.query(
        `INSERT INTO user_agents (user_id, agent_name) VALUES ($1, 'trace-rollback-agent')`,
        [targetUserId]
      )
      await appendControlApiPermissionEventsInTransaction(rolledBack, {
        operatorSub: operatorId,
        operationId: rolledBackOperationId,
        changes: [
          {
            action: 'grant',
            resourceClass: 'agent_access',
            resourceRef: 'agent:trace-rollback-agent',
            subject: { kind: 'user', id: targetUserId },
          },
        ],
      })
      await rolledBack.query('ROLLBACK')
    } finally {
      rolledBack.release()
    }
    const rollbackState = await dbPool.query<{ links: string; events: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM user_agents WHERE agent_name = 'trace-rollback-agent') AS links,
         (SELECT COUNT(*)::text FROM administrative_events WHERE operation_id = $1) AS events`,
      [rolledBackOperationId]
    )
    expect(rollbackState.rows[0]).toEqual({ links: '0', events: '0' })
  })

  it('keeps same-named tools from distinct kinds and sources separate', async () => {
    const runId = randomUUID()
    const hostRef = `tool-collision-${randomUUID()}`
    const sessionId = `session-${randomUUID()}`
    const toolName = 'shared-tool-name'
    const firstSourceEventId = randomUUID()
    const secondSourceEventId = randomUUID()

    await dbPool.query(
      `WITH fixture(source_event_id, idempotency_key, tool_kind, tool_source_ref,
                    payload_sha256, occurred_at) AS (
         VALUES
           ($4::text, $5::text, 'internal_tool'::text, 'mcp-host:internal'::text,
            $6::text, '2026-07-14T14:00:00.000Z'::timestamptz),
           ($7::text, $8::text, 'mcp_server_tool'::text, 'weather-server'::text,
            $9::text, '2026-07-14T14:00:01.000Z'::timestamptz)
       ), inserted AS (
         INSERT INTO agent_run_events (
           source_kind, source_service, source_event_id, idempotency_key, run_id, session_id,
           span_id, origin, event_type, outcome, agent_sub, effective_scopes, decision,
           host_ref, recipe_namespace, recipe_name, payload_metadata, payload_sha256, occurred_at
         )
         SELECT 'mcp_host_runtime', 'mcp-host', source_event_id, idempotency_key, $1::uuid, $2,
                'span-' || tool_kind, 'direct_chat', 'tool_call', 'succeeded',
                'mcp-host:' || $3, ARRAY[]::text[], 'not_applicable', $3,
                'mcp-host', 'standalone',
                jsonb_build_object(
                  'tool_name', $10::text,
                  'tool_kind', tool_kind,
                  'tool_source_ref', tool_source_ref
                ),
                payload_sha256, occurred_at
           FROM fixture
         RETURNING event_id, occurred_at, ingested_at, run_id, payload_sha256
       )
       INSERT INTO governed_event_stream
         (event_family, event_id, schema_version, occurred_at, ingested_at,
          environment, run_id, payload_sha256)
       SELECT 'agent_run', event_id, 1, occurred_at, ingested_at,
              'integration', run_id, payload_sha256
         FROM inserted`,
      [
        runId,
        sessionId,
        hostRef,
        firstSourceEventId,
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        secondSourceEventId,
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        toolName,
      ]
    )

    const replay = new PostgresGovernedSessionReplayRepository(dbPool)
    const highWatermark = await replay.captureHighWatermark()

    await expect(replay.readTools(hostRef, sessionId, highWatermark)).resolves.toEqual([
      expect.objectContaining({
        toolName,
        toolKind: 'mcp_server_tool',
        toolSourceRef: 'weather-server',
        totalCalls: 1,
        succeeded: 1,
        failed: 0,
      }),
      expect.objectContaining({
        toolName,
        toolKind: 'internal_tool',
        toolSourceRef: 'mcp-host:internal',
        totalCalls: 1,
        succeeded: 1,
        failed: 0,
      }),
    ])
  })

  it('paginates replay sessions from PostgreSQL in both orders with stable timestamp ties', async () => {
    const prefix = `replay-pagination-${randomUUID()}`
    const earlier = '2026-07-14T16:00:00.000Z'
    const later = '2026-07-14T17:00:00.000Z'
    const fixtures = [
      { hostRef: `${prefix}-a`, sessionId: 'session-a', occurredAt: earlier },
      { hostRef: `${prefix}-b`, sessionId: 'session-b', occurredAt: earlier },
      { hostRef: `${prefix}-z`, sessionId: 'session-z', occurredAt: later },
    ]

    for (const fixture of fixtures) {
      await dbPool.query(
        `WITH inserted AS (
           INSERT INTO agent_run_events (
             source_kind, source_service, source_event_id, idempotency_key, run_id, session_id,
             span_id, origin, event_type, outcome, agent_sub, effective_scopes, decision,
             host_ref, recipe_namespace, recipe_name, payload_metadata, payload_sha256, occurred_at
           ) VALUES (
             'mcp_host_runtime', 'mcp-host', $1, $2, $3::uuid, $4,
             $5, 'direct_chat', 'run_start', 'started',
             'mcp-host:test', ARRAY[]::text[], 'not_applicable', $6,
             'mcp-host', 'standalone', '{}'::jsonb, $7, $8::timestamptz
           )
           RETURNING event_id, occurred_at, ingested_at, run_id, payload_sha256
         )
         INSERT INTO governed_event_stream
           (event_family, event_id, schema_version, occurred_at, ingested_at,
            environment, run_id, payload_sha256)
         SELECT 'agent_run', event_id, 1, occurred_at, ingested_at,
                'integration', run_id, payload_sha256
           FROM inserted`,
        [
          randomUUID(),
          randomBytes(32).toString('hex'),
          randomUUID(),
          fixture.sessionId,
          `span-${fixture.sessionId}`,
          fixture.hostRef,
          randomBytes(32).toString('hex'),
          fixture.occurredAt,
        ]
      )
    }

    const replay = new PostgresGovernedSessionReplayRepository(dbPool)
    const highWatermark = await replay.captureHighWatermark()
    const filters = {
      occurredFrom: '2026-07-14T15:59:00.000Z',
      occurredTo: '2026-07-14T17:01:00.000Z',
      outcome: [],
      sourceService: [],
      sessionId: [],
      hostRef: fixtures.map(fixture => fixture.hostRef),
      humanUserId: [],
      agentSub: [],
      origin: [],
      toolName: [],
      approvalState: [],
    }

    for (const scenario of [
      {
        order: 'latest' as const,
        expected: [`${prefix}-z/session-z`, `${prefix}-b/session-b`, `${prefix}-a/session-a`],
      },
      {
        order: 'oldest' as const,
        expected: [`${prefix}-a/session-a`, `${prefix}-b/session-b`, `${prefix}-z/session-z`],
      },
    ]) {
      const first = await replay.list({
        filters,
        highWatermark,
        after: null,
        limit: 2,
        promptState: 'disabled',
        order: scenario.order,
      })
      const second = await replay.list({
        filters,
        highWatermark,
        after: first.anchors.at(-1)!,
        limit: 2,
        promptState: 'disabled',
        order: scenario.order,
      })
      const actual = [...first.summaries, ...second.summaries].map(
        item => `${item.hostRef}/${item.sessionId}`
      )
      expect(actual).toEqual(scenario.expected)
      expect(new Set(actual).size).toBe(actual.length)
    }
  })

  it('persists token usage atomically and serves session totals from the governed ledger', async () => {
    const runAsControlApiRuntime = async <T>(work: (client: PoolClient) => Promise<T>) => {
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE control_api_runtime')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    const bindingService = new DirectRunAttributionBindingService(runAsControlApiRuntime)
    const hostRef = 'runtime-token-persistence'
    const sessionId = 'session-token-persistence'
    const runId = randomUUID()
    await bindingService.bind({
      runId,
      hostRef,
      hostNamespace: null,
      sessionId,
      origin: 'direct_chat',
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: 'subject-token-persistence',
      userId: null,
      teamId: null,
    })

    const requestId = randomUUID()
    const rawUsage = {
      request_id: requestId,
      ts: '2026-07-14T15:00:00.000Z',
      run_id: runId,
      host_ref: hostRef,
      context_ref: 'not-released',
      team_id: null,
      provider: 'openai',
      model: 'gpt-5',
      llm_secret_name: 'not-released',
      source_kind: 'desktop',
      user_id: null,
      sender: 'not-released',
      channel_type: 'not-released',
      recipe_name: null,
      cron_job_id: null,
      task_id: null,
      iteration: 3,
      input_tokens: 321,
      output_tokens: 123,
      cache_read_tokens: 45,
      cache_write_tokens: 6,
    }
    const persistUsage = () =>
      runAsControlApiRuntime(async client => {
        const ingest = await ingestUsageEventsInTransaction([rawUsage], client)
        const projected = await projectAcceptedUsageEvents(
          client,
          ingest.acceptedEvents,
          new Map(),
          {
            recipeNamespace: 'mcp-host',
            recipeName: 'standalone',
            hostRef,
            environment: 'integration',
          }
        )
        return { ingest: ingest.result, projected }
      })

    await expect(persistUsage()).resolves.toEqual({
      ingest: { accepted: 1, duplicates: 0, rejected: 0 },
      projected: 1,
    })
    await expect(persistUsage()).resolves.toEqual({
      ingest: { accepted: 0, duplicates: 1, rejected: 0 },
      projected: 0,
    })

    const persisted = await dbPool.query<{
      usage_count: string
      family_count: string
      stream_count: string
      payload_metadata: Record<string, unknown>
      identity_issuer: string | null
      actor_human_sub: string | null
      session_id: string | null
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM usage_events WHERE request_id = $1::uuid) AS usage_count,
         (SELECT COUNT(*)::text FROM agent_run_events WHERE source_event_id = $1::text) AS family_count,
         (SELECT COUNT(*)::text
            FROM governed_event_stream stream
            JOIN agent_run_events event
              ON stream.event_family = 'agent_run' AND stream.event_id = event.event_id
           WHERE event.source_event_id = $1::text) AS stream_count,
         event.payload_metadata,
         event.identity_issuer,
         event.actor_human_sub,
         event.session_id
       FROM agent_run_events event
      WHERE event.source_event_id = $1::text`,
      [requestId]
    )
    expect(persisted.rows[0]).toMatchObject({
      usage_count: '1',
      family_count: '1',
      stream_count: '1',
      identity_issuer: 'https://issuer.example.test',
      actor_human_sub: 'subject-token-persistence',
      session_id: sessionId,
      payload_metadata: {
        provider: 'openai',
        model: 'gpt-5',
        source_kind: 'desktop',
        input_tokens: 321,
        output_tokens: 123,
        cache_read_tokens: 45,
        cache_write_tokens: 6,
        cache_tokens_reported: true,
        iteration: 3,
      },
    })
    expect(JSON.stringify(persisted.rows[0]?.payload_metadata)).not.toContain('not-released')

    const replay = new PostgresGovernedSessionReplayRepository(dbPool)
    const highWatermark = await replay.captureHighWatermark()
    const page = await replay.list({
      filters: {
        occurredFrom: '2026-07-14T14:59:00.000Z',
        occurredTo: '2026-07-14T15:01:00.000Z',
        outcome: [],
        sourceService: [],
        sessionId: [sessionId],
        hostRef: [hostRef],
        humanUserId: [],
        agentSub: [],
        origin: [],
        toolName: [],
        approvalState: [],
      },
      highWatermark,
      after: null,
      limit: 10,
      promptState: 'disabled',
      order: 'latest',
    })
    expect(page.summaries).toHaveLength(1)
    expect(page.summaries[0]).toMatchObject({
      hostRef,
      sessionId,
      human: {
        status: 'verified',
        subject: 'subject-token-persistence',
        identityIssuer: 'https://issuer.example.test',
      },
      tokenUsage: {
        meteredCalls: 1,
        inputTokens: 321,
        outputTokens: 123,
        cacheReadTokens: 45,
        cacheWriteTokens: 6,
        cacheReporting: 'complete',
        totalTokens: 444,
      },
    })
    await expect(replay.readTokenUsagePoints(hostRef, sessionId, highWatermark)).resolves.toEqual({
      pointsTruncated: false,
      points: [
        expect.objectContaining({
          runId,
          provider: 'openai',
          model: 'gpt-5',
          sourceKind: 'desktop',
          iteration: 3,
          inputTokens: 321,
          outputTokens: 123,
          cacheReadTokens: 45,
          cacheWriteTokens: 6,
          cacheTokensReported: true,
        }),
      ],
    })

    const conflictingRunId = randomUUID()
    const conflictingRequestId = randomUUID()
    await bindingService.bind({
      runId: conflictingRunId,
      hostRef,
      hostNamespace: null,
      sessionId: 'bound-session',
      origin: 'direct_chat',
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: 'subject-token-persistence',
      userId: null,
      teamId: null,
    })
    const conflictingRootId = randomUUID()
    await dbPool.query(
      `WITH inserted AS (
         INSERT INTO agent_run_events (
           event_id, source_kind, source_service, source_event_id, idempotency_key,
           run_id, session_id, span_id, origin, event_type, outcome, agent_sub,
           effective_scopes, decision, host_ref, recipe_namespace, recipe_name,
           payload_metadata, payload_sha256, occurred_at
         ) VALUES (
           $1, 'mcp_host_runtime', 'mcp-host', $2, $3, $4, 'conflicting-session',
           $5, 'direct_chat', 'run_start', 'started', $6, ARRAY[]::text[],
           'not_applicable', $7, 'mcp-host', 'standalone', '{}'::jsonb, $8,
           '2026-07-14T15:02:00.000Z'
         )
         RETURNING event_id, occurred_at, ingested_at, run_id, payload_sha256
       )
       INSERT INTO governed_event_stream (
         event_family, event_id, schema_version, occurred_at, ingested_at,
         environment, run_id, payload_sha256
       )
       SELECT 'agent_run', event_id, 1, occurred_at, ingested_at,
              'integration', run_id, payload_sha256
         FROM inserted`,
      [
        conflictingRootId,
        `conflicting-root-${conflictingRunId}`,
        'a'.repeat(64),
        conflictingRunId,
        'b'.repeat(64),
        `mcp-host:${hostRef}`,
        hostRef,
        'c'.repeat(64),
      ]
    )
    const conflictingUsage = {
      ...rawUsage,
      request_id: conflictingRequestId,
      run_id: conflictingRunId,
      ts: '2026-07-14T15:02:01.000Z',
    }
    await expect(
      runAsControlApiRuntime(async client => {
        const ingest = await ingestUsageEventsInTransaction([conflictingUsage], client)
        return projectAcceptedUsageEvents(client, ingest.acceptedEvents, new Map(), {
          recipeNamespace: 'mcp-host',
          recipeName: 'standalone',
          hostRef,
          environment: 'integration',
        })
      })
    ).rejects.toBeInstanceOf(DirectRunBindingConflictError)
    const rolledBack = await dbPool.query<{
      usage_count: string
      trace_count: string
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM usage_events WHERE request_id = $1::uuid) AS usage_count,
         (SELECT COUNT(*)::text FROM agent_run_events WHERE source_event_id = $1::text) AS trace_count`,
      [conflictingRequestId]
    )
    expect(rolledBack.rows[0]).toEqual({ usage_count: '0', trace_count: '0' })
  })

  it('#654 roundtrips capability through CRUD and the enabled ConfigMap projection', async () => {
    const { initDb } = await import('../src/db.js')
    const {
      createAllowedModel,
      getAllowedModel,
      updateAllowedModel,
      listEnabledGroupedByProvider,
    } = await import('../src/services/llmAllowedModels.js')
    await initDb({ connect: () => dbPool.connect() })
    const db = await dbPool.connect()
    await db.query('BEGIN')
    const provider = `image-roundtrip-${randomBytes(4).toString('hex')}`
    const capability = {
      state: 'supported' as const,
      evidence: {
        source: 'curated' as const,
        reference: 'evidence:image-input-roundtrip',
        checkedAt: '2026-09-16T00:00:00.000Z',
      },
    }
    try {
      const created = await createAllowedModel(
        {
          provider,
          model: 'visual',
          enabled: true,
          image_input: capability,
        },
        'integration-test',
        db
      )
      expect((await getAllowedModel(created.id, db))?.image_input).toEqual(capability)
      expect((await listEnabledGroupedByProvider(db))[provider]).toEqual([
        { model: 'visual', imageInput: capability },
      ])
      const renamed = await updateAllowedModel(
        created.id,
        { model: 'renamed' },
        'integration-test',
        db
      )
      expect(renamed).toMatchObject({
        enabled: true,
        image_input: { state: 'unknown' },
      })
      expect((await listEnabledGroupedByProvider(db))[provider]).toEqual([{ model: 'renamed' }])
      await updateAllowedModel(created.id, { image_input: capability }, 'integration-test', db)
      const cleared = await updateAllowedModel(
        created.id,
        { image_input: null },
        'integration-test',
        db
      )
      expect(cleared).toMatchObject({
        enabled: true,
        image_input: { state: 'unknown' },
      })
      expect((await listEnabledGroupedByProvider(db))[provider]).toEqual([{ model: 'renamed' }])
    } finally {
      await db.query('ROLLBACK')
      db.release()
    }
  })

  it('#654 rejects malformed image_input payloads in the database, not only in the service', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => dbPool.connect() })

    const provider = `image-input-654-${randomBytes(4).toString('hex')}`
    const model = 'migration-probe'
    await dbPool.query(
      `INSERT INTO llm_allowed_models (provider, model, enabled) VALUES ($1, $2, false)`,
      [provider, model]
    )
    const setImageInput = (payload: string | null) =>
      dbPool.query(
        `UPDATE llm_allowed_models
            SET image_input = $1::jsonb
          WHERE provider = $2 AND model = $3`,
        [payload, provider, model]
      )

    try {
      // The CHECK must be TOTAL, because a CHECK accepts NULL. With only
      // `jsonb_typeof(...) = 'object' AND image_input->>'state' IN (...)`, `{}`
      // evaluates to TRUE AND NULL = NULL and the row is ACCEPTED; and
      // `{"state": null}` satisfies `? 'state'` while `->>` is still NULL.
      // Each of these is a malformed payload the service must never be able to
      // persist through any writer, so the database is the backstop.
      for (const malformed of [
        '{}',
        '{"state":null}',
        '{"state":"bogus"}',
        '{"state":5}',
        '[]',
        '"supported"',
        'null',
      ]) {
        await expect(setImageInput(malformed)).rejects.toMatchObject({
          code: '23514',
        })
      }

      // The legacy NULL and every canonical state stay accepted.
      await expect(setImageInput(null)).resolves.toBeDefined()
      for (const state of ['supported', 'unsupported', 'unknown']) {
        await expect(setImageInput(JSON.stringify({ state }))).resolves.toBeDefined()
      }
      const stored = await dbPool.query<{ image_input: unknown }>(
        `SELECT image_input FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
        [provider, model]
      )
      expect(stored.rows[0].image_input).toEqual({ state: 'unknown' })
    } finally {
      await dbPool.query(`DELETE FROM llm_allowed_models WHERE provider = $1`, [provider])
    }
  })
})
