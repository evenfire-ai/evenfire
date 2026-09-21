import { describe, expect, it, vi } from 'vitest'
import { CONTROL_API_MIGRATIONS } from '../src/db.js'
import {
  DEV_POST_0106_MIGRATION_VERSIONS,
  PR1_MIGRATION_VERSIONS,
  PR2_MIGRATION_VERSIONS,
  applyPendingPr1Migrations,
} from '../src/migrations/migrationRunner.js'

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { connect: vi.fn(), query: vi.fn() }
  }),
}))

const LEGACY_IDENTITIES = new Map<string, string>([
  ['0115_workflow_authority_bindings', '010f_workflow_authority_bindings'],
  ['0116_gfs_upload_authority_bindings', '0110_gfs_upload_authority_bindings'],
  ['0117_pr2_readiness_evidence', '0111_pr2_readiness_evidence'],
  ['0118_pr2_runtime_privileges', '0112_pr2_runtime_privileges'],
  ['0119_workflow_recipe_authority_entity', '0113_workflow_recipe_authority_entity'],
  ['011a_workflow_run_failure_reason', '0114_workflow_run_failure_reason'],
  ['011b_llm_allowed_models_image_input', '0115_llm_allowed_models_image_input'],
])

const CLASSIFIED_VERSIONS = [
  ...DEV_POST_0106_MIGRATION_VERSIONS,
  ...PR1_MIGRATION_VERSIONS,
  ...PR2_MIGRATION_VERSIONS,
]

describe('synchronized migration legacy identities', () => {
  it('declares every repository-proven historical identity on its canonical migration', () => {
    for (const [canonical, legacy] of LEGACY_IDENTITIES) {
      const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === canonical)
      expect(migration?.legacyVersions, canonical).toContain(legacy)
    }
  })

  it.each([...LEGACY_IDENTITIES])(
    'recognizes %s from legacy identity %s without replaying its body',
    async (canonical, legacy) => {
      const body = vi.fn(async () => {
        throw new Error(`replayed ${canonical}`)
      })
      const migrations = CONTROL_API_MIGRATIONS.map(migration =>
        migration.version === canonical ? { ...migration, apply: body } : migration
      )
      const appliedVersions = new Set(CLASSIFIED_VERSIONS.filter(version => version !== canonical))
      appliedVersions.add(legacy)
      const recordMigration = vi.fn(async () => undefined)

      await applyPendingPr1Migrations({
        db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
        migrations,
        appliedVersions,
        recordMigration,
      })

      expect(body).not.toHaveBeenCalled()
      expect(recordMigration).toHaveBeenCalledTimes(1)
      expect(recordMigration).toHaveBeenCalledWith(expect.anything(), canonical)
      expect(appliedVersions).toContain(canonical)
    }
  )
})
