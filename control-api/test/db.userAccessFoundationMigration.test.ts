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
    candidate => candidate.version === '0131_user_access_foundation'
  )
  expect(migration).toBeDefined()

  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  await migration!.apply({ query })
  return query.mock.calls.map(call => String(call[0])).join('\n')
}

async function legacyEpochBackfillSql(): Promise<string> {
  const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
  const migration = CONTROL_API_MIGRATIONS.find(
    candidate => candidate.version === '0132_legacy_password_security_epoch_backfill'
  )
  expect(migration).toBeDefined()

  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  await migration!.apply({ query })
  return query.mock.calls.map(call => String(call[0])).join('\n')
}

describe('user-access foundation migration', () => {
  it('adds the stateful user session foundation additively', async () => {
    const sql = await migrationSql()

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_user_sessions')
    expect(sql).toContain('current_jti UUID NOT NULL')
    expect(sql).toContain('prior_jti_expires_at TIMESTAMPTZ')
    expect(sql).toContain('idle_expires_at TIMESTAMPTZ NOT NULL')
    expect(sql).toContain('absolute_expires_at TIMESTAMPTZ NOT NULL')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_user_session_security_epochs')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_v1_session_revocations')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i)
  })

  it('builds keyset and reverse indexes online, outside the 0131 transaction', async () => {
    const sql = await migrationSql()
    const { PR1_ONLINE_INDEX_PLAN } = await import('../src/migrations/pr1OnlineIndexPlan.js')
    const planned = PR1_ONLINE_INDEX_PLAN.filter(
      entry => entry.migrationVersion === '0131_user_access_foundation'
    )
    const expectedIndexes = [
      'team_members_user_active_idx',
      'user_contexts_context_user_idx',
      'team_contexts_context_team_idx',
      'user_agents_agent_user_idx',
      'team_agents_agent_team_idx',
    ]
    expect(planned.map(entry => entry.name).sort()).toEqual([...expectedIndexes].sort())
    // Witness: the transaction still creates the PR1-owned tables and their indexes.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS external_user_sessions')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS external_user_sessions_user_live_idx')
    for (const expectedIndex of expectedIndexes) expect(sql).not.toContain(expectedIndex)
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
      ['external_user_session_security_epochs', 'legacy_dml'],
      ['external_user_sessions', 'legacy_dml'],
      ['external_v1_session_revocations', 'append'],
    ])

    for (const [relation, profile] of expected) {
      expect(entries.get(relation), relation).toBe(profile)
    }
  })

  it('backfills historical password security epochs monotonically', async () => {
    const sql = await legacyEpochBackfillSql()

    expect(sql).toContain('external_user_session_security_epochs')
    expect(sql).toContain('u.password_set_at IS NOT NULL')
    expect(sql).toContain('GREATEST(')
    expect(sql).toContain('historical_password_event')
    expect(sql).not.toMatch(/DELETE\s+FROM\s+external_user_session_security_epochs/i)
  })
})
