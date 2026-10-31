import { describe, expect, it, vi } from 'vitest'
import { CONTROL_API_MIGRATIONS } from '../src/db.js'
import {
  PR1_MIGRATION_VERSIONS,
  PR2_MIGRATION_VERSIONS,
  applyPendingPr1Migrations,
} from '../src/migrations/migrationRunner.js'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const LEGACY_IDENTITIES: Array<readonly [string, string]> = [
  ['0137_workflow_authority_bindings', '0136_workflow_authority_bindings'],
  ['0137_workflow_authority_bindings', '0131_workflow_authority_bindings'],
  ['0137_workflow_authority_bindings', '0115_workflow_authority_bindings'],
  ['0137_workflow_authority_bindings', '010f_workflow_authority_bindings'],
  ['0138_gfs_upload_authority_bindings', '0137_gfs_upload_authority_bindings'],
  ['0138_gfs_upload_authority_bindings', '0132_gfs_upload_authority_bindings'],
  ['0138_gfs_upload_authority_bindings', '0116_gfs_upload_authority_bindings'],
  ['0138_gfs_upload_authority_bindings', '0110_gfs_upload_authority_bindings'],
  ['0139_pr2_readiness_evidence', '0138_pr2_readiness_evidence'],
  ['0139_pr2_readiness_evidence', '0133_pr2_readiness_evidence'],
  ['0139_pr2_readiness_evidence', '0119_pr2_readiness_evidence'],
  ['0139_pr2_readiness_evidence', '0117_pr2_readiness_evidence'],
  ['0139_pr2_readiness_evidence', '0111_pr2_readiness_evidence'],
  ['0140_pr2_runtime_privileges', '0139_pr2_runtime_privileges'],
  ['0140_pr2_runtime_privileges', '0134_pr2_runtime_privileges'],
  ['0140_pr2_runtime_privileges', '011a_pr2_runtime_privileges'],
  ['0140_pr2_runtime_privileges', '0118_pr2_runtime_privileges'],
  ['0140_pr2_runtime_privileges', '0112_pr2_runtime_privileges'],
  ['0141_workflow_recipe_authority_entity', '0140_workflow_recipe_authority_entity'],
  ['0141_workflow_recipe_authority_entity', '0135_workflow_recipe_authority_entity'],
  ['0141_workflow_recipe_authority_entity', '011b_workflow_recipe_authority_entity'],
  ['0141_workflow_recipe_authority_entity', '0119_workflow_recipe_authority_entity'],
  ['0141_workflow_recipe_authority_entity', '0113_workflow_recipe_authority_entity'],
  ['0142_workflow_run_failure_reason', '0141_workflow_run_failure_reason'],
  ['0142_workflow_run_failure_reason', '0136_workflow_run_failure_reason'],
  ['0142_workflow_run_failure_reason', '011c_workflow_run_failure_reason'],
  ['0142_workflow_run_failure_reason', '011a_workflow_run_failure_reason'],
  ['0142_workflow_run_failure_reason', '0114_workflow_run_failure_reason'],
  ['0143_r31_runtime_behavior_sources', '0142_r31_runtime_behavior_sources'],
  ['0143_r31_runtime_behavior_sources', '0137_r31_runtime_behavior_sources'],
  ['0143_r31_runtime_behavior_sources', '0120_r31_runtime_behavior_sources'],
  ['0115_llm_allowed_models_image_input', '011b_llm_allowed_models_image_input'],
]

const CLASSIFIED_VERSIONS = [...PR1_MIGRATION_VERSIONS, ...PR2_MIGRATION_VERSIONS]

// Dev aliases are reconciled by initDb's dev batch, so the runner cases cover
// only the PR1 and PR2 canonical versions.
const RUNNER_LEGACY_IDENTITIES = LEGACY_IDENTITIES.filter(
  ([canonical]) => canonical !== '0115_llm_allowed_models_image_input'
)

describe('synchronized migration legacy identities', () => {
  it('declares every repository-proven historical identity on its canonical migration', () => {
    for (const [canonical, legacy] of LEGACY_IDENTITIES) {
      const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === canonical)
      expect(migration?.legacyVersions, canonical).toContain(legacy)
    }
  })

  it.each([...RUNNER_LEGACY_IDENTITIES])(
    'recognizes %s from legacy identity %s without replaying its body',
    async (canonical, legacy) => {
      const body = vi.fn(async () => {
        throw new Error(`replayed ${canonical}`)
      })
      const migrations = CONTROL_API_MIGRATIONS.map(migration =>
        migration.version === canonical ? { ...migration, apply: body } : migration
      )
      const appliedVersions = new Set([
        ...CLASSIFIED_VERSIONS.filter(version => version !== canonical),
        ...CONTROL_API_MIGRATIONS.flatMap(migration => migration.legacyVersions ?? []),
      ])
      appliedVersions.add(legacy)
      const recordMigration = vi.fn(async () => undefined)

      await applyPendingPr1Migrations({
        db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
        migrations,
        appliedVersions,
        recordMigration,
      })

      expect(body).not.toHaveBeenCalled()
      expect(recordMigration).toHaveBeenCalledWith(expect.anything(), canonical)
      expect(recordMigration).toHaveBeenCalledTimes(1)
      expect(appliedVersions).toContain(canonical)
    }
  )
})
