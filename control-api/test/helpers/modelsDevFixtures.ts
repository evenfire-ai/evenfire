/**
 * Catalog fixtures for the sync/guard tests, DERIVED FROM THE REAL PRODUCER
 * (the vendored snapshot of models.dev api.json) by TRIMMING it — never
 * hand-written payloads (T1). `VENDORED_MODELS_DEV_SNAPSHOT` is the exact shape
 * the live fetch parses to, so a fixture cut from it cannot encode a shape the
 * real producer can't emit.
 *
 * The vendored snapshot omits the fields the auto-enable rules read
 * (`modalities.output`, `tool_call`, `status`, `cost`, `release_date`). Tests of
 * those use the LIVE fixture below: a captured api.json trimmed by
 * `scripts/regenerate-models-dev-snapshot.mjs --live-fixture`.
 */
import { readFileSync } from 'node:fs'
import type { LlmProviderId } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../../src/data/modelsDevSnapshot.js'
import {
  type DiscoveredModel,
  type ModelsDevCatalogResult,
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  type RawModelsDevModel,
  mapCatalogToProviders,
} from '../../src/services/modelsDevClient.js'

interface LiveFixtureFile {
  capturedAt: string
  catalog: RawModelsDevCatalog
}

const LIVE_FIXTURE: LiveFixtureFile = JSON.parse(
  readFileSync(new URL('../fixtures/modelsDevLiveCatalog.json', import.meta.url), 'utf8')
)

/** The captured live catalog (all mapped provider keys, parsed fields only). */
export const LIVE_MODELS_DEV_CATALOG: RawModelsDevCatalog = LIVE_FIXTURE.catalog
export const LIVE_MODELS_DEV_CAPTURED_AT: string = LIVE_FIXTURE.capturedAt

/** models.dev provider KEY for one of our provider ids (e.g. 'claude' → 'anthropic'). */
export function providerKey(id: LlmProviderId): string {
  if (id === 'codex-subscription') {
    throw new Error('providerKey: codex-subscription is not a models.dev catalog source')
  }
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
  return trimCatalog(VENDORED_MODELS_DEV_SNAPSHOT, spec, 'trimSnapshot')
}

/** `trimSnapshot` over the captured LIVE catalog; same spec and the same throws. */
export function trimLiveCatalog(spec: TrimSpec): RawModelsDevCatalog {
  return trimCatalog(LIVE_MODELS_DEV_CATALOG, spec, 'trimLiveCatalog')
}

function trimCatalog(
  source: RawModelsDevCatalog,
  spec: TrimSpec,
  label: string
): RawModelsDevCatalog {
  const out: RawModelsDevCatalog = {}
  for (const [key, pick] of Object.entries(spec)) {
    const provider = source[key]
    if (!provider) throw new Error(`${label}: provider key "${key}" not in catalog`)
    const allIds = Object.keys(provider.models)
    const ids =
      typeof pick === 'number'
        ? allIds.slice(0, pick)
        : pick.map(id => {
            if (!provider.models[id]) {
              throw new Error(`${label}: model "${id}" not in catalog provider "${key}"`)
            }
            return id
          })
    const models: RawModelsDevCatalog[string]['models'] = {}
    for (const id of ids) models[id] = provider.models[id]
    out[key] = { name: provider.name, models }
  }
  return out
}

/**
 * Overlay `modalities.input` on specific models of a trimmed catalog.
 *
 * The trim above keeps whatever the vendored snapshot carries, which is what a
 * real fetch would give — but a test about the tri-state needs a KNOWN mix of
 * supported/unsupported/absent entries that does not move when the snapshot is
 * regenerated. The overlay writes the exact shape models.dev emits
 * (`modalities: { input: string[] }`), and throws on an id the catalog does not
 * contain so a typo cannot quietly produce an entry the test never exercises.
 */
