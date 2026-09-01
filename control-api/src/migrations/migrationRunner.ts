import type { DbClient } from '../db.js'
import { migrationSessionBoundsSql } from './migrationExecutionPolicy.js'
import { preparePr1Migration } from './pr1OnlineIndexPlan.js'

export const PR1_MIGRATION_VERSIONS = Object.freeze([
  '0107_user_access_foundation',
  '0108_invitation_delivery_commands',
  '0109_catalog_utf8_ordering',
  '010a_composable_catalog_revisions',
  '010b_gfs_catalog_revision_components',
  '010c_legacy_password_security_epoch_backfill',
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
    started = false
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
  const expected = new Set<string>(PR1_MIGRATION_VERSIONS)
  const unclassified = migrations.filter(
    migration =>
      migration.version > '0106_oauth_grants_owner_generalization' &&
      !expected.has(migration.version)
  )
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified post-0106 migrations: ${unclassified.map(item => item.version).join(', ')}`
    )
  }

  for (const version of PR1_MIGRATION_VERSIONS) {
    const migration = byVersion.get(version)
    if (!migration) throw new Error(`Missing registered PR1 migration: ${version}`)
    if (appliedVersions.has(version)) continue

    const acceptedLegacyVersion = migration.legacyVersions?.find(alias =>
      appliedVersions.has(alias)
    )
    if (!acceptedLegacyVersion) {
      await preparePr1Migration(db, version)
    }

    await runBoundedTransaction(db, async () => {
      if (!acceptedLegacyVersion) await migration.apply(db)
      await recordMigration(db, version)
    })
    appliedVersions.add(version)
  }
}
