import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return {
    connect: mockConnect,
    query: vi.fn(),
  }
})

vi.mock('pg', () => ({
  Pool: mockPoolCtor,
}))

describe('0090_identity_provider_connections migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('creates the complete identity-provider schema with its runtime access boundary', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const migration = sqls.find(
      sql =>
        sql.includes('CREATE TABLE IF NOT EXISTS identity_provider_connections') &&
        sql.includes('CREATE TABLE IF NOT EXISTS identity_provider_setup_sessions')
    )

    expect(migration).toBeDefined()
    expect(migration).toContain('allow_member_login BOOLEAN NOT NULL DEFAULT TRUE')
    expect(migration).toContain('flow_binding_hash TEXT')
    expect(migration).toContain('identity_provider_team_mappings')
    expect(migration).toContain('invitation_agents')
    expect(migration).toContain('import_lock_token TEXT')
    expect(migration).toContain('import_lock_expires_at TIMESTAMPTZ')
    expect(migration).toContain('idx_invitations_identity_provider_subject_active')
    expect(migration).toContain("status IN ('draft', 'pending')")
    expect(migration).toContain(
      'FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\n          identity_provider_connections'
    )
    expect(migration).toContain('TO control_api_runtime')
    expect(migration).not.toContain('TO trace_maintenance_runtime')
    expect(migration).not.toContain('TO workflow_recipes_runtime')

    const recordedVersions = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO schema_migrations'))
      .map(([, params]) => params?.[0])
    expect(recordedVersions).toContain('0090_identity_provider_connections')
    expect(recordedVersions).not.toContain('0069_identity_provider_setup_sessions')
    expect(recordedVersions).not.toContain('0070_identity_provider_login_flow_binding')
    expect(recordedVersions).not.toContain('0071_identity_provider_runtime_access')
  })
})
