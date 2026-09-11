import { describe, expect, it } from 'vitest'

describe('0111 PR2 readiness evidence migration', () => {
  it('registers after all prior PR2 durable authority migrations', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(migration => migration.version)
    expect(versions).toContain('0111_pr2_readiness_evidence')
    const migration = CONTROL_API_MIGRATIONS.find(
      candidate => candidate.version === '0111_pr2_readiness_evidence'
    )!
    const queries: string[] = []
    await migration.apply({
      query: async sql => {
        queries.push(sql)
        return { rows: [], rowCount: 0 }
      },
    })
    const sql = queries.join('\n')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pr2_readiness_activations')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pr2_readiness_evidence')
    expect(sql).toContain('workspace_files_controller_checkpoint')
    expect(sql).toContain("evidence_class IN ('build', 'runtime')")
  })
})
