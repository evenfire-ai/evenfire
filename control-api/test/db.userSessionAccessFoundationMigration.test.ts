import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../src/config.js', () => ({
  config: { pgConnectionString: 'postgres://unused' },
}))

describe('user-session and authorization revision foundation migration', () => {
  it('is additive, indexed for user-first access, and actively invalidates revisions', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0091_user_session_access_foundation'
    )

    expect(migration).toBeDefined()
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls.map(call => String(call[0])).join('\n')

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_user_sessions')
    expect(sql).toContain('current_jti')
    expect(sql).toContain('prior_jti_expires_at')
    expect(sql).toContain('idle_expires_at')
    expect(sql).toContain('absolute_expires_at')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS team_members_user_active_idx')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_user_revisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_team_revisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_resource_revisions')
    expect(sql).toContain('authorization_bump_team_membership_revision')
    expect(sql).toContain('authorization_bump_user_grant_revision')
    expect(sql).toContain('authorization_bump_team_grant_revision')
    expect(sql).toContain(
      'FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE')
    expect(sql).toContain('TO control_api_runtime')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i)
  })

  it('adds token-specific and security-event revocation for v1 compatibility', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0092_legacy_session_revocation_foundation'
    )

    expect(migration).toBeDefined()
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls.map(call => String(call[0])).join('\n')

    expect(sql).toContain('external_user_session_security_epochs')
    expect(sql).toContain('external_v1_session_revocations')
    expect(sql).toContain('external_v1_session_revocations_user_idx')
    expect(sql).toContain(
      'FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE')
    expect(sql).toContain('TO control_api_runtime')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i)
  })

  it('declares every new runtime-owned relation in the deploy access contract', () => {
    const contractPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../deploy/scripts/control-api-runtime-access-profiles.tsv'
    )
    const expectedRelations = [
      'authorization_resource_revisions',
      'authorization_team_revisions',
      'authorization_user_revisions',
      'external_user_session_security_epochs',
      'external_user_sessions',
      'external_v1_session_revocations',
      'invitation_delivery_commands',
    ]
    const contractEntries = readFileSync(contractPath, 'utf8')
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('\t'))
      .filter(([relation]) => expectedRelations.includes(relation))

    expect(contractEntries).toEqual(expectedRelations.map(relation => [relation, 'legacy_dml']))
  })

  it('adds covering indexes for aggregate catalog actor and audience predicates', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0093_access_catalog_performance_foundation'
    )

    expect(migration).toBeDefined()
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await migration!.apply({ query })
    const sql = query.mock.calls.map(call => String(call[0])).join('\n')

    expect(sql).toContain('workflow_runs_actor_recipe_run_idx')
    expect(sql).toContain('workflow_runs_team_recipe_run_idx')
    expect(sql).toContain('workflow_runs_usage_team_recipe_run_idx')
    expect(sql).toContain("(audience->>'userId')")
    expect(sql).toContain("(audience->>'teamId')")
    expect(sql).toContain('workflow_approval_user_catalog_idx')
    expect(sql).toContain('workflow_approval_team_catalog_idx')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i)
  })
})
