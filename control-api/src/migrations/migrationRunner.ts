import type { DbClient } from '../db.js'
import { migrationSessionBoundsSql } from './migrationExecutionPolicy.js'
import { preparePr1Migration } from './pr1OnlineIndexPlan.js'

export const PR1_MIGRATION_VERSIONS = Object.freeze([
  '0131_user_access_foundation',
  '0132_invitation_delivery_commands',
  '0133_catalog_utf8_ordering',
  '0134_composable_catalog_revisions',
  '0135_legacy_password_security_epoch_backfill',
] as const)

// Every migration up to and including dev's last migration runs in initDb's
// single dev batch; this runner owns only the PR1 versions that follow it.
const LAST_DEV_MIGRATION_VERSION = '0130_password_login_success_admission'

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
  const expected = new Set<string>(PR1_MIGRATION_VERSIONS)
  const unclassified = migrations.filter(
    migration => migration.version > LAST_DEV_MIGRATION_VERSION && !expected.has(migration.version)
  )
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified post-dev migrations: ${unclassified.map(item => item.version).join(', ')}`
    )
  }

  for (const version of PR1_MIGRATION_VERSIONS) {
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

    await preparePr1Migration(db, version)
    await runBoundedTransaction(db, async () => {
      await migration.apply(db)
      await recordMigration(db, version)
    })
    appliedVersions.add(version)
  }
}
