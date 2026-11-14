import { describe, expect, it } from 'vitest'
import { type LlmProviderId } from '@clerum/llm-providers'
import {
  LEGACY_SEEDED_ALLOWED_MODELS,
  LEGACY_SEEDED_MODEL_PRICES,
  SEEDED_ALLOWED_MODELS_LISTED_BY_CATALOG,
} from '../src/data/llmCatalogLegacySeeds.js'
import { mapCatalogToProviders } from '../src/services/modelsDevClient.js'
import { CATALOG_CAPTURE_0135 } from './helpers/llmCatalogLegacySeeds.js'

// 0135's pair list is frozen to the live capture it was derived from
// (modelsDevLiveCatalog.2026-10-30.json), not to the regenerable
// modelsDevLiveCatalog.json: a released migration must never change.

const key = (provider: string, model: string) => `${provider}/${model}`

describe('retired catalog seeds (0135 inputs)', () => {
  it('keeps the 44 seeded pairs of 0056/0057/0058/0100, each once', () => {
    const byMigration = new Map<string, number>()
    for (const s of LEGACY_SEEDED_ALLOWED_MODELS) {
      byMigration.set(s.migration, (byMigration.get(s.migration) ?? 0) + 1)
    }
    expect(Object.fromEntries(byMigration)).toEqual({
      '0056_llm_allowed_models': 25,
      '0057_llm_allowed_models_vertex_bedrock': 4,
      '0058_llm_allowed_models_new_providers': 14,
      '0100_seed_minimax_allowed_model': 1,
    })
    const pairs = LEGACY_SEEDED_ALLOWED_MODELS.map(s => key(s.provider, s.model))
    expect(new Set(pairs).size).toBe(44)
    expect(new Set(LEGACY_SEEDED_MODEL_PRICES.map(p => key(p.provider, p.model))).size).toBe(8)
  })

  it('reclassifies exactly the seeded pairs the captured live catalog lists, matched like the sync', () => {
    expect(CATALOG_CAPTURE_0135.capturedAt).toBe('2026-10-30T15:57:00.000Z')
    const byProvider = mapCatalogToProviders(CATALOG_CAPTURE_0135.catalog)
    const derived = LEGACY_SEEDED_ALLOWED_MODELS.filter(s =>
      (byProvider[s.provider as LlmProviderId] ?? []).some(m => m.model_id === s.model)
    ).map(s => key(s.provider, s.model))
    const migration = SEEDED_ALLOWED_MODELS_LISTED_BY_CATALOG.map(([p, m]) => key(p, m))

    expect([...migration].sort()).toEqual([...derived].sort())
    expect(new Set(migration).size).toBe(migration.length)
    expect(migration).toHaveLength(28)
  })
})
