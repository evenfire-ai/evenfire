import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientQuery = vi.fn()
const clientRelease = vi.fn()
const mockConnect = vi.fn()
const mockPoolCtor = vi.fn(function MockPool() {
  return { connect: mockConnect, query: vi.fn() }
})

vi.mock('pg', () => ({ Pool: mockPoolCtor }))

describe('runtime access migrations', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({ query: clientQuery, release: clientRelease })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('0069 grants only the required member-registration table access to Control API', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const accessBoundary = sqls.find(sql =>
      sql.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_registration_credentials')
    )

    expect(accessBoundary).toBeDefined()
    expect(accessBoundary).toContain(
      'FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(accessBoundary).toContain('TO control_api_runtime')
    expect(accessBoundary).not.toMatch(/TO trace_maintenance_runtime|TO workflow_recipes_runtime/)
    expect(accessBoundary).toContain(
      'REVOKE ALL ON SEQUENCE member_registration_credentials_id_seq'
    )
    expect(accessBoundary).toContain(
      'GRANT USAGE, SELECT ON SEQUENCE member_registration_credentials_id_seq'
    )
  })
})
