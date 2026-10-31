/**
 * Model-based test of catalog auto-enable under concurrency.
 *
 * Real code: `syncDiscoveredModels`, the admin allowlist services, the price
 * create, the policy toggle and `LlmAllowedModelsConfigMapWriter`. Simulated,
 * and nothing else: Postgres and the ConfigMap API (create → 409 if it exists,
 * replace with a resourceVersion CAS). Every statement and every K8s call waits
 * on `fc.scheduler()`, so each step runs 2–3 commands with an interleaving the
 * scheduler picks.
 *
 * Postgres is the strict fake. Its table semantics are compared with real
 * Postgres one session at a time, and its waits on a fixed set of two-session
 * interleavings (sync INSERT against an in-flight rename, create or price;
 * stale marking and the refresh UPDATE against an in-flight admin update;
 * toggle against the sync lock; the cron's session lock): see the differential
 * suite. The interleavings this test reaches beyond that set are only as
 * faithful as the fake's wait rules, which are not checked against Postgres.
 *
 * The reference is deliberately small: the provider policy defaults, an
 * eligibility rule read straight off the raw catalog entry (not the production
 * predicate), the per-run caps with their order, the pairs operators removed,
 * and who last wrote each row, all from the fake's commit history. After every
 * step it checks:
 *   - the sync never changes `enabled` of a row it did not insert;
 *   - a vendored or implausible run never inserts a provider whose policy is on;
 *   - a row the sync inserted enabled was justified when the run took the sync
 *     lock: live and plausible, policy on, eligible, not removed by an
 *     operator, within both caps;
 *   - a pair an operator removed is never enabled again by the sync;
 *   - the sync only inserts prices, and only for pairs it inserted;
 *   - a pair the sync inserted with a catalog cost carries exactly that price,
 *     unless an operator created a price for it.
 * After the commands, with quiescent live runs:
 *   - the new candidates the caps admit are enabled, the rest wait uninserted,
 *     and they all complete within ⌈waiting / min(caps)⌉ runs;
 *   - the ConfigMap equals what Postgres projects;
 *   - no run writes the ConfigMap more than once, and none when it already
 *     matches.
 *
 * Reproduce a failure with the `seed`/`path` fast-check prints, passed to
 * `fc.assert` in `ASSERT_OPTIONS`.
 */
