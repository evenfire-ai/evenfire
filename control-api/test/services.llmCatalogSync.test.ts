import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registry } from '../src/observability/metrics.js'
import { AllowlistPublishRetry } from '../src/services/llmAllowlistPublishRetry.js'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import type { RawModelsDevCatalog } from '../src/services/modelsDevClient.js'

type Row = Record<string, unknown>

/**
 * The sync REQUIRES a ConfigMap materializer (#654) — it can change what runtime
 * is served. These tests assert SQL shape and call order only; what a publish
 * writes is covered against the real writer in services.llmAllowlistPublication.
 */
const materializer = {
  materialize: vi.fn(async () => {}),
  materializeIfChanged: vi.fn(async () => 'unchanged' as 'written' | 'unchanged'),
}

beforeEach(() => {
  materializer.materialize.mockReset()
  materializer.materializeIfChanged.mockReset()
  materializer.materializeIfChanged.mockResolvedValue('unchanged')
})

/**
 * A fake transactional client that routes queries by SQL shape. `existing` maps
 * provider → the rows the per-provider SELECT should return (id/model/source).
 * It records the INSERT/UPDATE/stale calls so tests can assert branch behavior.
 */
function makeConnector(
  existing: Record<string, Array<{ id: string; model: string; source: string }>>,
  // What the discovery UPDATE's RETURNING clause reports. The default says the
  // touched row is disabled, which is what every SQL-shape test below wants: a
  // disabled row can never force a ConfigMap write.
  updateReturning: Row = { enabled: false, image_input_changed: false }
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
      return { rows: [updateReturning], rowCount: 1 }
    }
    // The manual-row statement reports through the SAME RETURNING contract, so
    // it answers with the same row: a test that flips `updateReturning` to an
    // enabled row must be able to drive publication from either branch.
    if (/UPDATE llm_allowed_models[\s\S]*t\.source = 'manual'/.test(sql)) {
      return { rows: [updateReturning], rowCount: 1 }
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
  models: Record<
    string,
    {
      id: string
      name?: string
      limit?: { context?: number }
      modalities?: { input?: unknown }
    }
  >
): RawModelsDevCatalog {
  return { anthropic: { name: 'Anthropic', models } }
}

/**
 * The same, under groq: a provider whose auto-enable policy is OFF by default,
 * so a vendored run still inserts its new models (disabled). Under claude (ON
 * by default) such a run skips them, because it cannot decide.
 */
function groqCatalogWith(models: Parameters<typeof catalogWith>[0]): RawModelsDevCatalog {
  return { groq: { name: 'Groq', models } }
}

function loadStub(
  catalog: RawModelsDevCatalog,
  source: 'live' | 'vendored' = 'vendored',
  // `fetchedAt` is the run's acquisition time; `capturedAt` is when the DATA was
  // captured (a vendored snapshot's baked date). Kept distinct on purpose.
  capturedAt = '2026-07-10T00:00:00.000Z'
) {
  return async () => ({
    source,
    fetchedAt: '2026-07-13T00:00:00.000Z',
    capturedAt,
    catalog,
  })
}

const CALL_FOR = (calls: Array<{ sql: string; params: unknown[] }>, re: RegExp) =>
  calls.filter(c => re.test(c.sql))

/**
 * Current value of `clerum_llm_allowlist_configmap_write_failures_total{phase}`.
 * Read from the real registry rather than a spy: the point of the assertion is
 * that the operator-visible counter moved.
 */
async function configMapWriteFailures(phase: string): Promise<number> {
  const metric = registry.getSingleMetric('clerum_llm_allowlist_configmap_write_failures_total')
  const collected = (await metric?.get()) as
    | { values: Array<{ labels: Record<string, unknown>; value: number }> }
    | undefined
  return collected?.values.find(v => v.labels.phase === phase)?.value ?? 0
}

/**
 * The exact provenance payload discovery persists for a model the catalog says
 * nothing about. A KNOWN state additionally carries `validUntil` — the shared
 * contract refuses a discovery claim without an expiry — and is asserted as a
 * parsed object below, since only key ORDER would differ here.
 */
