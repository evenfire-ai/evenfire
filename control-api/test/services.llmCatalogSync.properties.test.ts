/**
 * Property-based coverage (T2) for the catalog-sync reconciliation — the decision
 * logic in `reconcileProvider` / `syncDiscoveredModels` (manual-invisible,
 * discovery-refresh, vanished→stale, per-provider + global sanity floors). The
 * example-based suites (services.llmCatalogSync.invariants / .guard) pin single
 * scenarios; these fuzz random LIVE catalogs against random pre-existing rows to
 * blind the invariants across the precedence combinations a human enumeration
 * misses. No behavior is exercised the example suites don't already cover — this
 * is coverage, not a fix.
 *
 * T1 (no hand-built fixtures): every catalog is cut from the REAL vendored
 * snapshot (via `trimSnapshot`, the same producer the example suites use), and
 * every pre-existing "present"/"vanished" row's `model` is the EXACT normalized
 * id that `mapCatalogToProviders` (the real mapping layer) emits for that catalog
 * — never an id we invent. If the producer can't emit a shape, no test asserts on
 * it.
 *
 * T4 (observable state): assertions are on the resulting row set (which rows are
 * `stale`, which are `enabled`) and the run's `staled`/`added` counts — never on
 * intermediate SQL or call counts.
 */
import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { LlmProviderId } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../src/data/modelsDevSnapshot.js'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import { PROVIDER_KEY_MAP, mapCatalogToProviders } from '../src/services/modelsDevClient.js'
import { type FakeDb, type SeedRow, makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import { loadStub, trimSnapshot } from './helpers/modelsDevFixtures.js'

vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}))

const NUM_RUNS = 200

// models.dev provider KEY → our provider id (inverse of PROVIDER_KEY_MAP). The
// mapping is 1:1, so the inverse is well-defined.
const KEY_TO_ID = Object.fromEntries(
  Object.entries(PROVIDER_KEY_MAP).map(([id, key]) => [key, id as LlmProviderId])
) as Record<string, LlmProviderId>

// Snapshot provider keys we (a) map to a provider id and (b) that carry models —
// the only keys a live catalog cut from the snapshot could contain.
const MAPPED_KEYS = Object.keys(VENDORED_MODELS_DEV_SNAPSHOT).filter(
  k => KEY_TO_ID[k] && Object.keys(VENDORED_MODELS_DEV_SNAPSHOT[k]!.models).length > 0
)

/** One provider's slice of a generated scenario: which snapshot ids are live vs vanished. */
interface KeySelection {
  key: string
  liveIds: string[]
  /** snapshot ids seeded as discovery rows but ABSENT from the live catalog. */
  vanishedIds: string[]
}

/**
 * Arbitrary of a set of per-provider selections. `allowZeroLive` controls whether
 * a chosen provider may come back with 0 live models (needed for the per-provider
 * floor property; forbidden for the staling properties where every provider must
 * clear the floor so vanished→stale actually fires).
 */
function selectionsArb(opts: { allowZeroLive: boolean }): fc.Arbitrary<KeySelection[]> {
  return fc
    .uniqueArray(fc.constantFrom(...MAPPED_KEYS), { minLength: 1, maxLength: 4 })
    .chain(keys =>
      fc.tuple(
        ...keys.map(key => {
          const allIds = Object.keys(VENDORED_MODELS_DEV_SNAPSHOT[key]!.models)
          const liveArb = fc.subarray(allIds, {
            minLength: opts.allowZeroLive ? 0 : 1,
            maxLength: Math.min(allIds.length, 6),
          })
          return liveArb.chain(liveIds => {
            const remaining = allIds.filter(id => !liveIds.includes(id))
            return fc
              .subarray(remaining, { maxLength: Math.min(remaining.length, 4) })
              .map(vanishedIds => ({ key, liveIds, vanishedIds }) as KeySelection)
          })
        })
      )
    )
}

interface Scenario {
  selections: KeySelection[]
  /** deterministic per-(provider,model) flags — decouples flag gen from id counts. */
  enabledFor: (...args: unknown[]) => boolean
  staleFor: (...args: unknown[]) => boolean
  /** whether a still-listed (present) model was pre-seeded (else it is a NEW insert). */
  seedPresentFor: (...args: unknown[]) => boolean
}

