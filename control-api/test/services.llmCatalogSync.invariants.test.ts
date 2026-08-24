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
import { loadStub, trimSnapshot } from './helpers/modelsDevFixtures.js'

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
      { loadCatalog: loadStub(catalog, 'live'), ...LOW_FLOOR },
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
      { loadCatalog: loadStub(catalog, 'live'), ...LOW_FLOOR },
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
})