import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import fc from 'fast-check'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT, PROVIDER_IDS } from '@clerum/llm-providers'
import { withTransaction } from '../src/db.js'
import {
  createAllowedModel,
  deleteAllowedModel,
  updateAllowedModel,
} from '../src/services/llmAllowedModels.js'
import { LlmAllowedModelsConfigMapWriter } from '../src/services/llmAllowedModelsConfigMap.js'
import { AllowlistPublishRetry } from '../src/services/llmAllowlistPublishRetry.js'
import {
  CatalogPublishAfterCommitError,
  type SyncConnector,
  syncDiscoveredModels,
} from '../src/services/llmCatalogSync.js'
import { createLlmPrice } from '../src/services/llmPrices.js'
import { setProviderAutoEnable } from '../src/services/llmProviderCatalogSettings.js'
import {
  type DiscoveredModel,
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  type RawModelsDevModel,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { referenceEligible } from './helpers/autoEnableReference.js'
import { FakeConfigMapApi } from './helpers/fakeAllowlistCluster.js'
import { type FakeDb, type HistoryEvent, makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  LIVE_MODELS_DEV_CATALOG,
  loadStub,
  trimLiveCatalog,
  trimSnapshot,
} from './helpers/modelsDevFixtures.js'

const ASSERT_OPTIONS: fc.Parameters<unknown> = { numRuns: 200 }

type Provider = 'claude' | 'deepseek' | 'groq'
const PROVIDERS: Provider[] = ['claude', 'deepseek', 'groq']
const MAX_PER_PROVIDER = 2
const MAX_PER_RUN = 3
const SYNC_LOCK_KEY = 'llm-catalog-sync-v1'

// ---- catalogs, cut from the captured live api.json ---------------------------

/** The raw entry behind each mapped pair, so the reference reads catalog fields itself. */
const RAW_BY_PAIR = new Map<string, RawModelsDevModel>()

/** Per provider: the first eligible and ineligible entries, by the reference rule. */
function pickIds(provider: Provider, eligible: number, ineligible: number): string[] {
  const key = PROVIDER_KEY_MAP[provider]
  const out: string[] = []
  let e = 0
  let i = 0
  for (const [rawId, raw] of Object.entries(LIVE_MODELS_DEV_CATALOG[key].models)) {
    const [m] = mapCatalogToProviders(trimLiveCatalog({ [key]: [rawId] }))[provider]
    if (!m) continue
    if (referenceEligible(raw, m.model_id) ? e++ < eligible : i++ < ineligible) {
      out.push(rawId)
      RAW_BY_PAIR.set(`${provider}/${m.model_id}`, raw)
    }
  }
  if (out.length !== eligible + ineligible) throw new Error(`fixture too small for ${provider}`)
  return out
}

const PICKED: Record<Provider, string[]> = {
  claude: pickIds('claude', 3, 0),
  deepseek: pickIds('deepseek', 2, 1),
  groq: pickIds('groq', 2, 2),
}
// One more real claude entry, eligible as captured, with its `status` set to a
// value models.dev does not use today: it must never be enabled.
const UNKNOWN_STATUS_RAW_ID = Object.keys(LIVE_MODELS_DEV_CATALOG.anthropic.models).find(
  id => !PICKED.claude.includes(id)
)!
const UNKNOWN_STATUS_ENTRY: RawModelsDevModel = {
  ...LIVE_MODELS_DEV_CATALOG.anthropic.models[UNKNOWN_STATUS_RAW_ID],
  status: 'preview',
}
{
  const [m] = mapCatalogToProviders({
    anthropic: { models: { [UNKNOWN_STATUS_RAW_ID]: UNKNOWN_STATUS_ENTRY } },
  }).claude
  RAW_BY_PAIR.set(`claude/${m.model_id}`, UNKNOWN_STATUS_ENTRY)
}

function withUnknownStatusEntry(catalog: RawModelsDevCatalog): RawModelsDevCatalog {
  const key = PROVIDER_KEY_MAP.claude
  return {
    ...catalog,
    [key]: {
      ...catalog[key],
      models: { ...catalog[key].models, [UNKNOWN_STATUS_RAW_ID]: UNKNOWN_STATUS_ENTRY },
    },
  }
}

const FULL = withUnknownStatusEntry(
  trimLiveCatalog(Object.fromEntries(PROVIDERS.map(p => [PROVIDER_KEY_MAP[p], PICKED[p]])))
)
// Without each provider's first entry: those rows go stale, and come back later.
const PARTIAL = withUnknownStatusEntry(
  trimLiveCatalog(Object.fromEntries(PROVIDERS.map(p => [PROVIDER_KEY_MAP[p], PICKED[p].slice(1)])))
)
const VENDORED = trimSnapshot(Object.fromEntries(PROVIDERS.map(p => [PROVIDER_KEY_MAP[p], 3])))

const FULL_MAPPED = mapCatalogToProviders(FULL)
const CATALOG_ENTRY = new Map<string, DiscoveredModel>(
  PROVIDERS.flatMap(p => FULL_MAPPED[p].map(m => [`${p}/${m.model_id}`, m] as const))
)

function eligible(pair: string): boolean {
  const raw = RAW_BY_PAIR.get(pair)
  if (!raw) throw new Error(`no raw catalog entry for ${pair}`)
  return referenceEligible(raw, pair.slice(pair.indexOf('/') + 1))
}

/** Pairs commands may name: every catalog entry plus one off-catalog id per provider. */
const PAIRS: Array<{ provider: Provider; model: string }> = PROVIDERS.flatMap(p => [
  ...FULL_MAPPED[p].map(m => ({ provider: p, model: m.model_id })),
  { provider: p, model: `${p}-operator-model` },
])

// ---- the reference -------------------------------------------------------------

const pairOf = (r: Record<string, unknown>) => `${String(r.provider)}/${String(r.model)}`
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Newest `release_date` first (as text), undated last, then `model_id`. */
function capOrder(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    const ra = a.release_date
    const rb = b.release_date
    if (ra === undefined && rb !== undefined) return 1
    if (rb === undefined && ra !== undefined) return -1
    if (ra !== undefined && rb !== undefined && ra !== rb) return -byCodeUnits(ra, rb)
    return byCodeUnits(a.model_id, b.model_id)
  })
}