export function withModalities(
  catalog: RawModelsDevCatalog,
  input: Record<string, string[]>
): RawModelsDevCatalog {
  const remaining = new Set(Object.keys(input))
  const out: RawModelsDevCatalog = {}
  for (const [key, provider] of Object.entries(catalog)) {
    const models: RawModelsDevCatalog[string]['models'] = {}
    for (const [id, model] of Object.entries(provider.models)) {
      const override = input[id]
      models[id] = override ? { ...model, modalities: { input: override } } : model
      remaining.delete(id)
    }
    out[key] = { name: provider.name, models }
  }
  if (remaining.size > 0) {
    throw new Error(`withModalities: model id(s) not in catalog: ${[...remaining].join(', ')}`)
  }
  return out
}

/**
 * One live-catalog entry next to what the real mapper makes of it. `discovered`
 * comes from `mapCatalogToProviders` over a catalog holding only this entry, so
 * it is the producer's output, never a guess at it.
 */
export interface LiveCatalogEntry {
  /** models.dev provider key (e.g. 'anthropic'). */
  key: string
  providerId: LlmProviderId
  /** The entry's key inside `models`. */
  rawId: string
  raw: RawModelsDevModel
  discovered: DiscoveredModel
}

const PROVIDER_ID_BY_KEY = new Map<string, LlmProviderId>(
  Object.entries(PROVIDER_KEY_MAP).map(([id, key]) => [key, id as LlmProviderId])
)

/** Wrap one catalog entry as a single-model catalog, the shape the mapper takes. */
export function singleModelCatalog(
  key: string,
  rawId: string,
  raw: RawModelsDevModel
): RawModelsDevCatalog {
  return { [key]: { name: LIVE_MODELS_DEV_CATALOG[key]?.name, models: { [rawId]: raw } } }
}

let liveEntriesCache: LiveCatalogEntry[] | undefined

/** Every live-catalog entry the mapper keeps (entries it skips have no `discovered`). */
export function liveCatalogEntries(): LiveCatalogEntry[] {
  if (liveEntriesCache) return liveEntriesCache
  const entries: LiveCatalogEntry[] = []
  for (const [key, provider] of Object.entries(LIVE_MODELS_DEV_CATALOG)) {
    const providerId = PROVIDER_ID_BY_KEY.get(key)
    if (!providerId) throw new Error(`liveCatalogEntries: "${key}" is not a mapped provider key`)
    for (const [rawId, raw] of Object.entries(provider.models)) {
      const [discovered] = mapCatalogToProviders(singleModelCatalog(key, rawId, raw))[providerId]
      if (discovered) entries.push({ key, providerId, rawId, raw, discovered })
    }
  }
  liveEntriesCache = entries
  return entries
}

/**
 * The first `count` live entries matching `predicate`, in catalog order. Tests
 * choose eligible / ineligible / priced / unpriced entries this way instead of
 * naming ids, so a regenerated fixture keeps feeding them real data. Throws if
 * the catalog has fewer matches than asked for, so a test cannot pass on an
 * empty selection.
 */
export function pickLiveModels(
  predicate: (entry: LiveCatalogEntry) => boolean,
  count = 1
): LiveCatalogEntry[] {
  const picked = liveCatalogEntries().filter(predicate).slice(0, count)
  if (picked.length < count) {
    throw new Error(`pickLiveModels: wanted ${count} matching entries, found ${picked.length}`)
  }
  return picked
}

/** Count of models.dev entries in a catalog (pre-mapping/dedup). */
export function catalogSize(catalog: RawModelsDevCatalog): number {
  return Object.values(catalog).reduce((n, p) => n + Object.keys(p.models).length, 0)
}

/** A `loadCatalog` stub for syncDiscoveredModels' DI seam. */
export function loadStub(
  catalog: RawModelsDevCatalog,
  source: 'live' | 'vendored' = 'live',
  capturedAt = '2026-08-12T00:00:00.000Z'
): () => Promise<ModelsDevCatalogResult> {
  return async () => ({
    source,
    fetchedAt: '2026-08-12T00:00:00.000Z',
    capturedAt,
    catalog,
  })
}
