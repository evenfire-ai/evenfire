import { describe, expect, it, vi } from 'vitest'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import type { RawModelsDevCatalog } from '../src/services/modelsDevClient.js'

type Row = Record<string, unknown>

/**
 * A fake transactional client that routes queries by SQL shape. `existing` maps
 * provider → the rows the per-provider SELECT should return (id/model/source).
 * It records the INSERT/UPDATE/stale calls so tests can assert branch behavior.
 */
function makeConnector(
  existing: Record<string, Array<{ id: string; model: string; source: string }>>
) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (/SELECT id, model, source FROM llm_allowed_models WHERE provider/.test(sql)) {
      const provider = String(params[0])
      const rows: Row[] = (existing[provider] ?? []).map(r => ({ ...r }))
      return { rows, rowCount: rows.length }
    }
    if (/INSERT INTO llm_allowed_models/.test(sql)) {
      return { rows: [], rowCount: 1 }
    }
    if (/UPDATE llm_allowed_models[\s\S]*SET last_seen_at/.test(sql)) {
      return { rows: [], rowCount: 1 }
    }
    if (/UPDATE llm_allowed_models[\s\S]*SET stale = true/.test(sql)) {
      // Report a stale transition for the vanished-row test (claude provider).
      const provider = String(params[0])
      return { rows: [], rowCount: provider === 'claude' ? 1 : 0 }
    }
    if (/INSERT INTO llm_catalog_sync_runs/.test(sql)) {
      return { rows: [{ ran_at: new Date('2026-07-13T00:00:00Z') }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  const release = vi.fn()
  const connector = { connect: vi.fn(async () => ({ query, release })) }
  return { connector, calls, query, release }
}

function catalogWith(
  models: Record<string, { id: string; name?: string; limit?: { context?: number } }>
): RawModelsDevCatalog {
  return { anthropic: { name: 'Anthropic', models } }
}

function loadStub(catalog: RawModelsDevCatalog, source: 'live' | 'vendored' = 'vendored') {
  return async () => ({ source, fetchedAt: '2026-07-13T00:00:00.000Z', catalog })
}

const CALL_FOR = (calls: Array<{ sql: string; params: unknown[] }>, re: RegExp) =>
  calls.filter(c => re.test(c.sql))

describe('syncDiscoveredModels — source-guarded reconciliation', () => {
  it('INSERTs a new discovered model as disabled discovery (enabled=false, ON CONFLICT DO NOTHING)', async () => {
    const { connector, calls } = makeConnector({}) // no existing rows anywhere
    const catalog = catalogWith({
      'claude-opus-4-5': { id: 'claude-opus-4-5', name: 'Opus', limit: { context: 200000 } },
    })
    const res = await syncDiscoveredModels({ loadCatalog: loadStub(catalog) }, connector)

    const inserts = CALL_FOR(calls, /INSERT INTO llm_allowed_models/)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].sql).toMatch(/enabled/)
    expect(inserts[0].sql).toMatch(/'discovery'/)
    expect(inserts[0].sql).toMatch(/false/)
    expect(inserts[0].sql).toMatch(/ON CONFLICT \(provider, model\) DO NOTHING/)
    // params: provider, model, ctx, display
    expect(inserts[0].params).toEqual(['claude', 'claude-opus-4-5', 200000, 'Opus'])
    expect(res.added).toBe(1)
    expect(res.updated).toBe(0)
  })

  it('NEVER touches a colliding source=manual row (invisible to discovery)', async () => {
    const { connector, calls } = makeConnector({
      claude: [{ id: 'm1', model: 'claude-opus-4-5', source: 'manual' }],
    })
    const catalog = catalogWith({
      'claude-opus-4-5': { id: 'claude-opus-4-5', name: 'Opus' },
    })
    const res = await syncDiscoveredModels({ loadCatalog: loadStub(catalog) }, connector)

    // No INSERT and no last_seen UPDATE for the manual-shadowed model.
    expect(CALL_FOR(calls, /INSERT INTO llm_allowed_models/)).toHaveLength(0)
    expect(CALL_FOR(calls, /SET last_seen_at/)).toHaveLength(0)
    expect(res.added).toBe(0)
    expect(res.updated).toBe(0)
  })

  it('NULL-FILLs a present discovery row (COALESCE) and never overwrites enabled', async () => {
    const { connector, calls } = makeConnector({
      claude: [{ id: 'd1', model: 'claude-opus-4-5', source: 'discovery' }],
    })
    const catalog = catalogWith({
      'claude-opus-4-5': { id: 'claude-opus-4-5', name: 'Opus', limit: { context: 200000 } },
    })
    const res = await syncDiscoveredModels({ loadCatalog: loadStub(catalog) }, connector)

    const updates = CALL_FOR(calls, /SET last_seen_at/)
    expect(updates).toHaveLength(1)
    const sql = updates[0].sql
    expect(sql).toMatch(/COALESCE\(context_window_tokens/)
    expect(sql).toMatch(/COALESCE\(display_name/)
    expect(sql).toMatch(/stale = false/)
    // The serialized columns are CASE-guarded to disabled rows only, so an
    // ENABLED discovery row (already in the CM) is never mutated → no CM drift.
    expect(sql).toMatch(/CASE\s+WHEN enabled THEN context_window_tokens/)
    expect(sql).toMatch(/CASE\s+WHEN enabled THEN display_name/)
    // `enabled` is never assigned in the SET clause.
    expect(/enabled\s*=/.test(sql)).toBe(false)
    expect(updates[0].params).toEqual(['d1', 200000, 'Opus'])
    expect(res.updated).toBe(1)
    expect(res.added).toBe(0)
  })

  it('flags vanished discovery rows stale from a LIVE catalog (never delete, never disable)', async () => {
    const { connector, calls } = makeConnector({
      // A discovery row exists but the catalog no longer lists it.
      claude: [{ id: 'gone', model: 'claude-legacy', source: 'discovery' }],
    })
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    // This test isolates the vanished→stale reconciliation, not the §4.5
    // plausibility floor. The tiny 1-model catalog would otherwise trip the
    // global floor (default 100), so lower it here to exercise stale-marking.
    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1 },
      connector
    )

    const staleUpdates = CALL_FOR(calls, /SET stale = true/)
    // One stale UPDATE per provider is issued; assert none delete / disable.
    expect(staleUpdates.length).toBeGreaterThan(0)
    for (const u of staleUpdates) {
      expect(u.sql).not.toMatch(/DELETE/i)
      expect(/enabled\s*=\s*false/.test(u.sql)).toBe(false)
      expect(u.sql).toMatch(/source = 'discovery'/)
      expect(u.sql).toMatch(/model <> ALL/)
    }
    expect(res.staled).toBe(1)
  })

  it('does NOT stale anything on a VENDORED fallback (snapshot is not authoritative)', async () => {
    const { connector, calls } = makeConnector({
      // Same vanished discovery row, but the run fell back to the vendored
      // snapshot (live fetch failed) — a transient blip must not stale a live model.
      claude: [{ id: 'gone', model: 'claude-legacy', source: 'discovery' }],
    })
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'vendored') },
      connector
    )

    // No stale UPDATE is issued at all on a vendored run.
    expect(CALL_FOR(calls, /SET stale = true/)).toHaveLength(0)
    expect(res.staled).toBe(0)
    // Inserts / last_seen refresh still happen (harmless from vendored data).
    expect(res.source).toBe('vendored')
  })

  it('runs inside a transaction, takes the advisory lock, persists a run row, and returns the source', async () => {
    const { connector, calls, release } = makeConnector({})
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    const res = await syncDiscoveredModels({ loadCatalog: loadStub(catalog, 'live') }, connector)

    expect(CALL_FOR(calls, /^BEGIN$/)).toHaveLength(1)
    expect(CALL_FOR(calls, /pg_advisory_xact_lock/)).toHaveLength(1)
    expect(CALL_FOR(calls, /^COMMIT$/)).toHaveLength(1)
    const runInsert = CALL_FOR(calls, /INSERT INTO llm_catalog_sync_runs/)
    expect(runInsert).toHaveLength(1)
    expect(runInsert[0].params[0]).toBe('live') // source persisted
    expect(runInsert[0].sql).toMatch(/RETURNING ran_at/)
    expect(res.source).toBe('live')
    // fetchedAt = catalog acquisition time (loader); ranAt = DB commit time (run row).
    expect(res.fetchedAt).toBe('2026-07-13T00:00:00.000Z')
    expect(res.ranAt).toBe('2026-07-13T00:00:00.000Z')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back and releases on a mid-transaction failure', async () => {
    const existing = { claude: [] as Array<{ id: string; model: string; source: string }> }
    const { connector, query, release } = makeConnector(existing)
    // Make the run-summary INSERT explode after the reconciliation writes.
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO llm_catalog_sync_runs/.test(sql)) throw new Error('boom')
      if (/SELECT id, model, source/.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    await expect(
      syncDiscoveredModels({ loadCatalog: loadStub(catalog) }, connector)
    ).rejects.toThrow('boom')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })
})
