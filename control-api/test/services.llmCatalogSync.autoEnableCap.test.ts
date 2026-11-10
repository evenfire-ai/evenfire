/**
 * The per-run auto-enable cap, against the fake table: the parts the captured
 * catalog cannot exercise on its own (a tie the locale would break differently)
 * and the operator-facing warn. Every entry is a real entry of the captured
 * live catalog; only the fields under test are altered.
 */
import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import {
  type RawModelsDevCatalog,
  isAutoEnableEligible,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import { LIVE_MODELS_DEV_CATALOG, loadStub, trimLiveCatalog } from './helpers/modelsDevFixtures.js'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info() {}, warn, error() {}, debug() {} }) },
}))

function wholeLive(keys: string[]): RawModelsDevCatalog {
  return trimLiveCatalog(
    Object.fromEntries(keys.map(k => [k, Object.keys(LIVE_MODELS_DEV_CATALOG[k].models).length]))
  )
}

/** `catalog` with real entry `rawId` of `key` re-keyed as `newId` and patched. */
function renamed(
  catalog: RawModelsDevCatalog,
  key: string,
  rawId: string,
  newId: string,
  patch: Record<string, unknown>
): RawModelsDevCatalog {
  const models = { ...catalog[key].models }
  const entry = models[rawId]
  delete models[rawId]
  models[newId] = { ...entry, ...patch, id: newId }
  return { ...catalog, [key]: { ...catalog[key], models } }
}

describe('catalog sync auto-enable cap', () => {
  it('breaks a release-date tie by code units, not by the locale', async () => {
    const base = wholeLive(['anthropic'])
    const [a, b] = Object.keys(base.anthropic.models).filter(rawId => {
      const [m] = mapCatalogToProviders({
        anthropic: { name: 'Anthropic', models: { [rawId]: base.anthropic.models[rawId] } },
      }).claude
      return m !== undefined && isAutoEnableEligible(m)
    })
    // Both newest, same day. By code units 'C' (0x43) sorts before 'c' (0x63);
    // `localeCompare` puts 'claude-tie-a' first.
    const tie = { release_date: '9999-12-31' }
    const catalog = renamed(
      renamed(base, 'anthropic', a, 'claude-tie-a', tie),
      'anthropic',
      b,
      'Claude-tie-b',
      tie
    )
    expect('claude-tie-a'.localeCompare('Claude-tie-b')).toBeLessThan(0)

    const db = makeFakeDb()
    await syncDiscoveredModels(
      {
        materializer: db.materializer,
        loadCatalog: loadStub(catalog, 'live'),
        minPlausibleLiveTotal: 1,
        autoEnableMaxPerProviderPerRun: 1,
      },
      db.connector
    )
    expect(db.rows.filter(r => r.enabled).map(r => r.model)).toEqual(['Claude-tie-b'])
    expect(db.get('claude', 'claude-tie-a')).toBeUndefined()
  })

  it('warns once per provider with deferred models, with counts and no model ids', async () => {
    warn.mockClear()
    // claude and openai are ON by default and both have more than 2 eligible
    // models; groq is OFF, so nothing of it is ever deferred.
    const catalog = wholeLive(['anthropic', 'openai', 'groq'])
    const db = makeFakeDb()
    await syncDiscoveredModels(
      {
        materializer: db.materializer,
        loadCatalog: loadStub(catalog, 'live'),
        minPlausibleLiveTotal: 1,
        autoEnableMaxPerProviderPerRun: 2,
      },
      db.connector
    )
    const deferredWarns = warn.mock.calls.filter(
      ([payload]) =>
        (payload as { event?: string }).event === 'llm_catalog_sync_auto_enable_deferred'
    )
    expect(deferredWarns.map(([payload]) => (payload as { provider: string }).provider)).toEqual([
      'openai',
      'claude',
    ])
    const discovered = mapCatalogToProviders(catalog)
    for (const [payload, message] of deferredWarns) {
      const provider = (payload as { provider: 'openai' | 'claude' }).provider
      const eligible = discovered[provider].filter(isAutoEnableEligible).length
      expect(payload).toEqual({
        event: 'llm_catalog_sync_auto_enable_deferred',
        provider,
        deferredByCap: eligible - 2,
        autoEnabled: 2,
        maxPerProvider: 2,
        maxPerRun: 300,
        cronEnabled: config.llmCatalogSyncCronEnabled,
        bootSyncEnabled: config.llmCatalogBootSyncEnabled,
      })
      // Accurate whether or not the cron runs: no promise of a "next run".
      expect(String(message)).not.toMatch(/next run/)
      expect(String(message)).toMatch(/manual sync/)
      expect(String(message)).toMatch(/boot sync/)
      expect(String(message)).toMatch(/OFF/)
      for (const m of discovered[provider]) {
        expect(JSON.stringify([payload, message])).not.toContain(m.model_id)
      }
    }
  })
})
