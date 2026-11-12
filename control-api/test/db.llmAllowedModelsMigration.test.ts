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

describe('0056_llm_allowed_models migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: onlineIndexAwareQuery(clientQuery),
      release: clientRelease,
    })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('creates both tables and the (provider, model) unique index', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS llm_allowed_models')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS llm_allowed_models_audit')
    )
    expect(sqls.some(sql => /idx_llm_allowed_models_pm[\s\S]*\(provider, model\)/.test(sql))).toBe(
      true
    )
  })

  it('0056/0057/0058/0100 seed nothing: a new installation gets its catalog from the sync', async () => {
    const { CONTROL_API_MIGRATIONS, initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    // Liveness witness: the seed migrations are still in the list (installations
    // that applied them have them recorded) and initDb ran the list.
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)
    for (const v of [
      '0056_llm_allowed_models',
      '0057_llm_allowed_models_vertex_bedrock',
      '0058_llm_allowed_models_new_providers',
      '0100_seed_minimax_allowed_model',
    ]) {
      expect(versions).toContain(v)
    }
    expect(sqls).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS llm_allowed_models')
    )
    expect(sqls.filter(sql => /INSERT INTO llm_allowed_models\b/.test(sql))).toEqual([])
  })

  it('0059 adds the catalog lifecycle columns idempotently with a manual default', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    // Each of the four columns is added with ADD COLUMN IF NOT EXISTS (idempotent).
    const alters = sqls.filter(sql => /ALTER TABLE llm_allowed_models/.test(sql))
    const joined = alters.join('\n')
    expect(joined).toMatch(/ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'/)
    expect(joined).toMatch(/CHECK \(source IN \('manual','discovery'\)\)/)
    expect(joined).toMatch(/ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ/)
    expect(joined).toMatch(/ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ/)
    expect(joined).toMatch(/ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT false/)

    // ADDITIVE only: F1 must NOT rename/drop columns or add discovery logic.
    expect(joined).not.toMatch(/DROP COLUMN/)
    // Backfill of existing rows is via the DEFAULT ('manual'), not a data UPDATE.
    // The only statement that rewrites `source` is 0135's reclassification, and
    // it is bound to an explicit pair list.
    const sourceUpdates = sqls.filter(sql =>
      /UPDATE llm_allowed_models[\s\S]*SET\s+source\b/.test(sql)
    )
    expect(sourceUpdates).toHaveLength(1)
    expect(sourceUpdates[0]).toMatch(
      /FROM unnest\(\$1::text\[\], \$2::text\[\]\) AS s\(provider, model\)/
    )
  })

  it('0060 creates the llm_catalog_sync_runs summary table (F2, additive)', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    const create = sqls.find(sql => /CREATE TABLE IF NOT EXISTS llm_catalog_sync_runs/.test(sql))
    expect(create).toBeDefined()
    expect(create!).toMatch(/source TEXT NOT NULL CHECK \(source IN \('live','vendored'\)\)/)
    expect(create!).toMatch(/added INTEGER NOT NULL DEFAULT 0/)
    expect(create!).toMatch(/updated INTEGER NOT NULL DEFAULT 0/)
    expect(create!).toMatch(/staled INTEGER NOT NULL DEFAULT 0/)
    expect(create!).toMatch(/idx_llm_catalog_sync_runs_ran_at/)
    // F2 must not alter the allowlist contract (no change to llm_allowed_models here).
    expect(create!).not.toMatch(/ALTER TABLE llm_allowed_models/)
  })

  it('0067 applies the exact runtime access profiles for all LLM catalog relations', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    const accessBoundary = sqls.find(sql =>
      sql.includes('FROM PUBLIC, control_api_runtime, trace_maintenance_runtime')
    )
    expect(accessBoundary).toBeDefined()
    expect(accessBoundary).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\n          llm_allowed_models'
    )
    expect(accessBoundary).toContain(
      'GRANT SELECT, INSERT ON TABLE\n          llm_allowed_models_audit,\n          llm_catalog_sync_runs'
    )
  })

  it('0115 adds the nullable image_input capability column idempotently (#654)', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    const alter = sqls.find(sql => /ADD COLUMN IF NOT EXISTS image_input JSONB/.test(sql))
    expect(alter).toBeDefined()
    // Nullable + no DEFAULT: every existing row reads as `unknown`, and the
    // migration alone changes no runtime behavior.
    expect(alter!).not.toMatch(/image_input JSONB\s+NOT NULL/)
    expect(alter!).not.toMatch(/image_input JSONB\s+DEFAULT/)
    // The state enum is the DB backstop; the nested evidence shape is validated
    // by the service through the shared parser.
    expect(alter!).toMatch(/jsonb_typeof\(image_input\) = 'object'/)
    expect(alter!).toMatch(/image_input->>'state' IN \('supported','unsupported','unknown'\)/)
    // The predicate must be TOTAL, because a CHECK accepts NULL: without these
    // two guards a `{}` (or `{"state": null}`) payload evaluates to NULL and is
    // ACCEPTED. The real database behaviour is covered by
    // db.realPostgresMigration.integration.test.ts.
    expect(alter!).toMatch(/image_input \? 'state'/)
    expect(alter!).toMatch(
      /COALESCE\(\s*image_input->>'state' IN \('supported','unsupported','unknown'\),\s*false\s*\)/
    )
    expect(alter!).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/)
    // Additive only.
    expect(alter!).not.toMatch(/DROP COLUMN/)
  })

  it('0115 is purely additive: it adds the column and writes no image_input data', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const calls = clientQuery.mock.calls.map(([sql, params]) => ({
      sql: String(sql),
      params: params as unknown[],
    }))

    // Liveness witness FIRST: the migration this test is about actually ran.
    // Without it, deleting 0115 outright would satisfy both negatives below.
    expect(calls.find(c => /ADD COLUMN IF NOT EXISTS image_input JSONB/.test(c.sql))).toBeDefined()

    // Evidence is derived by the catalog sync from models.dev, never seeded by a
    // migration: a seed can only write `curated` provenance, which the sync is
    // required never to overwrite, so it would permanently freeze the very rows
    // that need refreshing.
    expect(calls.filter(c => /SET image_input/.test(c.sql))).toHaveLength(0)
    expect(
      calls.filter(c => /UPDATE llm_allowed_models/.test(c.sql) && /image_input/.test(c.sql))
    ).toHaveLength(0)
  })
})
