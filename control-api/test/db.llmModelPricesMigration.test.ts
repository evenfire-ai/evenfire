import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onlineIndexAwareQuery } from './helpers/onlineIndexCatalogMock.js'

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

describe('0044_llm_model_prices migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: onlineIndexAwareQuery(clientQuery),
      release: clientRelease,
    })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('creates the table and the active partial unique index, and seeds no prices', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS llm_model_prices')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_model_prices_active')
    )
    // partial index — one active row per (provider, model)
    expect(sqls.some(sql => /idx_llm_model_prices_active[\s\S]*WHERE enabled/.test(sql))).toBe(true)
    // The placeholder seed is retired: the catalog sync prices models on insert.
    expect(sqls.filter(sql => /INSERT INTO llm_model_prices\b/.test(sql))).toEqual([])
  })
})
