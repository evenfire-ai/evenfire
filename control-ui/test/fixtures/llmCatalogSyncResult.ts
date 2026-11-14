/**
 * Producer fixtures — the body of control-api's
 * `POST /admin/llm-models/discovery/sync`.
 *
 * control-api is not importable from this package, so these come from the wire
 * file control-api generates by running its real `syncDiscoveredModels`:
 * control-api/test/contracts.llmCatalogSyncResult.wire.test.ts →
 * control-api/test/fixtures/wire/llmCatalogSyncResult.wire.json. A producer
 * change turns that generator red before it can drift here. Never build a body
 * by hand: a state the file lacks is added to the generator.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type CatalogSyncProviderCountWire = {
  inserted: number
  autoEnabled: number
  skippedUndecidable: number
  deferredByCap: number
}

type CatalogSyncResultWire = {
  source: string
  fetchedAt: string
  ranAt: string
  added: number
  updated: number
  staled: number
  decidable?: boolean
  providerCounts?: Record<string, CatalogSyncProviderCountWire>
}

const WIRE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../control-api/test/fixtures/wire/llmCatalogSyncResult.wire.json'),
    'utf8'
  )
) as { cases: Record<string, CatalogSyncResultWire> }

/**
 * One generated body: `decidable_auto_enabled`, `decidable_capped`,
 * `decidable_none_enabled`, `undecidable_vendored`, `undecidable_implausible`.
 * Returns a copy so a test that mutates it cannot leak into another.
 */
export function syncResultCase(key: string): CatalogSyncResultWire {
  const entry = WIRE.cases[key]
  if (!entry) throw new Error(`catalog-sync result wire fixture has no case "${key}"`)
  return structuredClone(entry)
}

/**
 * A generated body as a control-api from before auto-enable returns it (the
 * producer at merge-base f4d058b7a): the same counters, no `decidable` and no
 * `providerCounts`. Deployments roll control-ui and control-api independently,
 * so the consumer meets this shape for real.
 */
export function syncResultLegacyCase(key: string): CatalogSyncResultWire {
  const entry = syncResultCase(key)
  delete entry.decidable
  delete entry.providerCounts
  return entry
}

/** Sum of one per-provider counter across the body's `providerCounts`. */
export function sumProviderCounts(
  body: CatalogSyncResultWire,
  field: keyof CatalogSyncProviderCountWire
): number {
  return Object.values(body.providerCounts ?? {}).reduce((n, count) => n + count[field], 0)
}
