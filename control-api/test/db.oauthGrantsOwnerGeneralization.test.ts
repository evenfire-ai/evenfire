import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})

vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('0101 oauth_grants owner generalization migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('is registered after 0100_seed_minimax and before later additive migrations', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)
    expect(versions).toContain('0106_oauth_grants_owner_generalization')
    expect(versions.at(-1)).toBe('0107_llm_provider_attempts_sdk_link')
    expect(versions.indexOf('0100_seed_minimax_allowed_model')).toBeLessThan(
      versions.indexOf('0106_oauth_grants_owner_generalization')
    )
    expect(versions.indexOf('0106_oauth_grants_owner_generalization')).toBeLessThan(
      versions.indexOf('0107_llm_provider_attempts_sdk_link')
    )
    expect(versions).toContain('0099_gfs_upload_finalizing_recovery')
    expect(versions).toContain('0100_seed_minimax_allowed_model')
  })

  it('carries its prior names as legacyVersions so a deploy that already ran it is not re-executed', async () => {
    // Renamed 0091 -> 0100 -> 0101 -> 0106 across dev syncs (the last sync brought
    // dev's 0101-0105 codex migrations, taking the 0101 slot). Environments that
    // recorded an earlier name (the dev cluster) must mark 0106 applied from that
    // row instead of re-running the DDL. See applyPendingMigrations' legacyVersions
    // branch.
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      m => m.version === '0106_oauth_grants_owner_generalization'
    )
    expect(migration?.legacyVersions).toEqual([
      '0101_oauth_grants_owner_generalization',
      '0100_oauth_grants_owner_generalization',
      '0091_oauth_grants_owner_generalization',
    ])
  })

  it('adds owner_kind/context_id/bootstrapped_by, replaces the kind CHECK to admit shared, and rebuilds uniqueness', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const migration = sqls.find(
      sql => sql.includes('ADD COLUMN IF NOT EXISTS owner_kind') && sql.includes('oauth_grants')
    )
    expect(migration, 'the oauth_grants generalization DDL was applied').toBeDefined()
    const ddl = migration as string

    // New columns (idempotent).
    expect(ddl).toContain("ADD COLUMN IF NOT EXISTS owner_kind TEXT NOT NULL DEFAULT 'recipe'")
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS context_id TEXT')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS bootstrapped_by_user_id TEXT')

    // The kind/user_id CHECK is DROP+re-ADD to admit 'shared' — without this a
    // shared INSERT would violate the old user/service-only CHECK.
    expect(ddl).toContain('DROP CONSTRAINT IF EXISTS oauth_grants_kind_userid_check')
    expect(ddl).toContain("grant_kind = 'shared' AND user_id IS NULL")
    expect(ddl).toContain('context_id IS NOT NULL')
    expect(ddl).toContain('bootstrapped_by_user_id IS NOT NULL')

    // oauth_grants_unique recreated as a superset with owner_kind.
    expect(ddl).toContain('DROP CONSTRAINT IF EXISTS oauth_grants_unique')
    expect(ddl).toContain(
      'UNIQUE (owner_kind, recipe_namespace, recipe_name, user_id, oauth_client_id)'
    )

    // Shared partial unique index keyed by context_id.
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_shared_unique')
    expect(ddl).toContain(
      'ON oauth_grants (owner_kind, recipe_namespace, recipe_name, context_id, oauth_client_id)'
    )
    expect(ddl).toContain("WHERE grant_kind = 'shared'")

    // Non-destructive: recipe_namespace/recipe_name are NOT renamed.
    expect(ddl).not.toContain('RENAME COLUMN')
  })
})
