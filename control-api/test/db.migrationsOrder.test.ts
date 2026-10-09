import { describe, expect, it, vi } from 'vitest'

// Mock pg exactly like the other db.*.test.ts specs so importing ../src/db.js
// does not spin up a real Pool as a module side effect.
vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return {
      connect: vi.fn(),
      query: vi.fn(),
    }
  }),
}))

describe('CONTROL_API_MIGRATIONS ordering invariant', () => {
  it('is strictly increasing by version-string across the whole array', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)

    // Migrations are applied in ARRAY ORDER and tracked by full version-string
    // in schema_migrations. Comparing lexicographically (a < b) mirrors that
    // apply order, so the array must be strictly increasing to stay predictable
    // after any future renumber/merge.
    const offenders: string[] = []
    for (let i = 1; i < versions.length; i += 1) {
      const prev = versions[i - 1]!
      const curr = versions[i]!
      if (!(prev < curr)) {
        offenders.push(`index ${i - 1}->${i}: '${prev}' !< '${curr}'`)
      }
    }

    expect(offenders, `non-monotonic version pair(s):\n${offenders.join('\n')}`).toEqual([])
  })

  it('has no duplicate version-strings', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)

    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const v of versions) {
      if (seen.has(v)) {
        duplicates.push(v)
      }
      seen.add(v)
    }

    expect(duplicates, `duplicate version-string(s):\n${duplicates.join('\n')}`).toEqual([])
  })

  it('assigns each migration a unique numeric slot', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const slots = CONTROL_API_MIGRATIONS.map(migration => migration.version.slice(0, 4))
    const duplicates = slots.filter((slot, index) => slots.indexOf(slot) !== index)

    expect(duplicates, `duplicate migration slot(s):\n${duplicates.join('\n')}`).toEqual([])
  })

  it('keeps current-dev password migrations before the relocated Task 106 sequence', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    const parentDev = [
      '0126_bug192_password_admission',
      '0127_password_evaluation_retention',
      '0128_password_work_ownership',
    ]
    const task106 = [
      '0129_user_access_foundation',
      '0130_invitation_delivery_commands',
      '0131_catalog_utf8_ordering',
      '0132_composable_catalog_revisions',
      '0133_gfs_catalog_revision_components',
      '0134_user_access_foundation_definer_temp_shadow_hardening',
      '0135_legacy_password_security_epoch_backfill',
      '0143_authorization_revision_delete_compatibility',
    ]

    expect(
      versions.slice(versions.indexOf(parentDev[0]!), versions.indexOf(parentDev[0]!) + 3)
    ).toEqual(parentDev)
    expect(
      versions.slice(versions.indexOf(task106[0]!), versions.indexOf(task106[0]!) + 8)
    ).toEqual(task106)
    expect(versions.indexOf(parentDev.at(-1)!)).toBeLessThan(versions.indexOf(task106[0]!))
  })

  it('keeps legacy aliases unique and distinct from current versions', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const current = new Set(CONTROL_API_MIGRATIONS.map(migration => migration.version))
    const aliases = CONTROL_API_MIGRATIONS.flatMap(migration => migration.legacyVersions ?? [])
    const duplicates = aliases.filter((version, index) => aliases.indexOf(version) !== index)
    const currentCollisions = aliases.filter(version => current.has(version))

    expect(duplicates).toEqual([])
    expect(currentCollisions).toEqual([])
  })

  it('registers the narrow R56-B1 access-foundation definer hardening migration', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const version = '0134_user_access_foundation_definer_temp_shadow_hardening'
    const migration = CONTROL_API_MIGRATIONS.find(candidate => candidate.version === version)
    const versions = CONTROL_API_MIGRATIONS.map(candidate => candidate.version)

    expect(migration).toBeDefined()
    expect(migration?.legacyVersions).toEqual([
      '012b_user_access_foundation_definer_temp_shadow_hardening',
      '012a_user_access_foundation_definer_temp_shadow_hardening',
    ])
    expect(versions.indexOf('0133_gfs_catalog_revision_components')).toBeLessThan(
      versions.indexOf(version)
    )
    expect(versions.indexOf(version)).toBeLessThan(
      versions.indexOf('0135_legacy_password_security_epoch_backfill')
    )
    if (!migration) return

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration.apply({ query } as never)
    expect(query).toHaveBeenCalledOnce()

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    const compactSql = sql.replace(/\s+/g, '')
    const signatures = [
      'authorization_bump_user_revision(pg_catalog.uuid)',
      'authorization_bump_team_revision(pg_catalog.uuid)',
      'authorization_bump_subject_revision(pg_catalog.text,pg_catalog.text)',
      'authorization_bump_user_row_revision()',
      'authorization_bump_team_row_revision()',
      'authorization_bump_workflow_run_revision()',
      'authorization_bump_workflow_approval_revision()',
      'authorization_bump_notification_revision()',
      'authorization_bump_gfs_subject_revision()',
      'authorization_bump_gfs_resource_component(pg_catalog.uuid)',
      'authorization_bump_gfs_authority_revision()',
      'authorization_bump_gfs_resource_subjects(pg_catalog.uuid)',
      'authorization_bump_gfs_resource_revision()',
      'authorization_bump_resource_revision(pg_catalog.text,pg_catalog.text,pg_catalog.text)',
      'authorization_bump_team_membership_revision()',
      'authorization_bump_user_grant_revision()',
      'authorization_bump_team_grant_revision()',
      'authorization_bump_operational_resource_revision()',
      'authorization_bump_operational_relationship_revision()',
    ]

    // 0132_composable_catalog_revisions removes this trigger before 0134 runs.
    expect(signatures).not.toContain('authorization_bump_catalog_revision()')
    expect(sql.match(/ALTER FUNCTION public\./g)).toHaveLength(signatures.length)
    for (const signature of signatures) {
      expect(compactSql).toContain(
        `ALTERFUNCTIONpublic.${signature}SETsearch_path=pg_catalog,public,pg_temp;`
      )
    }
    expect(sql).not.toMatch(/\b(?:CREATE OR REPLACE|DROP|GRANT|REVOKE|OWNER TO)\b/i)
  })

  it('recognizes deployed BUG-192 admission without reapplying its schema', async () => {
    const { CONTROL_API_MIGRATIONS, initDb, assertDbReady } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0126_bug192_password_admission'
    )
    expect(migration?.legacyVersions).toEqual(['0125_bug192_password_admission'])
    const appliedVersions = CONTROL_API_MIGRATIONS.filter(
      candidate => candidate.version !== migration?.version
    ).map(candidate => ({ version: candidate.version }))
    appliedVersions.push({ version: '0125_bug192_password_admission' })
    const query = vi.fn(async (sql: string) =>
      sql.includes('SELECT version FROM schema_migrations')
        ? { rows: appliedVersions, rowCount: appliedVersions.length }
        : { rows: [], rowCount: 0 }
    )
    const release = vi.fn()
    await initDb({ connect: vi.fn().mockResolvedValue({ query, release }) } as never)
    expect(query.mock.calls.map(([sql]) => sql)).not.toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS password_identifier_state')
    )
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations(version)'),
      ['0126_bug192_password_admission']
    )
    await expect(assertDbReady({ query } as never)).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
  })

  it('recognizes all previously deployed feed migration versions without reapplying DDL', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0122_durable_entity_change_feed'
    )
    expect(migration?.legacyVersions).toEqual([
      '0116_durable_entity_change_feed',
      '0117_durable_entity_change_feed',
      '0119_durable_entity_change_feed',
    ])

    for (const legacyVersion of migration?.legacyVersions ?? []) {
      const appliedVersions = CONTROL_API_MIGRATIONS.filter(
        candidate => candidate.version !== migration?.version
      ).map(candidate => ({ version: candidate.version }))
      appliedVersions.push({ version: legacyVersion })
      const query = vi.fn(async (sql: string) =>
        sql.includes('SELECT version FROM schema_migrations')
          ? { rows: appliedVersions, rowCount: appliedVersions.length }
          : { rows: [], rowCount: 0 }
      )
      const release = vi.fn()

      await initDb({ connect: vi.fn().mockResolvedValue({ query, release }) } as never)

      const statements = query.mock.calls.map(([sql]) => sql)
      expect(statements).not.toContainEqual(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS entity_change_feed')
      )
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO schema_migrations(version)'),
        ['0122_durable_entity_change_feed']
      )
      expect(release).toHaveBeenCalledOnce()
    }
  })

  it('recognizes the deployed checkpoint version without reapplying its function DDL', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0123_entity_change_checkpoint_cursor_convergence'
    )
    expect(migration?.legacyVersions).toEqual(['0120_entity_change_checkpoint_cursor_convergence'])

    const appliedVersions = CONTROL_API_MIGRATIONS.filter(
      candidate => candidate.version !== migration?.version
    ).map(candidate => ({ version: candidate.version }))
    appliedVersions.push({ version: '0120_entity_change_checkpoint_cursor_convergence' })
    const query = vi.fn(async (sql: string) =>
      sql.includes('SELECT version FROM schema_migrations')
        ? { rows: appliedVersions, rowCount: appliedVersions.length }
        : { rows: [], rowCount: 0 }
    )
    const release = vi.fn()

    await initDb({ connect: vi.fn().mockResolvedValue({ query, release }) } as never)

    const statements = query.mock.calls.map(([sql]) => String(sql))
    expect(statements).not.toContainEqual(
      expect.stringContaining('CREATE OR REPLACE FUNCTION entity_change_read_checkpoint')
    )
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations(version)'),
      ['0123_entity_change_checkpoint_cursor_convergence']
    )
    expect(release).toHaveBeenCalledOnce()
  })

  it('registers an additive migration for expired entity-change cursor convergence', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0123_entity_change_checkpoint_cursor_convergence'
    )
    expect(migration).toBeDefined()
    if (!migration) return

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration.apply({ query } as never)

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(sql).toMatch(/IF requested_cursor = current_cursor THEN/i)
    expect(sql).not.toMatch(/current_watermark > pruned_watermark/i)
  })

  it('registers an additive temp-schema repair for entity-change definer functions', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0124_entity_change_definer_search_path'
    )
    expect(migration).toBeDefined()
    if (!migration) return

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration.apply({ query } as never)

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    for (const functionName of [
      'entity_change_capture_resource',
      'entity_change_capture_scope',
      'entity_change_dispatch_batch',
      'entity_change_read_checkpoint',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `ALTER FUNCTION ${functionName}[\\s\\S]+?SET search_path = pg_catalog, public, pg_temp`,
          'i'
        )
      )
    }
  })

  it('requires 0116_mcp_secret_rollback_permits to persist expiring rollback permits', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    // Renumbered twice while syncing onto dev: 0101 -> 0109 -> 0116. The earlier
    // names survive only in this migration's legacyVersions, and the test above
    // forbids an alias from colliding with a current version, so looking one up
    // here by its old name can only ever find nothing.
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0116_mcp_secret_rollback_permits'
    )

    expect(migration).toBeDefined()
    if (!migration) return
    expect(migration.legacyVersions).toEqual([
      '0101_mcp_secret_rollback_permits',
      '0109_mcp_secret_rollback_permits',
    ])

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration.apply({ query } as never)

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS mcp_secret_rollback_permits/i)
    for (const column of [
      'session_hash',
      'namespace',
      'name',
      'uid',
      'resource_version',
      'expires_at',
      'claim_token',
      'claim_expires_at',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`, 'i'))
    }
    expect(sql).toMatch(/session_hash\s+BYTEA/i)
    expect(sql).toMatch(/octet_length\s*\(\s*session_hash\s*\)\s*=\s*32/i)
    expect(sql).toMatch(/expires_at\s*<=\s*created_at\s*\+\s*INTERVAL\s*'120 seconds'/i)
    expect(sql).toMatch(/claim_token\s+UUID/i)
    expect(sql).toMatch(/claim_expires_at\s+TIMESTAMPTZ/i)
    expect(sql).toMatch(/claim_token IS NULL[\s\S]+claim_expires_at IS NULL/i)
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS[\s\S]+?ON mcp_secret_rollback_permits\s*\(\s*expires_at\s*\)/i
    )
  })

  it('registers the narrow 0129 team-delete compatibility successor', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const predecessorIndex = CONTROL_API_MIGRATIONS.findIndex(
      candidate => candidate.version === '0129_user_access_foundation'
    )
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0143_authorization_revision_delete_compatibility'
    )

    expect(predecessorIndex).toBeGreaterThanOrEqual(0)
    expect(migration).toBeDefined()
    expect(CONTROL_API_MIGRATIONS.at(-1)?.version).toBe(
      '0143_authorization_revision_delete_compatibility'
    )
    expect(migration?.legacyVersions).toEqual(['0138_authorization_revision_delete_compatibility'])
    if (!migration) return

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await migration.apply({ query } as never)

    expect(query).toHaveBeenCalledOnce()
    const sql = String(query.mock.calls[0]?.[0])
    for (const functionName of [
      'authorization_bump_user_revision',
      'authorization_bump_team_revision',
    ]) {
      expect(sql).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\(target_.* UUID\\)`, 'i')
      )
      expect(sql).toMatch(
        new RegExp(
          `${functionName}[\\s\\S]+?SELECT ${functionName.includes('user') ? 'users' : 'teams'}\\.id[\\s\\S]+FROM ${functionName.includes('user') ? 'users' : 'teams'}`,
          'i'
        )
      )
    }
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.authorization_bump_team_revision\(target_team_id UUID\)/i
    )
    expect(sql).toMatch(/SECURITY DEFINER[\s\S]+SET search_path = pg_catalog, public, pg_temp/i)
    expect(sql).toMatch(/SELECT teams\.id[\s\S]+FROM teams[\s\S]+WHERE teams\.id = target_team_id/i)
    expect(sql).toMatch(/SELECT users\.id[\s\S]+FROM users[\s\S]+WHERE users\.id = target_user_id/i)
    expect(sql).not.toMatch(/VALUES\s*\(target_(?:team|user)_id/i)
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE|OWNER TO)\b/i)
  })
})