/** The policy in force at clock `seq`: the code default, overridden by toggles committed before. */
function policyAt(history: HistoryEvent[], seq: number): Record<string, boolean> {
  const policy: Record<string, boolean> = { ...PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT }
  for (const e of history) {
    if (e.table === 'llm_provider_catalog_settings' && e.seq < seq && e.after) {
      policy[String(e.after.provider)] = e.after.auto_enable === true
    }
  }
  return policy
}

/**
 * Pairs an operator removed (deleted, or renamed away) before clock `seq`, from
 * the admin commands' own commits: the reference's tombstones, independent of
 * whether the code under test wrote one.
 */
function removedByOperatorBefore(history: HistoryEvent[], seq: number): Set<string> {
  const out = new Set<string>()
  for (const e of history) {
    if (e.seq >= seq || e.table !== 'llm_allowed_models' || !e.before) continue
    if (!e.actor.startsWith('admin-')) continue
    if (!e.after || pairOf(e.after) !== pairOf(e.before)) out.add(pairOf(e.before))
  }
  return out
}

/** Per pair: whether it is enabled and who wrote that, replaying the commit history. */
function provenance(history: HistoryEvent[]): Map<string, { enabled: boolean; writer: string }> {
  const out = new Map<string, { enabled: boolean; writer: string }>()
  for (const e of history) {
    if (e.table !== 'llm_allowed_models') continue
    const previous = e.before ? out.get(pairOf(e.before)) : undefined
    if (e.before) out.delete(pairOf(e.before))
    if (e.after) {
      const pair = pairOf(e.after)
      // A write that keeps the same pair and the same `enabled` leaves the
      // decision with whoever made it.
      const kept =
        e.before !== null && pairOf(e.before) === pair && e.before.enabled === e.after.enabled
      const writer = kept && previous ? previous.writer : e.actor
      out.set(pair, { enabled: e.after.enabled === true, writer })
    }
  }
  return out
}

/**
 * What a quiescent live run over FULL must leave for pairs that had no row:
 * candidates (policy on, eligible) in cap order take the caps; a tombstoned
 * candidate is inserted disabled without taking one; a candidate past a cap is
 * not inserted; anything else is inserted disabled.
 */
function expectedNewRows(
  existing: Set<string>,
  policy: Record<string, boolean>,
  dismissed: Set<string>
): Map<string, boolean | 'absent'> {
  const out = new Map<string, boolean | 'absent'>()
  let total = 0
  for (const provider of PROVIDER_IDS) {
    if (!PROVIDERS.includes(provider as Provider)) continue
    const fresh = FULL_MAPPED[provider].filter(m => !existing.has(`${provider}/${m.model_id}`))
    const candidates: DiscoveredModel[] = []
    for (const m of fresh) {
      if (policy[provider] && eligible(`${provider}/${m.model_id}`)) candidates.push(m)
      else out.set(`${provider}/${m.model_id}`, false)
    }
    let mine = 0
    for (const m of capOrder(candidates)) {
      const pair = `${provider}/${m.model_id}`
      if (mine >= MAX_PER_PROVIDER || total >= MAX_PER_RUN) {
        out.set(pair, 'absent')
        continue
      }
      if (dismissed.has(pair)) {
        out.set(pair, false)
        continue
      }
      out.set(pair, true)
      mine += 1
      total += 1
    }
  }
  return out
}

