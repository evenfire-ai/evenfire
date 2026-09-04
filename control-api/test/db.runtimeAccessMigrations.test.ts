import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PR1_ONLINE_INDEX_PLAN } from '../src/migrations/pr1OnlineIndexPlan.js'

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
    const indexStates = new Map<
      string,
      {
        table_name: string
        indisunique: boolean
        indisvalid: boolean
        definition: string
      }
    >()
    clientQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM pg_class index_rel')) {
        const state = indexStates.get(String(values?.[0]))
        return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
      }
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
        const entry = PR1_ONLINE_INDEX_PLAN.find(candidate => candidate.createSql === sql)
        if (entry) {
          indexStates.set(entry.name, {
            table_name: entry.table,
            indisunique: Boolean(entry.unique),
            indisvalid: true,
            definition: entry.createSql,
          })
        }
      }
      return { rows: [], rowCount: 0 }
    })
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

  it('0070 revokes DELETE while retaining the control-api runtime table boundary', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const deleteRevocation = sqls.find(sql =>
      sql.includes('REVOKE DELETE ON TABLE member_registration_credentials')
    )
    const recordedVersions = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO schema_migrations'))
      .map(([, params]) => (Array.isArray(params) ? params[0] : undefined))

    expect(deleteRevocation).toContain('FROM control_api_runtime')
    expect(recordedVersions).toContain('0070_member_registration_runtime_delete_revoke')
  })
})
