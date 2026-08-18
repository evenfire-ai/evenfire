/**
 * §4.5 sanity guard — three orthogonal layers over the vanished→stale inference.
 * Fixtures trimmed from the real snapshot (T1); assertions on observable row
 * state (T4).
 *
 *   L1 gate     — only a LIVE catalog stales (vendored never does).
 *   L2 provider — a provider with <floor live models but existing discovery rows
 *                 is NOT stale-marked.
 *   L3 global   — a LIVE run whose TOTAL is below the absolute floor suppresses
 *                 ALL stale-marking, but inert `enabled=false` inserts proceed.
 *
 * Accepted gap (documented): the SURGICAL case (one model of a full provider
 * vanishes) IS stale-marked — stale is recoverable/non-destructive; the guard
 * blinds the NOISY failure (mass-stale), not the surgical one.
 */
import { describe, expect, it, vi } from 'vitest'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import { loadStub, trimSnapshot } from './helpers/modelsDevFixtures.js'

vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}))

describe('§4.5 sanity guard', () => {
  it('L1 — a VENDORED fallback never stales a vanished discovery row', async () => {
    const db = makeFakeDb([
      { provider: 'claude', model: 'claude-legacy-x', source: 'discovery', stale: false },
    ])
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5'] })

    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'vendored'), minPlausibleLiveTotal: 1 },
      db.connector
    )

    expect(db.get('claude', 'claude-legacy-x')!.stale).toBe(false)
    expect(res.staled).toBe(0)
  })

  it('L2 — a provider that returns 0 live but has discovery rows is NOT mass-staled', async () => {
    const db = makeFakeDb([
      // gemini (models.dev key `google`) has TWO discovery rows...
      { provider: 'gemini', model: 'gemini-old-a', source: 'discovery' },
      { provider: 'gemini', model: 'gemini-old-b', source: 'discovery' },
      // ...while claude has a genuinely-vanished row, in a run where anthropic is present.
      { provider: 'claude', model: 'claude-legacy-x', source: 'discovery' },
    ])
    // Catalog carries anthropic (claude present, floor cleared) but NO google key
    // → gemini comes back with 0 live models.
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5'] })

    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1 },
      db.connector
    )

    // Per-provider floor protects the 0-live provider entirely.
    expect(db.get('gemini', 'gemini-old-a')!.stale).toBe(false)
    expect(db.get('gemini', 'gemini-old-b')!.stale).toBe(false)
    // But a normally-present provider's vanished row IS staled (proves it is
    // per-provider, not a global off-switch).
    expect(db.get('claude', 'claude-legacy-x')!.stale).toBe(true)
    expect(res.staled).toBe(1)
  })

  it('L2 with N>0 — an implausibly-LOW provider count (below the floor) is protected', async () => {
    const db = makeFakeDb([{ provider: 'claude', model: 'claude-legacy-x', source: 'discovery' }])
    // anthropic returns exactly ONE live model; with providerMinLive=3 that is
    // below the floor → suspicious → no stale-marking for claude.
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5'] })

    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1, providerMinLive: 3 },
      db.connector
    )

    expect(db.get('claude', 'claude-legacy-x')!.stale).toBe(false)
    expect(res.staled).toBe(0)
  })

  it('L3 — a below-floor global total suppresses ALL stale-marking, but inserts proceed', async () => {
    const db = makeFakeDb([
      // A vanished discovery row that WOULD be staled if the guard let the run through.
      { provider: 'claude', model: 'claude-legacy-x', source: 'discovery' },
    ])
    // A tiny LIVE catalog: one NEW model (insert must proceed) — total well below
    // the injected floor of 9999.
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5'] })

    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 9999 },
      db.connector
    )

    // Stale-marking suppressed for the WHOLE run.
    expect(db.get('claude', 'claude-legacy-x')!.stale).toBe(false)
    expect(res.staled).toBe(0)
    // The inert insert of the new model STILL happened (enabled=false, discovery).
    const inserted = db.get('claude', 'claude-opus-4-5')
    expect(inserted).toBeDefined()
    expect(inserted!.enabled).toBe(false)
    expect(inserted!.source).toBe('discovery')
    expect(res.added).toBe(1)
  })

  it('cold start — empty DB: 0 rows staled (the "100%" case never happens)', async () => {
    const db = makeFakeDb([]) // no rows at all
    const catalog = trimSnapshot({ anthropic: ['claude-opus-4-5', 'claude-sonnet-5'] })

    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1 },
      db.connector
    )

    expect(res.staled).toBe(0)
    // New rows were inserted, all disabled.
    expect(res.added).toBe(2)
    expect(db.rows.every(r => r.enabled === false)).toBe(true)
    expect(db.rows.every(r => r.stale === false)).toBe(true)
  })

  it('surgical case (accepted gap) — one model of a full provider vanishes → IS staled', async () => {
    const db = makeFakeDb([
      // The vanished one.
      { provider: 'claude', model: 'claude-legacy-x', source: 'discovery' },
      // A model that stays listed.
      { provider: 'claude', model: 'claude-opus-4-5', source: 'discovery' },
    ])
    // anthropic comes back with MANY live models (well above any floor), just
    // without claude-legacy-x.
    const catalog = trimSnapshot({
      anthropic: [
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'claude-opus-4-6',
        'claude-sonnet-5',
      ],
    })

    const res = await syncDiscoveredModels(
      { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1, providerMinLive: 0 },
      db.connector
    )

    expect(db.get('claude', 'claude-legacy-x')!.stale).toBe(true)
    expect(db.get('claude', 'claude-opus-4-5')!.stale).toBe(false)
    expect(res.staled).toBe(1)
  })
})
