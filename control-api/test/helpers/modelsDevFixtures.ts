/**
 * Catalog fixtures for the sync/guard tests, DERIVED FROM THE REAL PRODUCER
 * (the vendored snapshot of models.dev api.json) by TRIMMING it — never
 * hand-written payloads (T1). `VENDORED_MODELS_DEV_SNAPSHOT` is the exact shape
 * the live fetch parses to, so a fixture cut from it cannot encode a shape the
 * real producer can't emit.
 */
import type { LlmProviderId } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../../src/data/modelsDevSnapshot.js'
import {
  type ModelsDevCatalogResult,
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
} from '../../src/services/modelsDevClient.js'

/** models.dev provider KEY for one of our provider ids (e.g. 'claude' → 'anthropic'). */
export function providerKey(id: LlmProviderId): string {
  return PROVIDER_KEY_MAP[id]
}

/**
 * A trim spec per models.dev provider key: a count (first N models from the
 * snapshot, in snapshot order) or an explicit list of model ids to keep.
 */
export type TrimSpec = Record<string, number | string[]>

/**
 * Cut a catalog down to the given provider keys / models, straight from the real
 * snapshot. Unknown keys/ids throw so a typo can't silently produce an empty
 * fixture that passes a test for the wrong reason.
 */
export function trimSnapshot(spec: TrimSpec): RawModelsDevCatalog {
  const out: RawModelsDevCatalog = {}
  for (const [key, pick] of Object.entries(spec)) {
    const provider = VENDORED_MODELS_DEV_SNAPSHOT[key]
    if (!provider) throw new Error(`trimSnapshot: provider key "${key}" not in snapshot`)
    const allIds = Object.keys(provider.models)
    const ids =
      typeof pick === 'number'
        ? allIds.slice(0, pick)
        : pick.map(id => {
            if (!provider.models[id]) {
              throw new Error(`trimSnapshot: model "${id}" not in snapshot provider "${key}"`)
            }
            return id
          })
    const models: RawModelsDevCatalog[string]['models'] = {}
    for (const id of ids) models[id] = provider.models[id]
    out[key] = { name: provider.name, models }
  }
  return out
}

/** Count of models.dev entries in a catalog (pre-mapping/dedup). */
export function catalogSize(catalog: RawModelsDevCatalog): number {
  return Object.values(catalog).reduce((n, p) => n + Object.keys(p.models).length, 0)
}

/** A `loadCatalog` stub for syncDiscoveredModels' DI seam. */
export function loadStub(
  catalog: RawModelsDevCatalog,
  source: 'live' | 'vendored' = 'live'
): () => Promise<ModelsDevCatalogResult> {
  return async () => ({ source, fetchedAt: '2026-08-12T00:00:00.000Z', catalog })
}
