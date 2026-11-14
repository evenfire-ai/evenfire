// Regenerate after an intended contract change: `UPDATE_WIRE_GOLDENS=1 npx vitest run test/contracts.llmCatalogSyncResult.wire.test.ts`, then review the JSON diff.
import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import {
  type CatalogSyncProviderCount,
  type CatalogSyncResult,
  syncDiscoveredModels,
} from '../src/services/llmCatalogSync.js'
import type { RawModelsDevCatalog } from '../src/services/modelsDevClient.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import {
  LIVE_MODELS_DEV_CATALOG,
  type TrimSpec,
  loadStub,
  trimLiveCatalog,
} from './helpers/modelsDevFixtures.js'

/**
 * The `POST /admin/llm-models/discovery/sync` body, consumed by control-ui's
 * tests instead of a hand-written mirror. The route answers with the JSON of
 * `syncDiscoveredModels`' result, so every case is the real service run against
 * the fake table (differential-tested against Postgres) over the captured live
 * catalog. A producer change turns this red until the committed JSON moves.
 *
 * The catalog holds two providers whose auto-enable is ON by default (anthropic,
 * openai) and a slice of one that is OFF (groq), so a consumer that reads only
 * one provider's counts cannot pass.
 */

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const DIR = new URL('./fixtures/wire/', import.meta.url)
const FILE = new URL('llmCatalogSyncResult.wire.json', DIR)

// The run's timestamps come from the fake clock; pinned so the file is stable.
const FETCHED_AT = '2026-08-12T00:00:00.000Z'
const RAN_AT = '2026-08-12T00:00:05.000Z'

const LARGE_CAP = 10_000

/** Every captured model of each key: whole providers have enough eligible models to cap. */
function wholeLive(keys: string[]): TrimSpec {
  return Object.fromEntries(
    keys.map(k => [k, Object.keys(LIVE_MODELS_DEV_CATALOG[k].models).length])
  )
}

const MIXED_CATALOG = trimLiveCatalog({ ...wholeLive(['anthropic', 'openai']), groq: 4 })
const OFF_ONLY_CATALOG = trimLiveCatalog({ groq: 4 })

type RunOptions = {
  catalog: RawModelsDevCatalog
  source: 'live' | 'vendored'
  minPlausibleLiveTotal: number
  autoEnableMaxPerProviderPerRun?: number
}

async function run(opts: RunOptions): Promise<CatalogSyncResult> {
  const db = makeFakeDb()
  const result = await syncDiscoveredModels(
    {
      materializer: db.materializer,
      loadCatalog: loadStub(opts.catalog, opts.source),
      minPlausibleLiveTotal: opts.minPlausibleLiveTotal,
      autoEnableMaxPerProviderPerRun: opts.autoEnableMaxPerProviderPerRun ?? LARGE_CAP,
      autoEnableMaxPerRun: LARGE_CAP,
    },
    db.connector
  )
  expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false)
  expect(Number.isNaN(Date.parse(result.ranAt))).toBe(false)
  // A JSON round trip, so the cases are what a consumer parses.
  const wire = JSON.parse(JSON.stringify(result)) as CatalogSyncResult
  return { ...wire, fetchedAt: FETCHED_AT, ranAt: RAN_AT }
}

async function buildContract(): Promise<{ cases: Record<string, CatalogSyncResult> }> {
  return {
    cases: {
      decidable_auto_enabled: await run({
        catalog: MIXED_CATALOG,
        source: 'live',
        minPlausibleLiveTotal: 1,
      }),
      decidable_capped: await run({
        catalog: MIXED_CATALOG,
        source: 'live',
        minPlausibleLiveTotal: 1,
        autoEnableMaxPerProviderPerRun: 1,
      }),
      decidable_none_enabled: await run({
        catalog: OFF_ONLY_CATALOG,
        source: 'live',
        minPlausibleLiveTotal: 1,
      }),
      undecidable_vendored: await run({
        catalog: MIXED_CATALOG,
        source: 'vendored',
        minPlausibleLiveTotal: 1,
      }),
      undecidable_implausible: await run({
        catalog: MIXED_CATALOG,
        source: 'live',
        minPlausibleLiveTotal: 1_000_000,
      }),
    },
  }
}

function counts(r: CatalogSyncResult): CatalogSyncProviderCount[] {
  return Object.values(r.providerCounts ?? {}).filter(
    (c): c is CatalogSyncProviderCount => c !== undefined
  )
}

type CountField = 'inserted' | 'autoEnabled' | 'skippedUndecidable' | 'deferredByCap'

function sum(r: CatalogSyncResult, field: CountField): number {
  return counts(r).reduce((n, c) => n + c[field], 0)
}

function providersWith(r: CatalogSyncResult, field: CountField): number {
  return counts(r).filter(c => c[field] > 0).length
}

describe('catalog-sync result wire contract', () => {
  it('the catalog mixes default-ON and default-OFF providers', () => {
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.claude).toBe(true)
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.openai).toBe(true)
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.groq).toBe(false)
  })

  it('each case carries the state its name promises', async () => {
    const { cases } = await buildContract()
    for (const r of Object.values(cases)) {
      expect(r.added).toBe(sum(r, 'inserted'))
      expect(typeof r.decidable).toBe('boolean')
    }

    const auto = cases.decidable_auto_enabled
    expect(auto.decidable).toBe(true)
    expect(providersWith(auto, 'autoEnabled')).toBeGreaterThanOrEqual(2)
    expect(auto.added).toBeGreaterThan(sum(auto, 'autoEnabled'))
    expect(sum(auto, 'deferredByCap')).toBe(0)

    const capped = cases.decidable_capped
    expect(capped.decidable).toBe(true)
    expect(sum(capped, 'autoEnabled')).toBe(2)
    expect(providersWith(capped, 'deferredByCap')).toBeGreaterThanOrEqual(2)

    const none = cases.decidable_none_enabled
    expect(none.decidable).toBe(true)
    expect(none.added).toBeGreaterThan(0)
    expect(sum(none, 'autoEnabled')).toBe(0)
    expect(sum(none, 'skippedUndecidable') + sum(none, 'deferredByCap')).toBe(0)

    const vendored = cases.undecidable_vendored
    expect(vendored.source).toBe('vendored')
    expect(vendored.decidable).toBe(false)
    expect(vendored.added).toBeGreaterThan(0)
    expect(providersWith(vendored, 'skippedUndecidable')).toBeGreaterThanOrEqual(2)

    const implausible = cases.undecidable_implausible
    expect(implausible.source).toBe('live')
    expect(implausible.decidable).toBe(false)
    expect(providersWith(implausible, 'skippedUndecidable')).toBeGreaterThanOrEqual(2)
  })

  it('matches the committed fixture', async () => {
    const actual = await buildContract()
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(FILE, `${JSON.stringify(actual, null, 2)}\n`)
    }
    const committed = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
    expect(actual).toEqual(committed)
  })
})
