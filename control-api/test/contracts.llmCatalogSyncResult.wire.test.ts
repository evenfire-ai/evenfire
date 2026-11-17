// Regenerate after an intended contract change: `UPDATE_WIRE_GOLDENS=1 npx vitest run test/contracts.llmCatalogSyncResult.wire.test.ts`, then review the JSON diff.
import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import { catalogPruneFromGateway } from '../src/services/llmCatalogPrune.js'
import {
  type CatalogSyncProviderCount,
  type CatalogSyncResult,
  syncDiscoveredModels,
} from '../src/services/llmCatalogSync.js'
import type { ConsumerGateway } from '../src/services/llmModelConsumers.js'
import type { RawModelsDevCatalog } from '../src/services/modelsDevClient.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import {
  LIVE_MODELS_DEV_CATALOG,
  type TrimSpec,
  loadStub,
  trimLiveCatalog,
} from './helpers/modelsDevFixtures.js'
import { MockGateway } from './mockGateway.js'

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
 *
 * The first five cases are single runs without a prune, so their bodies carry
 * no `pruned` / `pruneAborted` (the shape a caller that injects no prune gets).
 * Production always runs the prune, so the `prune_*` cases replay a sequence
 * on one table with the real production prune (`catalogPruneFromGateway`, an
 * empty cluster: nobody uses any model) and keep the LAST run's body:
 *   - the catalog drops enabled anthropic models, which the prune disables
 *     (`pruned > 0`);
 *   - the same, with the cluster's LISTs failing, so the prune aborts
 *     (`pruneAborted: true`);
 *   - a later run lists the pruned models again with cap room (`reEnabled`)
 *     or with a per-provider cap of one (`reEnableDeferredByCap`).
 * The grace is zero because the fake's clock moves one second per commit; the
 * per-run prune ceiling is pinned so a config default cannot move the counts.
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
/** The anthropic models dropped from the mixed catalog (all auto-enabled by it). */
const DROPPED_ANTHROPIC = 3
const SHRUNK_CATALOG = trimLiveCatalog({
  ...wholeLive(['openai']),
  anthropic: Object.keys(LIVE_MODELS_DEV_CATALOG.anthropic.models).length - DROPPED_ANTHROPIC,
  groq: 4,
})

/** The Kubernetes API with every LIST failing, as an unreachable apiserver does. */
const FAILING_CLUSTER: ConsumerGateway = {
  listResource: async () => {
    throw Object.assign(new Error('apiserver unavailable'), { statusCode: 503 })
  },
}

type RunOptions = {
  catalog: RawModelsDevCatalog
  source: 'live' | 'vendored'
  minPlausibleLiveTotal: number
  autoEnableMaxPerProviderPerRun?: number
  /** Run the production prune after the sync, reading consumers from this cluster. */
  pruneCluster?: ConsumerGateway
}

async function run(opts: RunOptions): Promise<CatalogSyncResult> {
  return runSequence([opts])
}

/** Every run on one table, in order; the body is the last run's. */
async function runSequence(steps: RunOptions[]): Promise<CatalogSyncResult> {
  const db = makeFakeDb()
  let result: CatalogSyncResult | undefined
  for (const opts of steps) {
    result = await syncDiscoveredModels(
      {
        materializer: db.materializer,
        loadCatalog: loadStub(opts.catalog, opts.source),
        minPlausibleLiveTotal: opts.minPlausibleLiveTotal,
        autoEnableMaxPerProviderPerRun: opts.autoEnableMaxPerProviderPerRun ?? LARGE_CAP,
        autoEnableMaxPerRun: LARGE_CAP,
        ...(opts.pruneCluster
          ? {
              prune: catalogPruneFromGateway(opts.pruneCluster, {
                graceMs: 0,
                maxPerRun: LARGE_CAP,
                txPool: db.pool('prune'),
              }),
            }
          : {}),
      },
      db.connector
    )
  }
  if (!result) throw new Error('runSequence: no steps')
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
      prune_disabled: await runSequence([live(MIXED_CATALOG), live(SHRUNK_CATALOG)]),
      prune_aborted: await runSequence([
        live(MIXED_CATALOG),
        { ...live(SHRUNK_CATALOG), pruneCluster: FAILING_CLUSTER },
      ]),
      prune_re_enabled: await runSequence([
        live(MIXED_CATALOG),
        live(SHRUNK_CATALOG),
        live(MIXED_CATALOG),
      ]),
      prune_re_enable_capped: await runSequence([
        live(MIXED_CATALOG),
        live(SHRUNK_CATALOG),
        { ...live(MIXED_CATALOG), autoEnableMaxPerProviderPerRun: 1 },
      ]),
    },
  }
}

/** A live, plausible run followed by the production prune over an empty cluster. */
function live(catalog: RawModelsDevCatalog): RunOptions {
  return {
    catalog,
    source: 'live',
    minPlausibleLiveTotal: 1,
    pruneCluster: new MockGateway(),
  }
}

function counts(r: CatalogSyncResult): CatalogSyncProviderCount[] {
  return Object.values(r.providerCounts ?? {}).filter(
    (c): c is CatalogSyncProviderCount => c !== undefined
  )
}

type CountField =
  | 'inserted'
  | 'autoEnabled'
  | 'skippedUndecidable'
  | 'deferredByCap'
  | 'reEnabled'
  | 'reEnableDeferredByCap'

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

    // Without a prune the body has no prune fields; with one, both are present.
    for (const key of [
      'decidable_auto_enabled',
      'decidable_capped',
      'decidable_none_enabled',
      'undecidable_vendored',
      'undecidable_implausible',
    ]) {
      expect(cases[key]).not.toHaveProperty('pruned')
      expect(cases[key]).not.toHaveProperty('pruneAborted')
    }
    for (const [key, r] of Object.entries(cases)) {
      expect(r.reEnabled, key).toBe(sum(r, 'reEnabled'))
      expect(r.reEnableDeferredByCap, key).toBe(sum(r, 'reEnableDeferredByCap'))
    }

    const pruned = cases.prune_disabled
    expect(pruned.decidable).toBe(true)
    expect(pruned.staled).toBe(DROPPED_ANTHROPIC)
    expect(pruned.pruned).toBe(DROPPED_ANTHROPIC)
    expect(pruned.pruneAborted).toBe(false)

    const aborted = cases.prune_aborted
    expect(aborted.staled).toBe(DROPPED_ANTHROPIC)
    expect(aborted.pruned).toBe(0)
    expect(aborted.pruneAborted).toBe(true)

    const reEnabled = cases.prune_re_enabled
    expect(reEnabled.reEnabled).toBe(DROPPED_ANTHROPIC)
    expect(reEnabled.reEnableDeferredByCap).toBe(0)
    expect(reEnabled.added).toBe(0)
    expect(reEnabled.pruned).toBe(0)
    expect(reEnabled.pruneAborted).toBe(false)

    const reEnableCapped = cases.prune_re_enable_capped
    expect(reEnableCapped.reEnabled).toBe(1)
    expect(reEnableCapped.reEnableDeferredByCap).toBe(DROPPED_ANTHROPIC - 1)
    expect(providersWith(reEnableCapped, 'reEnableDeferredByCap')).toBe(1)
    expect(reEnableCapped.pruned).toBe(0)
    expect(reEnableCapped.pruneAborted).toBe(false)
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
