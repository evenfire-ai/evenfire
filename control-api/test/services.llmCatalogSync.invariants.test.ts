/**
 * Load-bearing invariants of the catalog sync that the Fase-4 cron MUST NOT
 * break (spec 09 §2.2 / §4.5). Written FIRST (T5) and asserted against the
 * EXISTING sync — they encode behavior we are preserving, not adding.
 *
 * Fixtures are trimmed from the real vendored snapshot (T1); assertions are on
 * OBSERVABLE ROW / ConfigMap state (T4), never on intermediate SQL.
 */
import { describe, expect, it, vi } from 'vitest'
import { listEnabledGroupedByProvider } from '../src/services/llmAllowedModels.js'
import { buildConfigMapData } from '../src/services/llmAllowedModelsConfigMap.js'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import { loadStub, trimSnapshot, withModalities } from './helpers/modelsDevFixtures.js'

vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}))

// A low global floor so these invariant runs never trip the layer-3 guard —
// each invariant is about the stale/enabled mechanics, not the guard.
const LOW_FLOOR = { minPlausibleLiveTotal: 1 }

describe('catalog sync — load-bearing invariants (Fase 4)', () => {
  it('(i) NEVER disables: a vanished model keeps `enabled`, only `stale` flips', async () => {
    const db = makeFakeDb([
      // An ENABLED discovery model that the catalog still lists → stays enabled, not stale.
      { provider: 'claude', model: 'claude-opus-4-5', source: 'discovery', enabled: true },
      // An ENABLED discovery model that VANISHES → must keep enabled, only stale flips.
      { provider: 'claude', model: 'claude-legacy-x', source: 'discovery', enabled: true },
      // A disabled discovery model that vanishes → stale flips too.
      { provider: 'claude', model: 'claude-legacy-y', source: 'discovery', enabled: false },
    ])
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5'] })

    await syncDiscoveredModels(
      { materializer: db.materializer, loadCatalog: loadStub(catalog, 'live'), ...LOW_FLOOR },
      db.connector
    )

    // enabled is UNTOUCHED on every row.
    expect(db.get('claude', 'claude-opus-4-5')!.enabled).toBe(true)
    expect(db.get('claude', 'claude-legacy-x')!.enabled).toBe(true)
    expect(db.get('claude', 'claude-legacy-y')!.enabled).toBe(false)
    // Only vanished rows flipped stale; the still-listed one did not.
    expect(db.get('claude', 'claude-opus-4-5')!.stale).toBe(false)
    expect(db.get('claude', 'claude-legacy-x')!.stale).toBe(true)
    expect(db.get('claude', 'claude-legacy-y')!.stale).toBe(true)
  })

  it('(ii) stale is auto-healing: a re-listed model flips stale back to false', async () => {
    const db = makeFakeDb([
      { provider: 'claude', model: 'claude-opus-4-5', source: 'discovery', stale: true },
    ])
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5'] })

    await syncDiscoveredModels(
      { materializer: db.materializer, loadCatalog: loadStub(catalog, 'live'), ...LOW_FLOOR },
      db.connector
    )

    expect(db.get('claude', 'claude-opus-4-5')!.stale).toBe(false)
  })

  it('(iii) a stale+enabled row is STILL materialized into the ConfigMap (stale ignored)', async () => {
    const db = makeFakeDb([
      {
        provider: 'claude',
        model: 'claude-opus-4-5',
        source: 'discovery',
        enabled: true,
        stale: true,
        display_name: 'Claude Opus 4.5',
        context_window_tokens: 200000,
      },
      // A disabled row must NOT appear in the CM regardless of stale.
      { provider: 'claude', model: 'claude-sonnet-5', source: 'discovery', enabled: false },
    ])

    // Drive the REAL materializer read against the fake db, then build the CM.
    const client = await db.connector.connect()
    const grouped = await listEnabledGroupedByProvider({ query: client.query })
    const { data } = buildConfigMapData(grouped)

    expect(data.claude).toBeDefined()
    const models = (JSON.parse(data.claude) as Array<{ model: string }>).map(m => m.model)
    expect(models).toContain('claude-opus-4-5') // stale + enabled → present
    expect(models).not.toContain('claude-sonnet-5') // disabled → absent
  })

  it('does not discover or stale Codex subscription rows from models.dev', async () => {
    const db = makeFakeDb([
      { provider: 'codex-subscription', model: 'gpt-5', source: 'discovery', enabled: false },
    ])
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5'] })
    await syncDiscoveredModels(
      { materializer: db.materializer, loadCatalog: loadStub(catalog, 'live'), ...LOW_FLOOR },
      db.connector
    )
    expect(db.get('codex-subscription', 'gpt-5')?.stale).toBe(false)
    expect(
      db.rows.some(row => row.provider === 'codex-subscription' && row.model !== 'gpt-5')
    ).toBe(false)
  })

  it('#654 derives image_input from modalities without clobbering curated or newer discovery evidence', async () => {
    const CAPTURED_AT = '2026-08-19T16:16:10.000Z'
    const TTL_MS = 30 * 24 * 60 * 60 * 1000
    const curated = {
      state: 'supported' as const,
      evidence: {
        source: 'curated' as const,
        reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
        checkedAt: '2026-09-16T00:00:00.000Z',
      },
    }
    const oldDiscovery = {
      state: 'unknown' as const,
      evidence: {
        source: 'discovery' as const,
        reference: 'https://models.dev/api.json',
        checkedAt: '2026-07-01T00:00:00.000Z',
      },
    }
    // Captured AFTER this run's catalog: a later observation must never be
    // regressed by an older one (a vendored fallback after a live sync).
    const newerDiscovery = {
      state: 'supported' as const,
      evidence: {
        source: 'discovery' as const,
        reference: 'https://models.dev/api.json',
        checkedAt: '2026-09-01T00:00:00.000Z',
        validUntil: '2026-10-01T00:00:00.000Z',
      },
    }
    const db = makeFakeDb([
      // Enabled + curated: published, must stay byte-identical.
      {
        provider: 'claude',
        model: 'claude-opus-4-5',
        source: 'discovery',
        enabled: true,
        image_input: curated,
      },
      // Disabled + curated: an operator decision that discovery must not undo.
      {
        provider: 'claude',
        model: 'claude-sonnet-5',
        source: 'discovery',
        enabled: false,
        image_input: curated,
      },
      // Disabled + older discovery provenance: refreshed from this catalog.
      {
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
        source: 'discovery',
        enabled: false,
        image_input: oldDiscovery,
      },
      // ENABLED + older discovery provenance: also refreshed. The freeze the
      // other serialized columns obey would expire this row's evidence one TTL
      // after its only stamp, with no way back short of manual curation.
      {
        provider: 'claude',
        model: 'claude-opus-4-1',
        source: 'discovery',
        enabled: true,
        image_input: oldDiscovery,
      },
      // ENABLED + NEWER discovery provenance: untouched (monotonic guard).
      {
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        source: 'discovery',
        enabled: true,
        image_input: newerDiscovery,
      },
    ])
    const catalog = withModalities(
      trimSnapshot({
        anthropic: [
          'claude-opus-4-5',
          'claude-sonnet-5',
          'claude-haiku-4-5-20251001',
          'claude-opus-4-1',
          'claude-sonnet-4-5',
          // Absent from the DB → this run INSERTs it (disabled discovery row).
          'claude-opus-4-7',
        ],
      }),
      {
        'claude-haiku-4-5-20251001': ['text', 'image'],
        'claude-opus-4-1': ['text'],
        'claude-sonnet-4-5': ['text', 'image'],
        'claude-opus-4-7': ['text', 'image'],
      }
    )

    await syncDiscoveredModels(
      {
        materializer: db.materializer,
        loadCatalog: loadStub(catalog, 'live', CAPTURED_AT),
        imageEvidenceTtlMs: TTL_MS,
        ...LOW_FLOOR,
      },
      db.connector
    )

    const discovered = (state: 'supported' | 'unsupported') => ({
      state,
      evidence: {
        source: 'discovery',
        reference: 'https://models.dev/api.json',
        checkedAt: CAPTURED_AT,
        validUntil: new Date(Date.parse(CAPTURED_AT) + TTL_MS).toISOString(),
      },
    })

    // Curated evidence is untouchable, enabled or not.
    expect(db.get('claude', 'claude-opus-4-5')!.image_input).toEqual(curated)
    expect(db.get('claude', 'claude-sonnet-5')!.image_input).toEqual(curated)
    // Older discovery evidence is replaced by this catalog's verdict — and the
    // enabled row is replaced too, because a frozen one would silently expire.
    expect(db.get('claude', 'claude-haiku-4-5-20251001')!.image_input).toEqual(
      discovered('supported')
    )
    expect(db.get('claude', 'claude-opus-4-1')!.image_input).toEqual(discovered('unsupported'))
    // A NEWER capture is never regressed by this older one.
    expect(db.get('claude', 'claude-sonnet-4-5')!.image_input).toEqual(newerDiscovery)
    // A freshly inserted row is born disabled, and carries the catalog's verdict.
    const inserted = db.get('claude', 'claude-opus-4-7')!
    expect(inserted.enabled).toBe(false)
    expect(inserted.image_input).toEqual(discovered('supported'))
    // Witness for every "unchanged" above: the run really did visit each row.
    expect(db.connector.connect).toHaveBeenCalled()
    for (const model of ['claude-opus-4-5', 'claude-sonnet-5', 'claude-sonnet-4-5']) {
      const id = db.get('claude', model)!.id
      expect(
        db.calls.some(call => /SET last_seen_at/.test(call.sql) && call.params[0] === id)
      ).toBe(true)
    }
    // Two enabled rows changed evidence → the ConfigMap is republished once.
    expect(db.materializer.materialize).toHaveBeenCalledTimes(1)
  })
})