function scenarioArb(opts: { allowZeroLive: boolean }): fc.Arbitrary<Scenario> {
  return fc.record({
    selections: selectionsArb(opts),
    enabledFor: fc.func(fc.boolean()),
    staleFor: fc.func(fc.boolean()),
    seedPresentFor: fc.func(fc.boolean()),
  })
}

/** Per-provider derived id sets, computed via the REAL mapping producer. */
interface ProviderPlan {
  providerId: LlmProviderId
  /** normalized ids the live catalog emits for this provider (still-listed). */
  presentIds: string[]
  /** normalized ids seeded as discovery rows but not in the live catalog. */
  vanishedIds: string[]
}

/**
 * Build the concrete catalog + seed rows a scenario stands for. Present/vanished
 * `model` values are the mapping layer's own output (T1) — never invented.
 */
function materialize(s: Scenario): {
  catalog: ReturnType<typeof trimSnapshot>
  seed: SeedRow[]
  plans: ProviderPlan[]
} {
  const liveSpec: Record<string, string[]> = {}
  for (const sel of s.selections) if (sel.liveIds.length) liveSpec[sel.key] = sel.liveIds
  const catalog = Object.keys(liveSpec).length ? trimSnapshot(liveSpec) : {}
  const mapped = mapCatalogToProviders(catalog)

  const seed: SeedRow[] = []
  const plans: ProviderPlan[] = []
  for (const sel of s.selections) {
    const providerId = KEY_TO_ID[sel.key]!
    const presentIds = mapped[providerId].map(m => m.model_id)
    const presentSet = new Set(presentIds)

    // Vanished ids: normalized through the SAME producer, then excluded from the
    // present set so present/vanished never collide.
    const vanCatalog = sel.vanishedIds.length ? trimSnapshot({ [sel.key]: sel.vanishedIds }) : {}
    const vanishedIds = mapCatalogToProviders(vanCatalog)
      [providerId].map(m => m.model_id)
      .filter(id => !presentSet.has(id))

    plans.push({ providerId, presentIds, vanishedIds })

    for (const id of presentIds) {
      // Some present models are pre-seeded (refresh path), some are absent (NEW
      // insert path) — both must converge to the same stable state.
      if (!s.seedPresentFor(providerId, id)) continue
      seed.push({
        provider: providerId,
        model: id,
        source: 'discovery',
        enabled: s.enabledFor(providerId, id),
        stale: s.staleFor(providerId, id),
      })
    }
    for (const id of vanishedIds) {
      seed.push({
        provider: providerId,
        model: id,
        source: 'discovery',
        enabled: s.enabledFor(providerId, id),
        stale: s.staleFor(providerId, id),
      })
    }
  }
  return { catalog, seed, plans }
}

const rowKey = (r: { provider: string; model: string }) => `${r.provider}|${r.model}`
const staleSet = (db: FakeDb) => new Set(db.rows.filter(r => r.stale).map(rowKey))
const enabledSet = (db: FakeDb) => new Set(db.rows.filter(r => r.enabled).map(rowKey))

// Low floors: keep the sanity guard OUT of the way so the stale mechanics run.
const LIVE_LOW_FLOOR = { minPlausibleLiveTotal: 1, providerMinLive: 0 } as const

