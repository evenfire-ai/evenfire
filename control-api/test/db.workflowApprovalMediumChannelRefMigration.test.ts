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

// Figure D migration 0039: communication_channel_ref on wama + skipped_no_bot
// status + telegram-only force-disable, plus the matching baseline columns.
describe('db migration 0039_wama_communication_channel_ref', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    })
    // schema_migrations empty → every migration (incl. 0039) runs.
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('runs the channel-ref migration and records its version', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    // Versioned migration body.
    expect(sqls).toContainEqual(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS communication_channel_ref')
    )
    expect(sqls).toContainEqual(expect.stringContaining('idx_wama_channel_ref'))
    // CHECK constraint now admits skipped_no_bot.
    expect(sqls).toContainEqual(expect.stringContaining("'skipped_no_bot'"))
    // Force-disable is telegram-only (does NOT touch Slack / other models).
    const forceDisable = sqls.find(
      sql =>
        sql.includes('UPDATE workflow_approval_medium_accounts') &&
        sql.includes("medium = 'telegram'") &&
        sql.includes('communication_channel_ref IS NULL')
    )
    expect(forceDisable).toBeDefined()

    // Version recorded exactly once.
    const recordCalls = clientQuery.mock.calls.filter(
      ([, params]) => Array.isArray(params) && params[0] === '0039_wama_communication_channel_ref'
    )
    expect(recordCalls.length).toBe(1)
  })

  it('includes communication_channel_ref in the baseline wama table (fresh DBs)', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const baselineWama = sqls.find(
      sql =>
        sql.includes('CREATE TABLE IF NOT EXISTS workflow_approval_medium_accounts') &&
        sql.includes('communication_channel_ref TEXT NULL')
    )
    expect(baselineWama).toBeDefined()
  })

  it('the force-disable is telegram-scoped and leaves Slack / other mediums untouched', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))
    const forceDisable = sqls.find(
      sql =>
        sql.includes('UPDATE workflow_approval_medium_accounts') &&
        sql.includes('communication_channel_ref IS NULL')
    )
    expect(forceDisable).toBeDefined()
    // Only ever targets telegram rows...
    expect(forceDisable).toContain("medium = 'telegram'")
    // ...so a Slack (or any non-telegram) account can never be force-disabled here.
    expect(forceDisable).not.toMatch(/medium\s*=\s*'slack'/)
    expect(forceDisable).not.toMatch(/medium\s+IN/i)
  })
})