// ---- the system under test ------------------------------------------------------

interface World {
  db: FakeDb
  cluster: FakeConfigMapApi
  retry: AllowlistPublishRetry
  scheduler: fc.Scheduler
  seq: number
  /** Successful ConfigMap writes, per writer label. */
  writes: Map<string, number>
  /** How each sync run was asked to run, by actor label. */
  runs: Map<string, 'live' | 'vendored' | 'implausible'>
}

function writerFor(w: World, label: string): LlmAllowedModelsConfigMapWriter {
  const gate = () => w.scheduler.schedule(Promise.resolve(), `k8s:${label}`)
  const counted = async <T>(call: () => Promise<T>) => {
    await gate()
    const out = await call()
    w.writes.set(label, (w.writes.get(label) ?? 0) + 1)
    return out
  }
  const api = {
    readNamespacedConfigMap: async (req: { namespace: string; name: string }) => {
      await gate()
      return w.cluster.readNamespacedConfigMap(req)
    },
    createNamespacedConfigMap: (req: { namespace: string; body: k8s.V1ConfigMap }) =>
      counted(() => w.cluster.createNamespacedConfigMap(req)),
    replaceNamespacedConfigMap: (req: { namespace: string; name: string; body: k8s.V1ConfigMap }) =>
      counted(() => w.cluster.replaceNamespacedConfigMap(req)),
  }
  // One attempt, so an injected K8s failure fails the publication instead of
  // being absorbed by the writer's own retry.
  // The writer races every K8s call against a real timer; one that fired
  // while the scheduler held the call would fail it at random. The bound is
  // out of reach here, so only the scheduler decides when a call returns.
  return new LlmAllowedModelsConfigMapWriter(
    api as never,
    'mcp-host',
    1,
    w.db.pool(`publish:${label}`),
    2_000_000_000
  )
}

function runSync(
  w: World,
  label: string,
  mode: 'live' | 'vendored' | 'implausible',
  variant: 'full' | 'partial'
) {
  w.runs.set(label, mode)
  const catalog: RawModelsDevCatalog =
    mode === 'vendored' ? VENDORED : variant === 'full' ? FULL : PARTIAL
  return syncDiscoveredModels(
    {
      materializer: writerFor(w, label),
      loadCatalog: loadStub(
        catalog,
        mode === 'vendored' ? 'vendored' : 'live',
        LIVE_MODELS_DEV_CAPTURED_AT
      ),
      minPlausibleLiveTotal: mode === 'implausible' ? 1_000_000 : 1,
      autoEnableMaxPerProviderPerRun: MAX_PER_PROVIDER,
      autoEnableMaxPerRun: MAX_PER_RUN,
      publishRetry: w.retry,
    },
    w.db.pool(label) as unknown as SyncConnector
  )
}

type Sub =
  | { kind: 'sync'; mode: 'live' | 'vendored' | 'implausible'; variant: 'full' | 'partial' }
  | { kind: 'create'; pair: number; enabled: boolean }
  | { kind: 'put'; target: number; op: 'enable' | 'disable' | 'rename'; to: number }
  | { kind: 'delete'; target: number }
  | { kind: 'toggle'; provider: Provider; on: boolean }
  | { kind: 'price'; pair: number; enabled: boolean }
  | { kind: 'failK8s' }
  | { kind: 'boot'; replica: 'a' | 'b' }

