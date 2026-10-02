import type { DbClient } from '../db.js'
import { migrationSessionBoundsSql } from './migrationExecutionPolicy.js'
import { preparePr1Migration } from './pr1OnlineIndexPlan.js'

export const PR1_MIGRATION_VERSIONS = Object.freeze([
  '0125_user_access_foundation',
  '0126_invitation_delivery_commands',
  '0127_catalog_utf8_ordering',
  '0128_composable_catalog_revisions',
  '0129_gfs_catalog_revision_components',
  '012a_user_access_foundation_definer_temp_shadow_hardening',
  '0130_legacy_password_security_epoch_backfill',
  // Executed immediately after 0125 by the runner, before the remaining PR1 migrations.
  '0138_authorization_revision_delete_compatibility',
] as const)

export const DEV_POST_0106_MIGRATION_VERSIONS = Object.freeze([
  '0107_llm_provider_attempts_sdk_link',
  '0108_llm_provider_attempts_sdk_link_on_delete_set_null',
  '0109_grok_subscription_connections',
  '0110_grok_subscription_oauth_states',
  '0111_grok_catalog_models',
  '0112_llm_provider_attempts_grok_broker',
  '0113_grok_subscription_terminal_connection_key',
  '0114_llm_provider_attempts_connection_integrity',
  '0115_llm_allowed_models_image_input',
  '0116_mcp_secret_rollback_permits',
  '0117_control_admin_invitation_replace_inviter',
  '0118_control_admin_replace_inviter_accept_guard',
  '0119_dynamic_clients_table',
  '0120_dynamic_clients_runtime_access',
  '0121_oauth_install_identity',
  '0122_durable_entity_change_feed',
  '0123_entity_change_checkpoint_cursor_convergence',
  '0124_entity_change_definer_search_path',
] as const)

const NON_PR1_POST_0106_MIGRATION_VERSIONS = new Set<string>(DEV_POST_0106_MIGRATION_VERSIONS)

const CLASSIFIED_POST_0106_MIGRATION_VERSIONS = Object.freeze([
  ...DEV_POST_0106_MIGRATION_VERSIONS,
  ...PR1_MIGRATION_VERSIONS,
] as const)

export type MigrationDescriptor = {
  version: string
  legacyVersions?: readonly string[]
  apply: (db: DbClient) => Promise<void>
}

const AUTHORIZATION_REVISION_COMPATIBILITY_PREREQUISITE = '0125_user_access_foundation'
const AUTHORIZATION_REVISION_COMPATIBILITY_VERSION =
  '0138_authorization_revision_delete_compatibility'

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
  const expected = new Set<string>(PR1_MIGRATION_VERSIONS)
  const unclassified = migrations.filter(
    migration =>
      migration.version > '0106_oauth_grants_owner_generalization' &&
      !expected.has(migration.version) &&
      !NON_PR1_POST_0106_MIGRATION_VERSIONS.has(migration.version)
  )
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified post-0106 migrations: ${unclassified.map(item => item.version).join(', ')}`
    )
  }

  for (const version of CLASSIFIED_POST_0106_MIGRATION_VERSIONS) {
    const migration = byVersion.get(version)
    if (!migration) throw new Error(`Missing registered post-0106 migration: ${version}`)
    const compatibilityMigration =
      version === AUTHORIZATION_REVISION_COMPATIBILITY_PREREQUISITE
        ? byVersion.get(AUTHORIZATION_REVISION_COMPATIBILITY_VERSION)
        : undefined
    if (version === AUTHORIZATION_REVISION_COMPATIBILITY_PREREQUISITE && !compatibilityMigration) {
      throw new Error(
        `Missing registered authorization revision compatibility migration: ${AUTHORIZATION_REVISION_COMPATIBILITY_VERSION}`
      )
    }
    const acceptedLegacyVersion = migration.legacyVersions?.find(alias =>
      appliedVersions.has(alias)
    )
    const currentMigrationApplied = appliedVersions.has(version) || Boolean(acceptedLegacyVersion)
    if (currentMigrationApplied) {
      const currentReceiptPending = !appliedVersions.has(version)
      const compatibilityReceiptPending =
        compatibilityMigration && !appliedVersions.has(compatibilityMigration.version)
      if (currentReceiptPending || compatibilityReceiptPending) {
        await runBoundedTransaction(db, async () => {
          if (currentReceiptPending) await recordMigration(db, version)
          if (compatibilityReceiptPending) {
            await compatibilityMigration.apply(db)
            await recordMigration(db, compatibilityMigration.version)
          }
        })
        if (currentReceiptPending) appliedVersions.add(version)
        if (compatibilityReceiptPending) appliedVersions.add(compatibilityMigration.version)
      }
      continue
    }

    const isPr1Migration = expected.has(version)
    if (compatibilityMigration && appliedVersions.has(compatibilityMigration.version)) {
      throw new Error(
        `Team revision compatibility is recorded before its prerequisite: ${compatibilityMigration.version}`
      )
    }
    if (isPr1Migration && !acceptedLegacyVersion) {
      await preparePr1Migration(db, version)
    }

    await runBoundedTransaction(db, async () => {
      if (!acceptedLegacyVersion) await migration.apply(db)
      await recordMigration(db, version)
      if (compatibilityMigration) {
        await compatibilityMigration.apply(db)
        await recordMigration(db, compatibilityMigration.version)
      }
    })
    appliedVersions.add(version)
    if (compatibilityMigration) appliedVersions.add(compatibilityMigration.version)
  }
}
