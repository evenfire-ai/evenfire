import type { DbClient } from '../db.js'
import { migrationSessionBoundsSql } from './migrationExecutionPolicy.js'
import { hasPostSchemaOnlineIndexes, preparePr1Migration } from './pr1OnlineIndexPlan.js'

export const PR1_MIGRATION_VERSIONS = Object.freeze([
  '0137_user_access_foundation',
  '0138_legacy_password_security_epoch_backfill',
] as const)

// The one bound between initDb's single dev batch and this runner: every migration
// up to and including this version runs in the dev batch (db.ts imports it), and
// this runner owns only the PR1 and PR2 versions that follow it. Until this change merges,
// a dev merge that brings new migrations moves this bound to dev's last version and
// renumbers PR1_MIGRATION_VERSIONS above it, and every dev merge moves the latestDev
// producer in tests/contracts/certification-inputs.json to dev's tip. After it merges
// the bound stays: a later migration adds its version to the list this runner
// applies, or initDb throws "Unclassified post-dev migrations".
export const LAST_DEV_MIGRATION_VERSION = '0136_llm_catalog_dismissed_backfill'

// Migration names that earlier heads of this change recorded under other
// four-character prefixes (decimal such as `0126` or hexadecimal such as
// `010a`; some below 0130, and `user_access_foundation` under the prefix `0131`,
// in some heads with a larger body). The name after the prefix is the identity.
const EARLIER_PR1_MIGRATION_NAMES: readonly string[] = Object.freeze([
  'user_access_foundation',
  'invitation_delivery_commands',
  'catalog_utf8_ordering',
  'composable_catalog_revisions',
  'gfs_catalog_revision_components',
  'legacy_password_security_epoch_backfill',
  'user_access_foundation_definer_temp_shadow_hardening',
  'authorization_revision_delete_compatibility',
])

// Tables that only earlier heads created. Their trigger functions are found by
// name prefix: a trigger cannot outlive its function.
const EARLIER_PR1_TABLES = Object.freeze([
  'authorization_catalog_environment',
  'authorization_catalog_revision',
  'authorization_catalog_writer_components',
  'authorization_resource_revisions',
  'authorization_team_revisions',
  'authorization_user_revisions',
  'invitation_delivery_commands',
  'operational_catalog_source_state',
  'operational_relationships_staging',
  'operational_resource_index',
  'operational_resource_index_staging',
  'operational_resource_relationships',
])

const EARLIER_PR1_HEAD_CLEANUP_REFERENCE =
  'see docs/deploy/user-access-foundation-upgrade.md#databases-that-ran-an-earlier-head-of-this-change'

export const PR2_MIGRATION_VERSIONS = Object.freeze([
  '0137_workflow_authority_bindings',
  '0138_gfs_upload_authority_bindings',
  '0139_pr2_readiness_evidence',
  '0140_pr2_runtime_privileges',
  '0141_workflow_recipe_authority_entity',
  '0142_workflow_run_failure_reason',
  '0143_r31_runtime_behavior_sources',
  '0145_workflow_authorization_pause',
])

export const RUNNER_MIGRATION_VERSIONS = Object.freeze([
  ...PR1_MIGRATION_VERSIONS,
  ...PR2_MIGRATION_VERSIONS,
] as const)

export type MigrationDescriptor = {
  version: string
  legacyVersions?: readonly string[]
  apply: (db: DbClient) => Promise<void>
}

type ApplyPendingPr1MigrationsInput = {
  db: DbClient
  migrations: readonly MigrationDescriptor[]
  appliedVersions: Set<string>
  recordMigration: (db: DbClient, version: string) => Promise<void>
}

async function runBoundedTransaction(db: DbClient, work: () => Promise<void>): Promise<void> {
  let started = false
  try {
    await db.query('BEGIN')
    started = true
    for (const sql of migrationSessionBoundsSql(true)) {
      await db.query(sql)
    }
    await work()
    await db.query('COMMIT')
  } catch (error) {
    if (started) {
      try {
        await db.query('ROLLBACK')
      } catch {
        // The caller destroys the migration session after any failed unit.
      }
    }
    throw error
  }
}

/**
 * Rejects a database that ran an earlier head of this change. Such a database
 * holds triggers whose writers no longer take the matching pre-locks, so it is
 * cleaned up by an operator (the referenced SQL), never automatically.
 *
 * Retirement: earlier heads ran only on branch profiles and local databases
 * (docs/deploy/user-access-foundation-upgrade.md). Remove this guard, the two
 * EARLIER_PR1_* lists, the cleanup SQL, that doc section and their tests in one
 * commit once both hold: this release's migration Job has completed on
 * clerum-dev and production, and no branch registers an
 * EARLIER_PR1_MIGRATION_NAMES migration other than PR1_MIGRATION_VERSIONS
 * (today #594, until it is reconciled with this change). The same commit removes
 * the upgrade tests from the pinned producers in
 * test/migrationExecutionPolicy.realPostgres.integration.test.ts and the producers
 * in tests/contracts/certification-inputs.json, unless a later change owns them:
 * once this change is on dev, latestDev stays at the last dev commit before it.
 * Remove it sooner, in
 * the same commit, if a migration creates a function or table this probe
 * matches: the guard runs on every initDb and would stop every later Job.
 * If PR1_MIGRATION_VERSIONS are renumbered after a shared database recorded
 * them, keep the old versions as legacyVersions, or this guard rejects it.
 */