const subArb: fc.Arbitrary<Sub> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant('sync' as const),
      mode: fc.constantFrom('live' as const, 'vendored' as const, 'implausible' as const),
      variant: fc.constantFrom('full' as const, 'partial' as const),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      pair: fc.nat(),
      enabled: fc.boolean(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('put' as const),
      target: fc.nat(),
      op: fc.constantFrom('enable' as const, 'disable' as const, 'rename' as const),
      to: fc.nat(),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant('delete' as const), target: fc.nat() }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constant('toggle' as const),
      provider: fc.constantFrom(...PROVIDERS),
      on: fc.boolean(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('price' as const),
      pair: fc.nat(),
      enabled: fc.boolean(),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant('failK8s' as const) }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant('boot' as const),
      replica: fc.constantFrom('a' as const, 'b' as const),
    }),
    weight: 1,
  }
)

// A deadlock (40P01) is possible in Postgres too: within one provider the
// sync can insert pair Q, holding its key, and then update row X, while an
// admin rename X → Q holds row X and waits on Q. One cycle aborts one
// command, so a step (2–3 concurrent commands) may lose at most one. Which
// command loses differs: the fake aborts the waiter that closes the cycle,
// while Postgres aborts whichever session's deadlock check runs first after
// `deadlock_timeout`. The scheduler tries both arrival orders, so each command
// is the one that closes the cycle in some runs. None was seen in more than
// 10 000 runs.
const MAX_DEADLOCKS_PER_STEP = 1

/** Errors the real code is allowed to end a command with; anything else fails the test. */
function tolerated(raw: unknown, step: { deadlocks: number }): boolean {
  // A sync whose rows committed reports its publish failure wrapped.
  const err = raw instanceof CatalogPublishAfterCommitError ? raw.cause : raw
  const e = err as { name?: string; code?: unknown; message?: string }
  if (/unrecognized/.test(String(e?.message))) return false
  if (e?.code === '40P01') {
    step.deadlocks += 1
    return step.deadlocks <= MAX_DEADLOCKS_PER_STEP
  }
  return (
    e?.name === 'LlmAllowedModelConflictError' ||
    e?.name === 'LlmPriceConflictError' ||
    e?.code === 503 ||
    e?.code === 409
  )
}

function execute(
  w: World,
  sub: Sub,
  rowsAtStart: Array<{ id: string; provider: string; model: string }>
) {
  const n = (w.seq += 1)
  const pickRow = (i: number) =>
    rowsAtStart.length ? rowsAtStart[i % rowsAtStart.length] : undefined
  const admin = async (label: string, work: () => Promise<unknown>) => {
    await work()
    // As the admin routes do after every mutation.
    await writerFor(w, label).materialize()
  }
  switch (sub.kind) {
    case 'sync':
      return runSync(w, `sync#${n}`, sub.mode, sub.variant)
    case 'create': {
      const { provider, model } = PAIRS[sub.pair % PAIRS.length]
      const label = `admin-create#${n}`
      return admin(label, () =>
        createAllowedModel(
          { provider, model, enabled: sub.enabled } as never,
          'admin',
          w.db.pool(label)
        )
      )
    }
    case 'put': {
      const row = pickRow(sub.target)
      if (!row) return Promise.resolve()
      const label = `admin-put#${n}`
      let input: Record<string, unknown> = { enabled: sub.op === 'enable' }
      if (sub.op === 'rename') {
        const sameProvider = PAIRS.filter(p => p.provider === row.provider && p.model !== row.model)
        input = { model: sameProvider[sub.to % sameProvider.length].model }
      }
      return admin(label, () =>
        withTransaction(
          tx => updateAllowedModel(row.id, input as never, 'admin', tx),
          w.db.pool(label)
        )
      )
    }
    case 'delete': {
      const row = pickRow(sub.target)
      if (!row) return Promise.resolve()
      const label = `admin-delete#${n}`
      return admin(label, () =>
        withTransaction(tx => deleteAllowedModel(row.id, 'admin', tx), w.db.pool(label))
      )
    }
    case 'toggle':
      return setProviderAutoEnable(sub.provider, sub.on, 'admin', w.db.pool(`toggle#${n}`))
    case 'price': {
      const { provider, model } = PAIRS[sub.pair % PAIRS.length]
      return createLlmPrice(
        {
          provider,
          model,
          input_token_price: 7,
          output_token_price: 9,
          cache_read_token_price: 0,
          cache_write_token_price: 0,
          currency: 'USD',
          enabled: sub.enabled,
        } as never,
        w.db.pool(`price#${n}`)
      )
    }
    case 'failK8s':
      w.cluster.failNextWrites(1)
      return Promise.resolve()
    case 'boot':
      return writerFor(w, `boot-${sub.replica}#${n}`).materialize()
  }
}

