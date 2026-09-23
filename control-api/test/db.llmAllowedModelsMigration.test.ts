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

describe('0056_llm_allowed_models migration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue({
      query: clientQuery,
      release: clientRelease,
    })
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('creates both tables, the (provider, model) unique index, and seeds the 25 static models', async () => {
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

    const seed = sqls.find(
      sql =>
        sql.includes('INSERT INTO llm_allowed_models') && sql.includes('ON CONFLICT DO NOTHING')
    )
    expect(seed).toBeDefined()
    // 25 seed rows = 25 value tuples of the shape ('provider', 'model', 'Vendor')
    const tupleCount = (seed!.match(/\(\s*'[^']+',\s*'[^']+',\s*'[^']+'\s*\)/g) || []).length
    expect(tupleCount).toBe(25)
    // Vendor coverage per the spec mapping
    expect(seed).toContain("('claude', 'claude-haiku-4-5', 'Anthropic')")
    expect(seed).toContain("('zai', 'glm-4.7', 'Zhipu')")
    expect(seed).toContain("('bailian', 'MiniMax-M2.5', 'MiniMax')")
    expect(seed).toContain("('bailian', 'kimi-k2.5', 'Moonshot')")
    expect(seed).toContain("('bailian', 'qwen3-coder-plus', 'Alibaba')")
    expect(seed).toContain("('bailian', 'glm-4.7', 'Zhipu')")
  })

  it('0057 seeds the Vertex/Bedrock rows (R4) idempotently', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    // The R4 seed is a distinct INSERT that carries the vertex/bedrock rows.
    const seed = sqls.find(
      sql =>
        sql.includes('INSERT INTO llm_allowed_models') &&
        sql.includes('ON CONFLICT DO NOTHING') &&
        sql.includes('vertex')
    )
    expect(seed).toBeDefined()
    expect(seed).toContain("('vertex', 'gemini-2.5-pro', 'Google')")
    expect(seed).toContain("('vertex', 'gemini-2.5-flash', 'Google')")
    // Bedrock model ids are runtime-specific (distinct from native `claude` ids).
    expect(seed).toContain("('bedrock', 'anthropic.claude-sonnet-4-6-v1:0', 'Anthropic')")
    expect(seed).toContain("('bedrock', 'anthropic.claude-haiku-4-5-v1:0', 'Anthropic')")
  })

  it('0058 seeds the 14 new single-key providers and skips azure', async () => {
    const { initDb } = await import('../src/db.js')
    await initDb()
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql))

    // The new-providers seed is the distinct INSERT that carries e.g. groq.
    const seed = sqls.find(
      sql =>
        sql.includes('INSERT INTO llm_allowed_models') &&
        sql.includes('ON CONFLICT DO NOTHING') &&
        sql.includes("('groq',")
    )
    expect(seed).toBeDefined()
    // 14 seed rows = 14 value tuples (azure excluded — deployment-name models).
    const tupleCount = (seed!.match(/\(\s*'[^']+',\s*'[^']+',\s*'[^']+'\s*\)/g) || []).length
    expect(tupleCount).toBe(14)
    expect(seed).toContain("('openrouter', 'anthropic/claude-sonnet-latest', 'OpenRouter')")
    expect(seed).toContain("('gemini', 'gemini-2.5-flash', 'Google')")
    expect(seed).toContain("('groq', 'llama-3.3-70b-versatile', 'Meta')")
    // Slash-bearing model strings are stored verbatim as data.
    expect(seed).toContain("('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Meta')")
    expect(seed).toContain("('nebius', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'Alibaba')")
    // azure is never seeded — its models are per-deployment names.
    expect(seed).not.toContain("('azure',")
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
    expect(sqls.some(sql => /UPDATE llm_allowed_models[\s\S]*source/.test(sql))).toBe(false)
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
