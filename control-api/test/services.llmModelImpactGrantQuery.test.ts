import { afterEach, describe, expect, it, vi } from 'vitest'

// Minimum coverage (T1/T3 discipline): the grant impact query must run the jsonb
// containment against the MODEL param only — no provider filter. The full jsonb
// `@>` semantics are exercised end-to-end in
// `db.listGrantsReferencingModel.realPostgres.integration.test.ts` (skipped
// without a real Postgres); this unit test pins that the right SQL + params reach
// pool.query so the risky part is not stubbed away entirely.

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

describe('listGrantsReferencingModel query', () => {
  afterEach(() => vi.clearAllMocks())

  it('matches by MODEL name only (no provider filter) and passes [model] to pool.query', async () => {
    const { listGrantsReferencingModel } = await import('../src/services/pluginWorkloadSdkDb.js')
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })

    await listGrantsReferencingModel('claude-haiku-4-5')

    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/allowed_models\s+@>\s+to_jsonb\(\$1::text\)/)
    // The unsafe direction for a safety gate would be a provider filter — assert
    // there is none, so a cross-provider allowed_models entry cannot be dropped.
    expect(sql).not.toMatch(/provider\s*=/)
    expect(params).toEqual(['claude-haiku-4-5'])
  })
})