// ---- invariants at rest -----------------------------------------------------------

function lockSeq(w: World, actor: string): number | undefined {
  return w.db.locks.find(l => l.actor === actor && l.key === SYNC_LOCK_KEY)?.seq
}

function checkSafety(w: World): void {
  const history = w.db.history
  const enabledInserts = new Map<string, Map<string, number>>()
  for (const e of history) {
    const bySync = e.actor.startsWith('sync#')
    if (e.table === 'llm_allowed_models' && bySync) {
      // An existing row's `enabled` is never the sync's to change, nor to delete.
      expect(
        e.after,
        `sync deleted a row: ${e.actor} deleted ${e.before && pairOf(e.before)}`
      ).not.toBeNull()
      if (e.before) {
        expect(
          e.after!.enabled,
          `sync changed an existing enabled: ${e.actor} changed enabled of ${pairOf(e.before)}`
        ).toBe(e.before.enabled)
        continue
      }
      // A run that cannot decide never inserts a provider whose policy is on:
      // the row would stay disabled for good once a live run finds it.
      if (w.runs.get(e.actor) !== 'live') {
        const L0 = lockSeq(w, e.actor)
        expect(
          policyAt(history, L0 ?? e.seq)[String(e.after!.provider)],
          `undecidable run inserted a policy-on provider: ${e.actor} inserted ${pairOf(e.after!)} of a provider with policy on`
        ).toBe(false)
      }
      if (e.after!.enabled !== true) continue
      // An enabled insert was justified at the moment the run took the lock.
      const pair = pairOf(e.after!)
      const L = lockSeq(w, e.actor)
      expect(L, `unjustified enable: ${e.actor} inserted without the sync lock`).toBeDefined()
      expect(
        w.runs.get(e.actor),
        `unjustified enable: ${e.actor} enabled ${pair} from an undecidable run`
      ).toBe('live')
      expect(
        policyAt(history, L!)[String(e.after!.provider)],
        `unjustified enable: policy off for ${pair}`
      ).toBe(true)
      expect(eligible(pair), `unjustified enable: ${pair} is not eligible`).toBe(true)
      expect(
        removedByOperatorBefore(history, L!).has(pair),
        `unjustified enable: ${pair} was removed by an operator before ${e.actor}`
      ).toBe(false)
      // Nor removed between the lock and this run's commit.
      expect(
        removedByOperatorBefore(history, e.seq).has(pair),
        `operator removal undone: ${e.actor} re-enabled ${pair}`
      ).toBe(false)
      const perProvider = enabledInserts.get(e.actor) ?? new Map<string, number>()
      perProvider.set(
        String(e.after!.provider),
        (perProvider.get(String(e.after!.provider)) ?? 0) + 1
      )
      enabledInserts.set(e.actor, perProvider)
    }
    if (e.table === 'llm_model_prices' && bySync) {
      // The sync only inserts prices, and only for a pair it inserted in the same commit.
      expect(e.before, `sync changed a price: ${e.actor} changed an existing price`).toBeNull()
      const pair = pairOf(e.after!)
      const ownInsert = history.some(
        x =>
          x.seq === e.seq &&
          x.actor === e.actor &&
          x.table === 'llm_allowed_models' &&
          x.before === null &&
          x.after !== null &&
          pairOf(x.after) === pair
      )
      expect(ownInsert, `sync priced a pair it did not insert: ${e.actor} priced ${pair}`).toBe(
        true
      )
    }
  }
  for (const [actor, perProvider] of enabledInserts) {
    let total = 0
    for (const [provider, count] of perProvider) {
      expect(
        count,
        `per-provider cap exceeded: ${actor} enabled ${count} of ${provider}`
      ).toBeLessThanOrEqual(MAX_PER_PROVIDER)
      total += count
    }
    expect(total, `per-run cap exceeded: ${actor} enabled ${total}`).toBeLessThanOrEqual(
      MAX_PER_RUN
    )
  }

  // At rest: a pair an operator removed that is enabled now was enabled by an operator.
  const ref = provenance(history)
  for (const pair of removedByOperatorBefore(history, Number.MAX_SAFE_INTEGER)) {
    const now = ref.get(pair)
    if (now?.enabled) {
      expect(
        now.writer.startsWith('sync#'),
        `operator removal undone at rest: ${pair} re-enabled by ${now.writer}`
      ).toBe(false)
    }
  }

  // A pair the sync inserted from a live catalog carries its catalog price,
  // unless an operator priced it.
  for (const e of history) {
    if (e.table !== 'llm_allowed_models' || !e.actor.startsWith('sync#') || e.before || !e.after)
      continue
    if (w.runs.get(e.actor) === 'vendored') continue
    const pair = pairOf(e.after)
    const cost = CATALOG_ENTRY.get(pair)?.cost
    if (!cost) continue
    const operatorPriced = history.some(
      x =>
        x.table === 'llm_model_prices' &&
        x.actor.startsWith('price#') &&
        x.after &&
        pairOf(x.after) === pair
    )
    if (operatorPriced) continue
    const prices = w.db.prices.filter(p => `${p.provider}/${p.model}` === pair)
    expect(
      prices.map(p => [
        p.input_token_price,
        p.output_token_price,
        p.cache_read_token_price,
        p.cache_write_token_price,
      ]),
      `catalog price of an inserted pair: ${pair}`
    ).toEqual([[cost.input, cost.output, cost.cache_read, cost.cache_write]])
  }
}

