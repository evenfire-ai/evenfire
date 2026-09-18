/**
 * Bounds applied to a subscription provider's discovered model catalog before
 * it is reconciled into `codex_catalog_models` / `grok_catalog_models`. The
 * upstream list is provider-controlled; without a bound one sync could insert
 * an unbounded number of enabled rows (and republish them in the runtime
 * allowlist ConfigMap). Shared by the Codex and Grok catalog services so both
 * brokers enforce the same limits (the proxies mirror them).
 */
export const MAX_DISCOVERED_CATALOG_MODELS = 256
export const MAX_CATALOG_MODEL_ID_LENGTH = 128

export type BoundedDiscoveredCatalogModels<T> = {
  models: T[]
  /** Entries whose id is not a non-empty string of at most 128 characters. */
  droppedInvalidId: number
  /** Entries whose (valid) id falls beyond the first 256 distinct ids. */
  droppedOverCount: number
}

/**
 * Keeps entries with a valid model id whose id is among the first
 * `MAX_DISCOVERED_CATALOG_MODELS` distinct ids, in provider order. Duplicate
 * ids of a kept model stay in the list so reconcile keeps its existing
 * last-entry-wins metadata semantics.
 */
export function boundDiscoveredCatalogModels<T extends { model: unknown }>(
  models: readonly T[]
): BoundedDiscoveredCatalogModels<T> {
  const kept: T[] = []
  const distinct = new Set<string>()
  let droppedInvalidId = 0
  let droppedOverCount = 0
  for (const entry of models) {
    const id = entry?.model
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CATALOG_MODEL_ID_LENGTH) {
      droppedInvalidId += 1
      continue
    }
    if (!distinct.has(id)) {
      if (distinct.size >= MAX_DISCOVERED_CATALOG_MODELS) {
        droppedOverCount += 1
        continue
      }
      distinct.add(id)
    }
    kept.push(entry)
  }
  return { models: kept, droppedInvalidId, droppedOverCount }
}
