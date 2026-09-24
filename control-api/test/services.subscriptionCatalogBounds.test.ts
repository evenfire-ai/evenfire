import { describe, expect, it } from 'vitest'
import {
  MAX_CATALOG_MODEL_ID_LENGTH,
  MAX_DISCOVERED_CATALOG_MODELS,
  boundDiscoveredCatalogModels,
} from '../src/services/subscriptionCatalogBounds.js'

describe('boundDiscoveredCatalogModels', () => {
  it('uses the shared 256-model and 128-character limits', () => {
    expect(MAX_DISCOVERED_CATALOG_MODELS).toBe(256)
    expect(MAX_CATALOG_MODEL_ID_LENGTH).toBe(128)
  })

  it('passes a small valid catalog through unchanged', () => {
    const models = [{ model: 'gpt-5.1' }, { model: 'a'.repeat(128) }]
    expect(boundDiscoveredCatalogModels(models)).toEqual({
      models,
      droppedInvalidId: 0,
      droppedOverCount: 0,
    })
  })

  it('drops invalid ids and keeps the first 256 distinct ids in provider order', () => {
    const models = [
      { model: 'b'.repeat(129) },
      { model: '' },
      { model: 42 as unknown as string },
      ...Array.from({ length: 260 }, (_, index) => ({ model: `m-${index}` })),
      { model: 'm-0', displayName: 'duplicate of a kept id' },
    ]
    const bounded = boundDiscoveredCatalogModels(models)
    expect(bounded.droppedInvalidId).toBe(3)
    expect(bounded.droppedOverCount).toBe(4)
    expect(new Set(bounded.models.map(entry => entry.model)).size).toBe(256)
    expect(bounded.models[0]).toEqual({ model: 'm-0' })
    expect(bounded.models.at(-2)).toEqual({ model: 'm-255' })
    // A duplicate of a kept id is retained so reconcile keeps last-entry-wins metadata.
    expect(bounded.models.at(-1)).toEqual({ model: 'm-0', displayName: 'duplicate of a kept id' })
  })
})