async function quiescentRun(w: World, label: string) {
  w.cluster.clearPendingFailures()
  const done = runSync(w, label, 'live', 'full')
  await w.scheduler.waitFor(done)
}

async function checkLiveness(w: World): Promise<void> {
  const existing = new Set(w.db.rows.map(r => `${r.provider}/${r.model}`))
  const clock = (w.db.history.at(-1)?.seq ?? 0) + 1_000_000
  const expected = expectedNewRows(
    existing,
    policyAt(w.db.history, clock),
    removedByOperatorBefore(w.db.history, clock)
  )

  await quiescentRun(w, 'sync#check-1')
  // New candidates of this run.
  for (const [pair, outcome] of expected) {
    const [provider, ...rest] = pair.split('/')
    const row = w.db.get(provider, rest.join('/'))
    if (outcome === 'absent')
      expect(row, `capped candidate inserted early: ${pair}`).toBeUndefined()
    else expect(row?.enabled, `new candidate after a live run: ${pair}`).toBe(outcome)
  }
  await expectConfigMapMatches(w, 'check-1')

  // Over later runs: the waiting candidates complete within ⌈k / min(N, G)⌉ runs.
  const waiting = [...expected.values()].filter(o => o === 'absent').length
  const bound = Math.ceil(waiting / Math.min(MAX_PER_PROVIDER, MAX_PER_RUN))
  for (let run = 1; run <= bound; run++) {
    await quiescentRun(w, `sync#drain-${run}`)
    await expectConfigMapMatches(w, `drain-${run}`)
  }
  const policy = policyAt(w.db.history, Number.MAX_SAFE_INTEGER)
  const removed = removedByOperatorBefore(w.db.history, Number.MAX_SAFE_INTEGER)
  for (const p of PROVIDERS) {
    for (const m of FULL_MAPPED[p]) {
      const pair = `${p}/${m.model_id}`
      if (!policy[p] || !eligible(pair) || removed.has(pair)) continue
      if (expected.get(pair) === 'absent') {
        expect(
          w.db.get(p, m.model_id)?.enabled,
          `waiting candidate after ${bound} runs: ${pair}`
        ).toBe(true)
      }
    }
  }

  // Every run wrote the ConfigMap at most once…
  for (const [label, count] of w.writes) {
    if (label.startsWith('sync#'))
      expect(count, `ConfigMap writes per run: ${label}`).toBeLessThanOrEqual(1)
  }
  // …and a run over a ConfigMap that already matches writes nothing.
  await quiescentRun(w, 'sync#idempotent')
  expect(
    w.writes.get('sync#idempotent') ?? 0,
    'ConfigMap write on a run with nothing to change'
  ).toBe(0)
}

