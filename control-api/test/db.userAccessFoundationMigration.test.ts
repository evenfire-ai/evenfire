import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../src/config.js', () => ({
  config: { pgConnectionString: 'postgres://unused' },
}))

async function migrationSql(): Promise<string> {
  const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
  const migration = CONTROL_API_MIGRATIONS.find(
    candidate => candidate.version === '0101_user_access_foundation'
  )
  expect(migration).toBeDefined()

  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  await migration!.apply({ query })
  return query.mock.calls.map(call => String(call[0])).join('\n')
}

describe('user-access foundation migration', () => {
  it('adds the stateful user session and revision foundations additively', async () => {
    const sql = await migrationSql()

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_user_sessions')
    expect(sql).toContain('current_jti UUID NOT NULL')
    expect(sql).toContain('prior_jti_expires_at TIMESTAMPTZ')
    expect(sql).toContain('idle_expires_at TIMESTAMPTZ NOT NULL')
    expect(sql).toContain('absolute_expires_at TIMESTAMPTZ NOT NULL')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_user_session_security_epochs')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_v1_session_revocations')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_user_revisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_team_revisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_resource_revisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS authorization_catalog_revision')
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain('authorization_bump_team_membership_revision')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i)
  })

  it('stores operational facts and staging generations without effective access', async () => {
    const sql = await migrationSql()

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS operational_catalog_source_state')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS operational_resource_index')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS operational_resource_relationships')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS operational_resource_index_staging')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS operational_relationships_staging')
    expect(sql).toContain('staging_generation BIGINT')
    expect(sql).toContain('operational_relationship_target_idx')
    expect(sql).toContain('relationship_instance_id TEXT NOT NULL')

    const currentResourceTable = sql.match(
      /CREATE TABLE IF NOT EXISTS operational_resource_index \(([\s\S]*?)\n    \);/
    )?.[1]
    const currentRelationshipTable = sql.match(
      /CREATE TABLE IF NOT EXISTS operational_resource_relationships \(([\s\S]*?)\n    \);/
    )?.[1]
    expect(currentResourceTable).toBeDefined()
    expect(currentRelationshipTable).toBeDefined()
    expect(`${currentResourceTable}\n${currentRelationshipTable}`).not.toMatch(
      /\b(?:user_id|team_id|role|grant|capabilit(?:y|ies))\b/
    )
    expect(sql).not.toMatch(/CREATE\s+MATERIALIZED\s+VIEW/i)
  })

  it('adds keyset and reverse indexes before catalog producers are introduced', async () => {
    const sql = await migrationSql()

    for (const expectedIndex of [
      'team_members_user_active_idx',
      'user_contexts_context_user_idx',
      'team_contexts_context_team_idx',
      'user_agents_agent_user_idx',
      'team_agents_agent_team_idx',
      'user_workflow_triggers_recipe_user_idx',
      'team_workflow_triggers_recipe_team_idx',
      'user_workflow_triggers_catalog_key_idx',
      'team_workflow_triggers_catalog_key_idx',
      'workflow_runs_actor_catalog_idx',
      'workflow_runs_team_catalog_idx',
      'workflow_runs_usage_team_catalog_idx',
      'workflow_approval_user_catalog_idx',
      'workflow_approval_team_catalog_idx',
      'notification_user_catalog_idx',
      'notification_team_catalog_idx',
      'gfs_grants_subject_resource_catalog_idx',
      'gfs_shares_subject_resource_catalog_idx',
    ]) {
      expect(sql).toContain(expectedIndex)
    }
    expect(sql).toContain('ON workflow_runs (actor_id, run_id)')
    expect(sql).toContain("ON notification_deliveries ((audience->>'userId'), id)")
  })

  it('declares exact least-privilege profiles for every new relation', () => {
    const contractPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../deploy/scripts/control-api-runtime-access-profiles.tsv'
    )
    const entries = new Map(
      readFileSync(contractPath, 'utf8')
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.split('\t') as [string, string])
    )

    const expected = new Map<string, string>([
      ['authorization_catalog_writer_components', 'read'],
      ['authorization_resource_revisions', 'upsert'],
      ['authorization_team_revisions', 'upsert'],
      ['authorization_user_revisions', 'upsert'],
      ['external_user_session_security_epochs', 'legacy_dml'],
      ['external_user_sessions', 'legacy_dml'],
      ['external_v1_session_revocations', 'legacy_dml'],
      ['operational_catalog_source_state', 'legacy_dml'],
      ['operational_relationships_staging', 'legacy_dml'],
      ['operational_resource_index', 'legacy_dml'],
      ['operational_resource_index_staging', 'legacy_dml'],
      ['operational_resource_relationships', 'legacy_dml'],
    ])

    for (const [relation, profile] of expected) {
      expect(entries.get(relation), relation).toBe(profile)
    }
  })
})
