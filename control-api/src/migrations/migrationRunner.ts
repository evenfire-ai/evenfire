import type { DbClient } from '../db.js'
import { migrationSessionBoundsSql } from './migrationExecutionPolicy.js'
import { hasPostSchemaOnlineIndexes, preparePr1Migration } from './pr1OnlineIndexPlan.js'

export const PR1_MIGRATION_VERSIONS = Object.freeze([
  '0130_user_access_foundation',
  '0131_invitation_delivery_commands',
  '0132_catalog_utf8_ordering',
  '0133_composable_catalog_revisions',
  '0134_gfs_catalog_revision_components',
  '0135_user_access_foundation_definer_temp_shadow_hardening',
  '0136_legacy_password_security_epoch_backfill',
  // Executed immediately after 0130 by the runner, before remaining PR1 migrations.
  '0144_authorization_revision_delete_compatibility',
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
  '0125_admin_subscription_rate_limit_namespace',
  '0126_bug192_password_admission',
  '0127_password_evaluation_retention',
  '0128_password_work_ownership',
  '0129_workflow_schedules_concurrency_policy',
] as const)

export const PR2_MIGRATION_VERSIONS = Object.freeze([
  '0137_workflow_authority_bindings',
  '0138_gfs_upload_authority_bindings',
  '0139_pr2_readiness_evidence',
  '0140_pr2_runtime_privileges',
  '0141_workflow_recipe_authority_entity',
  '0142_workflow_run_failure_reason',
  '0143_r31_runtime_behavior_sources',
])

const AUTHORIZATION_REVISION_COMPATIBILITY_PREREQUISITE = '0130_user_access_foundation'
const AUTHORIZATION_REVISION_COMPATIBILITY_VERSION =
  '0144_authorization_revision_delete_compatibility'

const NON_PR1_POST_0106_MIGRATION_VERSIONS = new Set<string>(DEV_POST_0106_MIGRATION_VERSIONS)

const CLASSIFIED_POST_0106_MIGRATION_VERSIONS = Object.freeze([
  ...DEV_POST_0106_MIGRATION_VERSIONS,
  ...PR1_MIGRATION_VERSIONS.filter(
    version => version !== AUTHORIZATION_REVISION_COMPATIBILITY_VERSION
  ),
  ...PR2_MIGRATION_VERSIONS,
  AUTHORIZATION_REVISION_COMPATIBILITY_VERSION,
] as const)