/** The ConfigMap holds exactly what Postgres projects. */
async function expectConfigMapMatches(w: World, when: string): Promise<void> {
  const projected = await w.db.expectedConfigMap()
  expect(w.cluster.data ?? {}, `ConfigMap vs Postgres after ${when}: data`).toEqual(projected.data)
  expect(
    w.cluster.annotations?.['clerum.io/content-hash'],
    `ConfigMap vs Postgres after ${when}: hash`
  ).toBe(projected.contentHash)
}

// ---- the property ------------------------------------------------------------------

class Step implements fc.AsyncCommand<object, World> {
  constructor(readonly subs: Sub[]) {}
  check(): boolean {
    return true
  }
  async run(_m: object, w: World): Promise<void> {
    const rowsAtStart = [...w.db.rows]
      .sort((a, b) => byCodeUnits(`${a.provider}/${a.model}`, `${b.provider}/${b.model}`))
      .map(r => ({ id: r.id, provider: r.provider, model: r.model }))
    const outcomes = await w.scheduler.waitFor(
      Promise.allSettled(
        this.subs.map(async sub => {
          await execute(w, sub, rowsAtStart)
        })
      )
    )
    const step = { deadlocks: 0 }
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected' && !tolerated(outcome.reason, step)) throw outcome.reason
    }
    checkSafety(w)
  }
  toString(): string {
    return `Step(${this.subs.map(s => JSON.stringify(s)).join(', ')})`
  }
}

describe('catalog auto-enable · model-based', () => {
  it('keeps operator decisions, the caps, prices and the ConfigMap right under concurrent syncs, admin writes, toggles and K8s failures', async () => {
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT).toMatchObject({
      claude: true,
      deepseek: true,
      groq: false,
    })
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          [fc.array(subArb, { minLength: 2, maxLength: 3 }).map(subs => new Step(subs))],
          { maxCommands: 8 }
        ),
        async (scheduler, commands) => {
          const w: World = {
            db: undefined as unknown as FakeDb,
            cluster: new FakeConfigMapApi(),
            retry: new AllowlistPublishRetry({ baseDelayMs: 1_000_000_000 }),
            scheduler,
            seq: 0,
            writes: new Map(),
            runs: new Map(),
          }
          w.db = makeFakeDb(
            [],
            {},
            {
              gate: ({ actor, sql }) =>
                actor === 'oracle'
                  ? Promise.resolve()
                  : scheduler
                      .schedule(Promise.resolve(), `${actor}: ${sql.slice(0, 40)}`)
                      .then(() => undefined),
            }
          )
          try {
            await fc.asyncModelRun(() => ({ model: {}, real: w }), commands)
            await checkLiveness(w)
          } finally {
            w.retry.stop()
          }
        }
      ),
      ASSERT_OPTIONS
    )
  }, 120_000)
})