async function assertNoEarlierPr1Head(
  db: DbClient,
  appliedVersions: ReadonlySet<string>,
  registeredVersions: ReadonlySet<string>
): Promise<void> {
  const versions = [...appliedVersions]
    .filter(version => {
      const name = /^[0-9a-f]{4}_(.+)$/.exec(version)?.[1]
      return (
        name !== undefined &&
        EARLIER_PR1_MIGRATION_NAMES.includes(name) &&
        !registeredVersions.has(version)
      )
    })
    .sort()
  const result = await db.query(
    `/* pr1-earlier-head-guard */
     SELECT 'function' AS kind, fn.oid::regprocedure::text AS name
       FROM pg_proc fn
       JOIN pg_namespace fn_ns ON fn_ns.oid = fn.pronamespace
      WHERE fn_ns.nspname = current_schema()
        AND (fn.proname LIKE 'authorization\\_bump\\_%' ESCAPE '\\'
          OR fn.proname LIKE 'authorization\\_prelock\\_%' ESCAPE '\\'
          OR fn.proname = 'catalog_utf8_bytes')
     UNION ALL
     SELECT 'table' AS kind, rel.relname::text AS name
       FROM pg_class rel
       JOIN pg_namespace rel_ns ON rel_ns.oid = rel.relnamespace
      WHERE rel_ns.nspname = current_schema()
        AND rel.relname = ANY($1::text[])
      ORDER BY kind, name`,
    [EARLIER_PR1_TABLES]
  )
  const objects = result.rows as Array<{ kind: 'function' | 'table'; name: string }>
  if (versions.length === 0 && objects.length === 0) return
  const functions = objects.filter(row => row.kind === 'function').map(row => row.name)
  const tables = objects.filter(row => row.kind === 'table').map(row => row.name)
  throw new Error(
    'Database ran an earlier head of the user access foundation change: ' +
      `recorded versions [${versions.join(', ')}]; ` +
      `functions [${functions.join(', ')}]; ` +
      `tables [${tables.join(', ')}]; ` +
      EARLIER_PR1_HEAD_CLEANUP_REFERENCE
  )
}

export async function applyPendingPr1Migrations({
  db,
  migrations,
  appliedVersions,
  recordMigration,
}: ApplyPendingPr1MigrationsInput): Promise<void> {
  const byVersion = new Map(migrations.map(migration => [migration.version, migration]))
  const canonicalVersions = new Set(byVersion.keys())
  const aliasOwners = new Map<string, string>()
  for (const migration of migrations) {
    for (const alias of migration.legacyVersions ?? []) {
      if (canonicalVersions.has(alias)) {
        throw new Error(`Migration alias collides with canonical version: ${alias}`)
      }
      const priorOwner = aliasOwners.get(alias)
      if (priorOwner && priorOwner !== migration.version) {
        throw new Error(`Migration alias has multiple owners: ${alias}`)
      }
      aliasOwners.set(alias, migration.version)
    }
  }
  const expected = new Set<string>(RUNNER_MIGRATION_VERSIONS)
  const unclassified = migrations.filter(
    migration => migration.version > LAST_DEV_MIGRATION_VERSION && !expected.has(migration.version)
  )
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified post-dev migrations: ${unclassified.map(item => item.version).join(', ')}`
    )
  }
  await assertNoEarlierPr1Head(
    db,
    appliedVersions,
    new Set([...PR1_MIGRATION_VERSIONS, ...canonicalVersions, ...aliasOwners.keys()])
  )

  for (const version of RUNNER_MIGRATION_VERSIONS) {
    const migration = byVersion.get(version)
    if (!migration) throw new Error(`Missing registered PR1 migration: ${version}`)
    if (appliedVersions.has(version)) continue
    const acceptedLegacyVersion = migration.legacyVersions?.find(alias =>
      appliedVersions.has(alias)
    )
    if (acceptedLegacyVersion) {
      await runBoundedTransaction(db, () => recordMigration(db, version))
      appliedVersions.add(version)
      continue
    }

    if (hasPostSchemaOnlineIndexes(version)) {
      await runBoundedTransaction(db, async () => migration.apply(db))
      await preparePr1Migration(db, version, 'after-schema')
      await runBoundedTransaction(db, async () => {
        await recordMigration(db, version)
      })
      appliedVersions.add(version)
      continue
    }

    await preparePr1Migration(db, version)
    await runBoundedTransaction(db, async () => {
      await migration.apply(db)
      await recordMigration(db, version)
    })
    appliedVersions.add(version)
  }
}