export type MigrationDescriptor = {
  version: string
  legacyVersions?: readonly string[]
  // Keep supported older-reader identities alongside the current receipt.
  preserveLegacyReceipts?: boolean
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
    if (migration.preserveLegacyReceipts && !migration.legacyVersions?.length) {
      throw new Error(`Migration ${migration.version} preserves no legacy receipts`)
    }
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
  const expected = new Set<string>([...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS])
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
    const preservedMigrationReceipts = migration.preserveLegacyReceipts
      ? (migration.legacyVersions ?? [])
      : []
    const currentMigrationApplied = appliedVersions.has(version) || Boolean(acceptedLegacyVersion)
    if (currentMigrationApplied) {
      const currentReceiptPending = !appliedVersions.has(version)
      const preservedMigrationReceiptsPending = preservedMigrationReceipts.filter(
        alias => !appliedVersions.has(alias)
      )
      const acceptedCompatibilityLegacyVersion = compatibilityMigration?.legacyVersions?.find(
        alias => appliedVersions.has(alias)
      )
      const compatibilityReceiptPending =
        compatibilityMigration && !appliedVersions.has(compatibilityMigration.version)
      const preservedCompatibilityReceipts = compatibilityMigration?.preserveLegacyReceipts
        ? (compatibilityMigration.legacyVersions ?? [])
        : []
      const preservedCompatibilityReceiptsPending = preservedCompatibilityReceipts.filter(
        alias => !appliedVersions.has(alias)
      )
      const compatibilityBodyPending =
        compatibilityMigration &&
        !appliedVersions.has(compatibilityMigration.version) &&
        !acceptedCompatibilityLegacyVersion
      if (
        currentReceiptPending ||
        preservedMigrationReceiptsPending.length > 0 ||
        compatibilityReceiptPending ||
        preservedCompatibilityReceiptsPending.length > 0
      ) {
        await runBoundedTransaction(db, async () => {
          if (currentReceiptPending) await recordMigration(db, version)
          for (const alias of preservedMigrationReceiptsPending) {
            await recordMigration(db, alias)
          }
          if (compatibilityBodyPending) {
            await compatibilityMigration!.apply(db)
          }
          if (compatibilityMigration && compatibilityReceiptPending) {
            await recordMigration(db, compatibilityMigration.version)
          }
          if (compatibilityMigration) {
            for (const alias of preservedCompatibilityReceiptsPending) {
              await recordMigration(db, alias)
            }
          }
        })
        if (currentReceiptPending) appliedVersions.add(version)
        for (const alias of preservedMigrationReceiptsPending) appliedVersions.add(alias)
        if (compatibilityReceiptPending) {
          appliedVersions.add(compatibilityMigration.version)
        }
        for (const alias of preservedCompatibilityReceiptsPending) appliedVersions.add(alias)
      }
      continue
    }

    const isPr1Migration = expected.has(version)
    const compatibilityReceiptAlreadyApplied = compatibilityMigration
      ? appliedVersions.has(compatibilityMigration.version) ||
        compatibilityMigration.legacyVersions?.some(alias => appliedVersions.has(alias))
      : false
    if (compatibilityMigration && compatibilityReceiptAlreadyApplied) {
      throw new Error(
        `Team revision compatibility is recorded before its prerequisite: ${compatibilityMigration.version}`
      )
    }
    const hasPostSchemaIndexes = hasPostSchemaOnlineIndexes(version)
    if (isPr1Migration && !acceptedLegacyVersion && !hasPostSchemaIndexes) {
      await preparePr1Migration(db, version)
    }

    if (isPr1Migration && !acceptedLegacyVersion && hasPostSchemaIndexes) {
      await runBoundedTransaction(db, async () => migration.apply(db))
      await preparePr1Migration(db, version, 'after-schema')
      await runBoundedTransaction(db, async () => {
        await recordMigration(db, version)
        for (const alias of preservedMigrationReceipts) {
          if (!appliedVersions.has(alias)) await recordMigration(db, alias)
        }
      })
      appliedVersions.add(version)
      for (const alias of preservedMigrationReceipts) appliedVersions.add(alias)
      continue
    }

    await runBoundedTransaction(db, async () => {
      if (!acceptedLegacyVersion) await migration.apply(db)
      await recordMigration(db, version)
      for (const alias of preservedMigrationReceipts) {
        if (!appliedVersions.has(alias)) await recordMigration(db, alias)
      }
      if (compatibilityMigration) {
        const acceptedAlias = compatibilityMigration.legacyVersions?.find(alias =>
          appliedVersions.has(alias)
        )
        if (!appliedVersions.has(compatibilityMigration.version) && !acceptedAlias) {
          await compatibilityMigration.apply(db)
        }
        if (!appliedVersions.has(compatibilityMigration.version)) {
          await recordMigration(db, compatibilityMigration.version)
        }
        const compatibilityAliases = compatibilityMigration.preserveLegacyReceipts
          ? (compatibilityMigration.legacyVersions ?? [])
          : []
        for (const alias of compatibilityAliases) {
          if (!appliedVersions.has(alias)) await recordMigration(db, alias)
        }
      }
    })
    appliedVersions.add(version)
    for (const alias of preservedMigrationReceipts) appliedVersions.add(alias)
    if (compatibilityMigration) appliedVersions.add(compatibilityMigration.version)
    if (compatibilityMigration?.preserveLegacyReceipts) {
      for (const alias of compatibilityMigration.legacyVersions ?? []) appliedVersions.add(alias)
    }
  }
}