describe('catalog sync — property-based reconciliation invariants (R1-M4)', () => {
  it('P1 idempotence: re-applying the same LIVE catalog stales nothing new and does not flip-flop', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb({ allowZeroLive: false }), async scenario => {
        const { catalog, seed } = materialize(scenario)
        const db = makeFakeDb(seed)

        await syncDiscoveredModels(
          { loadCatalog: loadStub(catalog, 'live'), ...LIVE_LOW_FLOOR },
          db.connector
        )
        const staleAfter1 = staleSet(db)
        const enabledAfter1 = enabledSet(db)

        const res2 = await syncDiscoveredModels(
          { loadCatalog: loadStub(catalog, 'live'), ...LIVE_LOW_FLOOR },
          db.connector
        )

        // 2nd pass: nothing new staled, nothing new inserted, no stale flip-flop.
        expect(res2.staled).toBe(0)
        expect(res2.added).toBe(0)
        expect(staleSet(db)).toEqual(staleAfter1)
        expect(enabledSet(db)).toEqual(enabledAfter1)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('P2 auto-heal: every still-listed discovery row ends stale=false, and stays healed on re-run', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb({ allowZeroLive: false }), async scenario => {
        const { catalog, seed, plans } = materialize(scenario)
        const db = makeFakeDb(seed)

        await syncDiscoveredModels(
          { loadCatalog: loadStub(catalog, 'live'), ...LIVE_LOW_FLOOR },
          db.connector
        )

        // A present (still-listed) model — whether seeded stale or freshly
        // inserted — must be non-stale after a live sync.
        for (const plan of plans) {
          for (const id of plan.presentIds) {
            expect(db.get(plan.providerId, id)?.stale).toBe(false)
          }
        }

        const res2 = await syncDiscoveredModels(
          { loadCatalog: loadStub(catalog, 'live'), ...LIVE_LOW_FLOOR },
          db.connector
        )
        // Re-run must not re-stale a healed row.
        expect(res2.staled).toBe(0)
        for (const plan of plans) {
          for (const id of plan.presentIds) {
            expect(db.get(plan.providerId, id)?.stale).toBe(false)
          }
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('P3 non-destructive: the set of enabled rows is invariant and no seeded row is dropped', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb({ allowZeroLive: false }), async scenario => {
        const { catalog, seed } = materialize(scenario)
        const db = makeFakeDb(seed)

        const enabledBefore = new Set(seed.filter(r => r.enabled).map(rowKey))

        await syncDiscoveredModels(
          { loadCatalog: loadStub(catalog, 'live'), ...LIVE_LOW_FLOOR },
          db.connector
        )

        // Reconciliation never enables or disables a row: the enabled set is
        // exactly what was seeded (new inserts are enabled=false).
        expect(enabledSet(db)).toEqual(enabledBefore)
        // No seeded row is ever deleted, and its enabled flag is untouched.
        for (const s of seed) {
          const row = db.get(s.provider, s.model)
          expect(row).toBeDefined()
          expect(row?.enabled).toBe(s.enabled ?? false)
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('P4a global floor: a below-floor LIVE total marks nothing new stale (fail-safe)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb({ allowZeroLive: false }), async scenario => {
        const { catalog, seed } = materialize(scenario)
        const db = makeFakeDb(seed)

        // Rows that were stale BEFORE the run (the guard may still HEAL present
        // rows to non-stale, so the post set may only shrink — never grow).
        const staleBefore = new Set(seed.filter(r => r.stale).map(rowKey))

        const res = await syncDiscoveredModels(
          // Impossibly high global floor → every live total is "implausible".
          { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1_000_000 },
          db.connector
        )

        // No vanished→stale marking happened this run.
        expect(res.staled).toBe(0)
        // Fail-safe: no row transitioned false→true. Post-stale ⊆ pre-stale.
        for (const key of staleSet(db)) {
          expect(staleBefore.has(key)).toBe(true)
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('P4b per-provider floor: a provider below its live floor keeps its rows unstaled', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb({ allowZeroLive: true }), async scenario => {
        const { catalog, seed, plans } = materialize(scenario)

        // Providers below the floor (0 live here, providerMinLive=0 → floor=1)
        // that DO have pre-existing discovery rows are the protected set.
        const protectedProviders = plans.filter(
          p => p.presentIds.length === 0 && p.vanishedIds.length > 0
        )
        // Non-vacuous only when at least one such provider exists.
        fc.pre(protectedProviders.length > 0)

        const db = makeFakeDb(seed)
        const staleBeforeByKey = new Map(seed.map(r => [rowKey(r), r.stale ?? false]))

        await syncDiscoveredModels(
          { loadCatalog: loadStub(catalog, 'live'), minPlausibleLiveTotal: 1, providerMinLive: 0 },
          db.connector
        )

        // Every protected provider's rows: none transitions false→true stale.
        for (const plan of protectedProviders) {
          for (const id of plan.vanishedIds) {
            const before = staleBeforeByKey.get(`${plan.providerId}|${id}`) ?? false
            const after = db.get(plan.providerId, id)?.stale
            if (!before) expect(after).toBe(false)
          }
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })
})