function discoveryProvenance(capturedAt: string): string {
  return JSON.stringify({
    state: 'unknown',
    evidence: {
      source: 'discovery',
      reference: 'https://models.dev/api.json',
      checkedAt: capturedAt,
    },
  })
}

describe('syncDiscoveredModels — source-guarded reconciliation', () => {
  it('INSERTs a new discovered model as disabled discovery (enabled=false, ON CONFLICT DO NOTHING)', async () => {
    const { connector, calls } = makeConnector({}) // no existing rows anywhere
    const catalog = groqCatalogWith({
      'llama-3.3-70b': { id: 'llama-3.3-70b', name: 'Llama', limit: { context: 200000 } },
    })
    const res = await syncDiscoveredModels(
      { materializer, loadCatalog: loadStub(catalog) },
      connector
    )

    const inserts = CALL_FOR(calls, /INSERT INTO llm_allowed_models/)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].sql).toMatch(/enabled/)
    expect(inserts[0].sql).toMatch(/'discovery'/)
    expect(inserts[0].sql).toMatch(/false/)
    expect(inserts[0].sql).toMatch(/ON CONFLICT \(provider, model\) DO NOTHING/)
    // params: provider, model, ctx, display, image_input, enable decision,
    // catalog_status. The decision is false: groq's policy is off by default.
    expect(inserts[0].params).toEqual([
      'groq',
      'llama-3.3-70b',
      200000,
      'Llama',
      discoveryProvenance('2026-07-10T00:00:00.000Z'),
      false,
      null,
    ])
    expect(res.added).toBe(1)
    expect(res.updated).toBe(0)
  })

  it('#654 stamps discovery provenance with the SOURCE capture time, never `fetchedAt`', async () => {
    const { connector, calls } = makeConnector({})
    const catalog = groqCatalogWith({
      // Says nothing about modalities …
      'llama-3.3-70b': { id: 'llama-3.3-70b' },
      // … and one that does, so the KNOWN-state payload is covered too.
      'llama-4-scout': {
        id: 'llama-4-scout',
        modalities: { input: ['text', 'image'] },
      },
    })
    // The stub's fetchedAt (acquisition) deliberately differs from capturedAt.
    await syncDiscoveredModels(
      {
        materializer,
        loadCatalog: loadStub(catalog, 'vendored', '2026-08-19T16:16:10.000Z'),
        imageEvidenceTtlMs: 30 * 24 * 60 * 60 * 1000,
      },
      connector
    )

    const inserts = CALL_FOR(calls, /INSERT INTO llm_allowed_models/)
    const byModel = new Map(inserts.map(c => [String(c.params[1]), c]))
    const opus = byModel.get('llama-3.3-70b')!
    const persisted = JSON.parse(String(opus.params[4]))
    expect(persisted).toEqual({
      state: 'unknown',
      evidence: {
        source: 'discovery',
        reference: 'https://models.dev/api.json',
        checkedAt: '2026-08-19T16:16:10.000Z',
      },
    })
    // Reloading a stale snapshot must not manufacture freshness.
    expect(String(opus.params[4])).not.toContain('2026-07-13T00:00:00.000Z')
    // An entry the catalog said nothing about stays unknown — and, being
    // unknown, carries no expiry to state.
    expect(persisted.evidence.validUntil).toBeUndefined()

    // A KNOWN state must carry an expiry, and it is derived from the CAPTURE
    // time: a vendored snapshot may only claim support for as long as it is
    // fresh (capturedAt + 30d, NOT fetchedAt + 30d).
    const sonnet = JSON.parse(String(byModel.get('llama-4-scout')!.params[4]))
    expect(sonnet).toEqual({
      state: 'supported',
      evidence: {
        source: 'discovery',
        reference: 'https://models.dev/api.json',
        checkedAt: '2026-08-19T16:16:10.000Z',
        validUntil: '2026-09-18T16:16:10.000Z',
      },
    })
  })

  it('throws when the shared contract rejects the discovery evidence it built', async () => {
    const { connector, calls } = makeConnector({})
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    // `checkedAt` must be a real date, so the shared parser refuses the payload
    // this capture stamp produces. Storing NULL instead would hide a programming
    // error behind a row that merely looks unexamined.
    await expect(
      syncDiscoveredModels(
        { materializer, loadCatalog: loadStub(catalog, 'live', 'not-a-timestamp') },
        connector
      )
    ).rejects.toThrow(/discoveryImageInput: shared contract rejected/)

    // Witness the run actually started (so the throw is the contract's, not a
    // connector that never opened) and that nothing was written after it.
    expect(CALL_FOR(calls, /^BEGIN$/)).toHaveLength(1)
    expect(CALL_FOR(calls, /INSERT INTO llm_allowed_models/)).toHaveLength(0)
  })

  it('touches ONLY image_input on a colliding source=manual row, through the same guard', async () => {
    const { connector, calls } = makeConnector({
      claude: [{ id: 'm1', model: 'claude-opus-4-5', source: 'manual' }],
    })
    const catalog = catalogWith({
      'claude-opus-4-5': { id: 'claude-opus-4-5', name: 'Opus', modalities: { input: ['text'] } },
    })
    const res = await syncDiscoveredModels(
      {
        materializer,
        loadCatalog: loadStub(catalog, 'live', '2026-08-19T16:16:10.000Z'),
        imageEvidenceTtlMs: 30 * 24 * 60 * 60 * 1000,
      },
      connector
    )

    // The row is still invisible to everything an operator authored.
    expect(CALL_FOR(calls, /INSERT INTO llm_allowed_models/)).toHaveLength(0)
    expect(CALL_FOR(calls, /SET last_seen_at/)).toHaveLength(0)
    expect(res.added).toBe(0)
    expect(res.updated).toBe(0)

    // …except `image_input`, written by exactly one statement (#654). This is
    // the liveness witness for the four negative assertions above: without it
    // they would also hold for a sync that never reached this row at all.
    const manual = CALL_FOR(calls, /t\.source = 'manual'/)
    expect(manual).toHaveLength(1)
    const sql = manual[0]!.sql
    expect(sql).toMatch(/SET image_input = CASE/)
    // Same guard as the discovery branch: NULL, or discovery evidence not newer.
    expect(sql).toMatch(/WHEN t\.image_input IS NULL THEN \$2::jsonb/)
    expect(sql).toMatch(
      /\(t\.image_input->'evidence'->>'checkedAt'\)::timestamptz <= \$3::timestamptz/
    )
    expect(sql).toMatch(
      /RETURNING t\.enabled, \(t\.image_input IS DISTINCT FROM prev\.image_input\)/
    )
    // Nothing else is ASSIGNED — asserted on the assignment TARGETS, not on a
    // substring search. `source` and `enabled` legitimately appear elsewhere in
    // this statement (the WHERE, the RETURNING, and the guard's
    // `evidence->>'source'`), so a substring search could not tell "never
    // written" from "mentioned" and would fail on a correct statement.
    const setClause = sql.slice(sql.indexOf('SET '), sql.indexOf('FROM llm_allowed_models AS prev'))
    const assigned = [...setClause.matchAll(/(?:SET|,)\s+([a-z_]+)\s*=/g)].map(m => m[1])
    expect(assigned).toEqual(['image_input'])
    expect(manual[0]!.params).toEqual([
      'm1',
      JSON.stringify({
        state: 'unsupported',
        evidence: {
          source: 'discovery',
          reference: 'https://models.dev/api.json',
          checkedAt: '2026-08-19T16:16:10.000Z',
          validUntil: '2026-09-18T16:16:10.000Z',
        },
      }),
      '2026-08-19T16:16:10.000Z',
      'claude',
      'claude-opus-4-5',
    ])
  })

  it('NULL-FILLs a present discovery row (COALESCE) and never overwrites enabled', async () => {
    const { connector, calls } = makeConnector({
      claude: [{ id: 'd1', model: 'claude-opus-4-5', source: 'discovery' }],
    })
    const catalog = catalogWith({
      'claude-opus-4-5': { id: 'claude-opus-4-5', name: 'Opus', limit: { context: 200000 } },
    })
    const res = await syncDiscoveredModels(
      { materializer, loadCatalog: loadStub(catalog) },
      connector
    )

    const updates = CALL_FOR(calls, /SET last_seen_at/)
    expect(updates).toHaveLength(1)
    const sql = updates[0].sql
    expect(sql).toMatch(/COALESCE\(t\.context_window_tokens/)
    expect(sql).toMatch(/COALESCE\(t\.display_name/)
    expect(sql).toMatch(/stale = false/)
    // The serialized columns are CASE-guarded to disabled rows only, so an
    // ENABLED discovery row (already in the CM) is never mutated → no CM drift.
    expect(sql).toMatch(/CASE\s+WHEN t\.enabled THEN t\.context_window_tokens/)
    expect(sql).toMatch(/CASE\s+WHEN t\.enabled THEN t\.display_name/)
    // `enabled` is never assigned in the SET clause.
    expect(/enabled\s*=/.test(sql)).toBe(false)
    // …then live?, catalog_status, and the pair the SELECT read.
    expect(updates[0].params).toEqual([
      'd1',
      200000,
      'Opus',
      discoveryProvenance('2026-07-10T00:00:00.000Z'),
      '2026-07-10T00:00:00.000Z',
      false,
      null,
      'claude',
      'claude-opus-4-5',
    ])
    expect(res.updated).toBe(1)
    expect(res.added).toBe(0)
  })

  it('refreshes image_input on enabled rows only when NULL or older discovery evidence', async () => {
    const { connector, calls } = makeConnector({
      claude: [{ id: 'd1', model: 'claude-opus-4-5', source: 'discovery' }],
    })
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    await syncDiscoveredModels({ materializer, loadCatalog: loadStub(catalog) }, connector)

    const sql = CALL_FOR(calls, /SET last_seen_at/)[0].sql
    // A row with no evidence gets the provenance …
    expect(sql).toMatch(/WHEN t\.image_input IS NULL THEN \$4::jsonb/)
    // … a discovery-sourced one is refreshed only by a capture at least as
    // recent as the one already recorded (compared as timestamptz, because
    // `…Z` and `….000Z` are the same instant but different strings) …
    expect(sql).toMatch(
      /t\.image_input->'evidence'->>'source' = 'discovery'[\s\S]*\(t\.image_input->'evidence'->>'checkedAt'\)::timestamptz <= \$5::timestamptz/
    )
    // … and anything else (operator-curated, or a newer capture) is untouched.
    expect(sql).toMatch(/ELSE t\.image_input/)
    // The run reports whether it actually changed an ENABLED row's evidence —
    // the only change that can make the served ConfigMap wrong.
    expect(sql).toMatch(
      /RETURNING t\.enabled, \(t\.image_input IS DISTINCT FROM prev\.image_input\)/
    )
    // image_input deliberately does NOT take the enabled-row freeze. Witness
    // that the freeze exists in this very statement for the other columns, so
    // its absence here is a choice and not a missing clause.
    expect(sql).toMatch(/WHEN t\.enabled THEN t\.context_window_tokens/)
    expect(/WHEN t\.enabled THEN t\.image_input/.test(sql)).toBe(false)
  })

  it('publishes by state after COMMIT and after releasing the run client', async () => {
    const { connector, calls, query, release } = makeConnector(
      { claude: [{ id: 'd1', model: 'claude-opus-4-5', source: 'discovery' }] },
      { enabled: true, image_input_changed: true }
    )
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    const res = await syncDiscoveredModels(
      { materializer, loadCatalog: loadStub(catalog) },
      connector
    )

    // The state-gated entry point, never the unconditional one.
    expect(materializer.materializeIfChanged).toHaveBeenCalledTimes(1)
    expect(materializer.materialize).not.toHaveBeenCalled()
    // AFTER commit, never inside the transaction: a ConfigMap write held open
    // would keep the advisory lock for the length of a call to the cluster.
    const commitCall = query.mock.calls.findIndex(c => /^COMMIT$/.test(String(c[0])))
    expect(commitCall).toBeGreaterThanOrEqual(0)
    const publishOrder = materializer.materializeIfChanged.mock.invocationCallOrder[0]
    expect(publishOrder).toBeGreaterThan(query.mock.invocationCallOrder[commitCall])
    // The run's client is back in the pool before the publish waits on its own
    // lock and connection.
    expect(release).toHaveBeenCalledTimes(1)
    expect(publishOrder).toBeGreaterThan(release.mock.invocationCallOrder[0])
    expect(res.enabledImageInputChanged).toBe(1)
    // `materialized` reports what the writer did, not the counter.
    expect(res.materialized).toBe(false)
    expect(CALL_FOR(calls, /SET last_seen_at/)).toHaveLength(1)
  })

  it('still publishes by state when no enabled row changed (the counter only observes)', async () => {
    const { connector, calls } = makeConnector(
      { claude: [{ id: 'd1', model: 'claude-opus-4-5', source: 'discovery' }] },
      { enabled: false, image_input_changed: true }
    )
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    const res = await syncDiscoveredModels(
      { materializer, loadCatalog: loadStub(catalog) },
      connector
    )

    // A run that changed nothing served still compares the CM with Postgres: an
    // earlier failed publish, or another writer's older snapshot, is repaired
    // here instead of never.
    expect(materializer.materializeIfChanged).toHaveBeenCalledTimes(1)
    expect(CALL_FOR(calls, /SET last_seen_at/)).toHaveLength(1)
    expect(res.updated).toBe(1)
    expect(res.enabledImageInputChanged).toBe(0)
    expect(res.materialized).toBe(false)
  })

  it('reports and rethrows a ConfigMap write failure after the transaction committed', async () => {
    const { connector, calls } = makeConnector(
      { claude: [{ id: 'd1', model: 'claude-opus-4-5', source: 'discovery' }] },
      { enabled: true, image_input_changed: true }
    )
    const catalog = catalogWith({ 'claude-opus-4-5': { id: 'claude-opus-4-5' } })
    const before = await configMapWriteFailures('sync')
    materializer.materializeIfChanged.mockRejectedValueOnce(new Error('apiserver unreachable'))
    const publishRetry = new AllowlistPublishRetry()

    await expect(
      syncDiscoveredModels(
        { materializer, publishRetry, loadCatalog: loadStub(catalog) },
        connector
      )
    ).rejects.toThrow('apiserver unreachable')
    // Only the publication is owed a retry; the run itself is not repeated.
    expect(publishRetry.isPending()).toBe(true)
    publishRetry.stop()

    // The rows are durable: the failure happened after COMMIT, and nothing rolls
    // back (that COMMIT is also the witness that the run reached the publish).
    expect(CALL_FOR(calls, /^COMMIT$/)).toHaveLength(1)
    expect(CALL_FOR(calls, /^ROLLBACK$/)).toHaveLength(0)
    expect(await configMapWriteFailures('sync')).toBe(before + 1)
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
      { materializer, loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1 },
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
      { materializer, loadCatalog: loadStub(catalog, 'vendored') },
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
    const res = await syncDiscoveredModels(
      { materializer, loadCatalog: loadStub(catalog, 'live') },
      connector
    )

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
    const existing = { groq: [] as Array<{ id: string; model: string; source: string }> }
    const { connector, query, release } = makeConnector(existing)
    const statements: string[] = []
    // Make the run-summary INSERT explode after the reconciliation writes.
    query.mockImplementation(async (sql: string) => {
      statements.push(sql)
      if (/INSERT INTO llm_catalog_sync_runs/.test(sql)) throw new Error('boom')
      if (/SELECT id, model, source/.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    // groq's policy is OFF by default, so this vendored run still writes the
    // new model before the failure; under claude it would write nothing.
    const catalog = groqCatalogWith({ 'llama-3.3-70b': { id: 'llama-3.3-70b' } })
    await expect(
      syncDiscoveredModels({ materializer, loadCatalog: loadStub(catalog) }, connector)
    ).rejects.toThrow('boom')
    const insertAt = statements.findIndex(sql => /INSERT INTO llm_allowed_models/.test(sql))
    const failAt = statements.findIndex(sql => /INSERT INTO llm_catalog_sync_runs/.test(sql))
    expect(insertAt).toBeGreaterThan(-1)
    expect(insertAt).toBeLessThan(failAt)
    expect(statements.indexOf('ROLLBACK')).toBeGreaterThan(failAt)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
