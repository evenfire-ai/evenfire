/**
 * Model-based check of the catalog prune, the re-enable of pruned rows and the
 * attention feed with its acknowledgements: random sequences of catalog syncs
 * (live, vendored, implausible, with models dropped, deprecated or back), the
 * passage of time, operator PUTs and DELETEs on models, auto-enable policy
 * toggles, Host / grant / WorkflowRecipe writes, feed reads, acknowledgements
 * sent from an earlier feed and their undo. Every step's outcome is compared,
 * at rest, with a trivial reference model that knows nothing of the production
 * code: the rows of the tracked pairs in Postgres, the published allowlist
 * ConfigMap, the automatic audit rows and the feed body.
 *
 * Layers:
 *   - Postgres is real. The sync, the prune (`catalogPruneFromGateway`), the
 *     ConfigMap writer and every admin route are the production code; models,
 *     Hosts, grants, recipes, policies and acknowledgements are written through
 *     their routes, the catalog comes from the captured models.dev fixture (and
 *     the real vendored fallback of the loader).
 *   - The apiserver is the in-memory `MockGateway`, with the allowlist
 *     ConfigMap backed by `FakeConfigMapApi` so routes and syncs publish to the
 *     same object.
 *   - Races: a race step starts one operator or consumer write while the prune
 *     of a live sync runs. The write's start, every Host / recipe LIST of the
 *     gateway and the prune's `beforeLock` / `beforeUpdate` points wait on the
 *     fast-check scheduler, so each run orders the pre-filter, the locked
 *     re-check and the write differently. Transactions are never gated while
 *     waiting on Postgres: a write blocked on the model lock is released by
 *     Postgres, never by the scheduler. The model does not pick the order; it
 *     accepts any outcome some serialization of the write against each
 *     candidate's decision explains, and a candidate whose consumers the write
 *     changed may be decided on either side of it.
 *   - Time: the grace is 2.5 h and a tick moves every `stale_since` one hour
 *     back, so a model is prunable from its third tick on. Real seconds never
 *     reach the half-hour margin.
 *
 * Between steps, besides the model comparison, the at-rest predicates are
 * checked on Postgres alone: the prune token only on catalog-managed, discovered,
 * disabled, stale rows; and, around a sequential sync, that it changed `enabled`
 * only as the prune and the re-enable may (operator rows, manual rows, rows
 * inside the grace, rows with consumers and non-live runs are left alone).
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/llmCatalogPrune.model.realPostgres.integration.test.ts
 *
 * A failure prints the command sequence, the scheduler's release order of the
 * failing step and the violations. `FC_SEED=<n>` replays another seed and
 * `FC_NUM_RUNS=<n>` changes the number of runs; `FC_SHRINK=1` shrinks it;
 * `FC_COVERAGE=<file>` writes how often each state was reached. The seed fixes
 * the generated sequences and the scheduler's release order, not the outcome of
 * a race: Postgres decides when a transaction blocked on a lock resumes, so a
 * replay can serialize a race differently (the model accepts every
 * serialization, so a replay can turn green). The test also fails when the
 * runs never reached the states the invariants are about (a prune, a re-enable,
 * a token dropped by the policy, an acknowledgement reopened, ...): passing them
 * vacuously proves nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import request from 'supertest'
import { type LlmProviderId, PROVIDER_IDS } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../src/data/modelsDevSnapshot.js'
import type { CatalogPrune } from '../src/services/llmCatalogPrune.js'
import type { CatalogSyncResult, SyncConnector } from '../src/services/llmCatalogSync.js'
import {
  type DiscoveredModel,
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  type RawModelsDevModel,
  isAutoEnableEligible,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { FakeConfigMapApi } from './helpers/fakeAllowlistCluster.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  LIVE_MODELS_DEV_CATALOG,
  loadStub,
  trimLiveCatalog,
} from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34' }]),
}))

const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: (...args: unknown[]) => mockFindAdminById(...args),
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
}))

const ADMIN_CLAIMS = {
  sub: '00000000-0000-4000-8000-000000000001',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'admin-jti',
  exp: Math.floor(Date.now() / 1000) + 3600,
}
const ACTIVE_ADMIN = {
  id: ADMIN_CLAIMS.sub,
  username: 'admin',
  email: 'admin@example.com',
  passwordHash: 'hash',
  sessionVersion: 0,
  role: 'admin' as const,
  status: 'active' as const,
  failedAttempts: 0,
  lockedUntil: null,
}
const COOKIE = 'control_ui_admin_session=admin-token'
const API = '/api/v1/admin'

const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20261112
const NUM_RUNS = process.env.FC_NUM_RUNS ? Number(process.env.FC_NUM_RUNS) : 200
const MAX_COMMANDS = 30
/** `FC_SHRINK=1` shrinks a counterexample (slow: every attempt replays on Postgres). */
const SHRINK = process.env.FC_SHRINK === '1'

const HOUR_MS = 3_600_000
const GRACE_MS = 2.5 * HOUR_MS
/** First tick count at which a stale model is outside the grace. */
const PRUNABLE_AGE = 3
const PRUNE_MAX_PER_RUN = 50
const UNCAPPED = 10_000

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

// ── fixture: a tiny catalog cut from the captured live models.dev payload ─────

type Prov = 'openai' | 'claude'
const PROVS: Prov[] = ['openai', 'claude']
const keyOf = (p: Prov) => PROVIDER_KEY_MAP[p]

function discovered(catalog: RawModelsDevCatalog, p: Prov): DiscoveredModel[] {
  return mapCatalogToProviders(catalog)[p as LlmProviderId] ?? []
}

function rawIdOf(catalog: RawModelsDevCatalog, p: Prov, modelId: string): string {
  const entries = catalog[keyOf(p)]!.models
  for (const rawId of Object.keys(entries)) {
    const [d] = discovered(
      { [keyOf(p)]: { ...catalog[keyOf(p)]!, models: { [rawId]: entries[rawId]! } } },
      p
    )
    if (d?.model_id === modelId) return rawId
  }
  throw new Error(`rawIdOf: ${p}/${modelId} not in catalog`)
}

const FULL_LIVE = trimLiveCatalog(
  Object.fromEntries(
    PROVS.map(p => [keyOf(p), Object.keys(LIVE_MODELS_DEV_CATALOG[keyOf(p)]!.models).length])
  )
)
const VENDORED = VENDORED_MODELS_DEV_SNAPSHOT as RawModelsDevCatalog
const eligibleGa = (p: Prov) =>
  discovered(FULL_LIVE, p)
    .filter(m => isAutoEnableEligible(m) && m.catalog_status === null)
    .map(m => m.model_id)
const vendoredIds = (p: Prov) => new Set(discovered(VENDORED, p).map(m => m.model_id))

// openai: two pool models the vendored snapshot also lists (a vendored run
// touches their rows) and one it does not; claude: one pool model. One anchor per
// provider is the always-listed primary model of every Host.
const OPENAI_IN_VENDORED = eligibleGa('openai').filter(m => vendoredIds('openai').has(m))
const OPENAI_NOT_IN_VENDORED = eligibleGa('openai').filter(m => !vendoredIds('openai').has(m))
const CLAUDE_GA = eligibleGa('claude')
if (OPENAI_IN_VENDORED.length < 3 || OPENAI_NOT_IN_VENDORED.length < 1 || CLAUDE_GA.length < 2) {
  throw new Error(
    'the live fixture and the vendored snapshot no longer have the models this test needs'
  )
}
const POOL: Record<Prov, string[]> = {
  openai: [OPENAI_IN_VENDORED[0]!, OPENAI_IN_VENDORED[1]!, OPENAI_NOT_IN_VENDORED[0]!],
  claude: [CLAUDE_GA[0]!],
}
const ANCHOR: Record<Prov, string> = { openai: OPENAI_IN_VENDORED[2]!, claude: CLAUDE_GA[1]! }
const RENAMED_SUFFIX = '-renamed'
const GRANT_RECIPES = ['g1', 'g2']
/** The provider of every grant and of its prompt target. */
const GRANT_PROVIDER: Prov = 'openai'
const POOL_PAIRS = PROVS.flatMap(p => POOL[p].map(m => pairOf(p, m)))
const TRACKED_PAIRS = [...POOL_PAIRS, ...POOL_PAIRS.map(pair => pair + RENAMED_SUFFIX)]

function pairOf(p: string, m: string): string {
  return `${p}/${m}`
}
function splitPair(pair: string): [Prov, string] {
  const i = pair.indexOf('/')
  return [pair.slice(0, i) as Prov, pair.slice(i + 1)]
}

/** The run's base catalog: every pool model and both anchors, live and GA. */
const BASE: RawModelsDevCatalog = trimLiveCatalog(
  Object.fromEntries(
    PROVS.map(p => [keyOf(p), [...POOL[p], ANCHOR[p]].map(m => rawIdOf(FULL_LIVE, p, m))])
  )
)

/** The catalog status the vendored snapshot gives a pool model, or absent. */
function vendoredStatus(pair: string): 'absent' | 'ga' | 'deprecated' {
  const [p, m] = splitPair(pair)
  const d = discovered(VENDORED, p).find(x => x.model_id === m)
  if (!d) return 'absent'
  return d.catalog_status === 'deprecated' ? 'deprecated' : 'ga'
}

type Listing = 'listed' | 'gone' | 'deprecated'

function catalogFor(listing: Record<string, Listing>): RawModelsDevCatalog {
  let catalog = BASE
  for (const pair of POOL_PAIRS) {
    const [p, m] = splitPair(pair)
    const key = keyOf(p)
    const rawId = rawIdOf(BASE, p, m)
    const models = { ...catalog[key]!.models }
    if (listing[pair] === 'gone') delete models[rawId]
    else if (listing[pair] === 'deprecated') {
      models[rawId] = { ...models[rawId]!, status: 'deprecated' } as RawModelsDevModel
    }
    catalog = { ...catalog, [key]: { ...catalog[key]!, models } }
  }
  return catalog
}

// ── the reference model ───────────────────────────────────────────────────────

const STALE_KIND = 'stale_model_referenced'
const DEPRECATED_KIND = 'deprecated_model_enabled'
type Kind = typeof STALE_KIND | typeof DEPRECATED_KIND
const KINDS: Kind[] = [STALE_KIND, DEPRECATED_KIND]

interface Ack {
  episode: number
  keys: string[]
}

interface MRow {
  source: 'discovery' | 'manual'
  enabled: boolean
  managedBy: 'catalog' | 'operator'
  token: boolean
  stale: boolean
  /** Whole ticks since the row turned stale; null when not stale. */
  staleAge: number | null
  staleEpisode: number
  deprecated: boolean
  depEpisode: number
  ack: Partial<Record<Kind, Ack>>
}

interface MHost {
  provider: Prov
  /** Pool models named in `allowedModels`; null = all-models Host. */
  subset: string[] | null
}

interface MGrant {
  id: string
  allowed: string[]
  target: { provider: Prov; model: string }
}

interface SavedItem {
  provider: string
  model: string
  kind: Kind
  episode: number
  consumerKeys: string[]
}

interface Model {
  rows: Record<string, MRow>
  dismissed: string[]
  policy: Record<Prov, boolean>
  hosts: Record<string, MHost>
  grants: Record<string, MGrant>
  recipes: Record<string, string>
  autoDisable: number
  autoEnable: number
  saved: SavedItem[]
  lastListing: Record<string, Listing>
}

interface Consumers {
  keys: string[]
  implicitHosts: string[]
  /** What the operator's reduction gate counts: explicit Hosts and grant `allowed_models`. */
  gate: boolean
  any: boolean
}

let hostNs = ''
let recipeNs = ''

function consumersOf(M: Model, pair: string): Consumers {
  const [p, m] = splitPair(pair)
  const keys = new Set<string>()
  const implicitHosts: string[] = []
  let gate = false
  for (const [name, h] of Object.entries(M.hosts)) {
    if (h.provider !== p) continue
    if (h.subset === null) implicitHosts.push(name)
    else if (h.subset.includes(m)) {
      keys.add(`host:${hostNs}/${name}`)
      gate = true
    }
  }
  // `allowed_models` is matched by name only, whatever the provider, as its
  // producer and the reduction gate do; a prompt target is matched by pair.
  for (const g of Object.values(M.grants)) {
    if (g.allowed.includes(m)) {
      keys.add(`grant:${g.id}`)
      gate = true
    }
    if (g.target.provider === p && g.target.model === m) keys.add(`grant:${g.id}`)
  }
  for (const [name, model] of Object.entries(M.recipes)) {
    if (model === m) keys.add(`recipe:${recipeNs}/${name}`)
  }
  return {
    keys: [...keys].sort(),
    implicitHosts: implicitHosts.sort(),
    gate,
    any: keys.size > 0 || implicitHosts.length > 0,
  }
}

function setStale(row: MRow, stale: boolean) {
  if (stale && !row.stale) {
    row.stale = true
    row.staleAge = 0
    row.staleEpisode += 1
  } else if (!stale) {
    row.stale = false
    row.staleAge = null
  }
}

function setDeprecated(row: MRow, deprecated: boolean) {
  if (deprecated && !row.deprecated) row.depEpisode += 1
  row.deprecated = deprecated
}

function newDiscoveryRow(enabled: boolean, deprecated: boolean): MRow {
  return {
    source: 'discovery',
    enabled,
    managedBy: 'catalog',
    token: false,
    stale: false,
    staleAge: null,
    staleEpisode: 0,
    deprecated,
    depEpisode: deprecated ? 1 : 0,
    ack: {},
  }
}

interface SyncSpec {
  source: 'live' | 'vendored' | 'implausible'
  listing: Record<string, Listing>
  reEnableCap: number
}

const isLive = (s: SyncSpec) => s.source !== 'vendored'
const isDecidable = (s: SyncSpec) => s.source === 'live'

interface ReconcileOutcome {
  reEnabled: number
  deferred: number
}

/** The reconciliation transaction, for the tracked pairs. */
function modelReconcile(M: Model, spec: SyncSpec): ReconcileOutcome {
  const live = isLive(spec)
  const canDecide = isDecidable(spec)
  const out = { reEnabled: 0, deferred: 0 }
  const capReached = () => out.reEnabled >= spec.reEnableCap
  const catalog = live ? catalogFor(spec.listing) : VENDORED
  for (const p of PROVIDER_IDS as readonly string[]) {
    if (!PROVS.includes(p as Prov)) continue
    const prov = p as Prov
    const listedIds = discovered(catalog, prov).map(d => d.model_id)
    const statusOf = (pair: string): 'ga' | 'deprecated' => {
      if (live) return spec.listing[pair] === 'deprecated' ? 'deprecated' : 'ga'
      return vendoredStatus(pair) === 'deprecated' ? 'deprecated' : 'ga'
    }
    const deferredInserts: string[] = []
    for (const id of listedIds) {
      const pair = pairOf(prov, id)
      if (!POOL_PAIRS.includes(pair)) continue
      const status = statusOf(pair)
      const row = M.rows[pair]
      if (row && row.source === 'discovery') {
        if (live) setDeprecated(row, status === 'deprecated')
        if (live && !row.token) setStale(row, false)
        if (row.token && live && canDecide) {
          const allowed = M.policy[prov] && status !== 'deprecated'
          if (allowed && capReached()) {
            out.deferred += 1
          } else if (!M.dismissed.includes(pair)) {
            row.enabled = allowed
            row.token = false
            setStale(row, false)
            if (allowed) {
              out.reEnabled += 1
              M.autoEnable += 1
            }
          }
        }
      } else if (!row) {
        if (M.policy[prov] && !canDecide) continue
        if (M.policy[prov] && canDecide && status !== 'deprecated') {
          deferredInserts.push(pair)
          continue
        }
        M.rows[pair] = newDiscoveryRow(false, status === 'deprecated')
      }
    }
    for (const pair of deferredInserts) {
      if (capReached()) continue
      const enabled = !M.dismissed.includes(pair)
      if (enabled) throw new Error(`model: an undismissed pool pair ${pair} has no row`)
      M.rows[pair] = newDiscoveryRow(false, false)
    }
    if (!canDecide) continue
    for (const pair of POOL_PAIRS) {
      const [rp, m] = splitPair(pair)
      const row = M.rows[pair]
      if (rp !== prov || !row || row.source !== 'discovery') continue
      if (!listedIds.includes(m)) setStale(row, true)
    }
  }
  return out
}

/** Pairs the prune may disable now. */
function pruneCandidates(M: Model): string[] {
  return Object.entries(M.rows)
    .filter(
      ([, r]) =>
        r.enabled &&
        r.source === 'discovery' &&
        r.managedBy === 'catalog' &&
        r.stale &&
        (r.staleAge ?? -1) >= PRUNABLE_AGE
    )
    .map(([pair]) => pair)
}

function applyPrune(M: Model, pairs: Iterable<string>) {
  for (const pair of pairs) {
    const row = M.rows[pair]!
    row.enabled = false
    row.token = true
    M.autoDisable += 1
  }
}

/** The prune of a sequential decidable run: every candidate nobody uses. */
function modelPrune(M: Model): string[] {
  const pruned = pruneCandidates(M).filter(pair => !consumersOf(M, pair).any)
  applyPrune(M, pruned)
  return pruned
}

function ackInForce(row: MRow, kind: Kind, episode: number, keys: string[]): boolean {
  const ack = row.ack[kind]
  return ack !== undefined && ack.episode === episode && keys.every(k => ack.keys.includes(k))
}

interface ModelFeedItem extends SavedItem {
  implicitHosts: string[]
  acknowledged: boolean
}

function modelFeed(M: Model, includeAcknowledged: boolean): ModelFeedItem[] {
  const items: ModelFeedItem[] = []
  for (const [pair, row] of Object.entries(M.rows)) {
    if (!row.enabled) continue
    const [p, m] = splitPair(pair)
    const c = consumersOf(M, pair)
    const push = (kind: Kind, episode: number) => {
      const acknowledged = ackInForce(row, kind, episode, c.keys)
      if (acknowledged && !includeAcknowledged) return
      items.push({
        provider: p,
        model: m,
        kind,
        episode,
        consumerKeys: c.keys,
        implicitHosts: c.implicitHosts,
        acknowledged,
      })
    }
    if (row.stale && c.any) push(STALE_KIND, row.staleEpisode)
    if (row.deprecated && c.keys.length > 0) push(DEPRECATED_KIND, row.depEpisode)
  }
  return items.sort((a, b) => feedOrder(a).localeCompare(feedOrder(b)))
}

const feedOrder = (i: { kind: string; provider: string; model: string }) =>
  `${i.kind}|${i.provider}|${i.model}`

const clone = <T>(x: T): T => structuredClone(x)

/** Entries by key: jsonb does not keep the insertion order of an object's keys. */
const sortedEntries = <V>(o: Partial<Record<string, V>>): Array<[string, V]> =>
  (Object.entries(o) as Array<[string, V]>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

// ── commands ─────────────────────────────────────────────────────────────────

type HostSpec =
  | { kind: 'subset'; provider: Prov; models: string[] }
  | { kind: 'all'; provider: Prov }
type PutBody =
  | { kind: 'enabled'; value: boolean; pin: boolean }
  | { kind: 'display' }
  | { kind: 'pinOnly' }
  | { kind: 'rename' }

type Op =
  | { t: 'host'; name: string; spec: HostSpec | null }
  | { t: 'grant'; name: string; write: { allowed: string[]; target: string } | null }
  | { t: 'recipe'; name: string; model: string | null }
  | { t: 'put'; pair: string; body: PutBody }
  | { t: 'delete'; pair: string }

type Cmd =
  | { t: 'sync'; spec: SyncSpec }
  | { t: 'tick'; hours: number }
  | { t: 'feed'; includeAcknowledged: boolean }
  | { t: 'ack'; index: number; dropKey: boolean }
  | { t: 'unack'; index: number }
  | { t: 'policy'; provider: Prov; value: boolean }
  | { t: 'op'; op: Op }
  | { t: 'opOnSaved'; op: SavedOp }
  | { t: 'race'; spec: SyncSpec; op: RaceOp }

/**
 * A race write whose target is picked when the race starts, among the prune's
 * candidates of that run (by index), so races land on the rows the prune is
 * deciding instead of on random ones.
 */
type CandidateOp =
  | { t: 'hostOnCandidate'; name: string; which: number }
  | { t: 'grantOnCandidate'; name: string; which: number }
  | { t: 'putOnCandidate'; which: number; body: PutBody }
type RaceOp = Op | CandidateOp

/**
 * A consumer write on a model the operator saw in an earlier feed (by index),
 * picked when the step runs: it is how an acknowledged item gains a consumer.
 */
type SavedOp = { via: 'host' | 'recipe' | 'grant'; name: string; which: number }

function resolveSavedOp(op: SavedOp, savedPairs: string[]): Op | null {
  const among =
    op.via === 'grant' ? savedPairs.filter(p => p.startsWith(`${GRANT_PROVIDER}/`)) : savedPairs
  if (among.length === 0) return null
  const [p, m] = splitPair(among[op.which % among.length]!)
  switch (op.via) {
    case 'host':
      return { t: 'host', name: op.name, spec: { kind: 'subset', provider: p, models: [m] } }
    case 'recipe':
      return { t: 'recipe', name: op.name, model: m }
    case 'grant':
      return { t: 'grant', name: op.name, write: { allowed: [], target: m } }
  }
}

function resolveRaceOp(op: RaceOp, candidates: string[]): Op {
  if (op.t !== 'hostOnCandidate' && op.t !== 'grantOnCandidate' && op.t !== 'putOnCandidate') {
    return op
  }
  const fallback = pairOf('openai', POOL.openai[0]!)
  const pick = (which: number, among: string[]) =>
    among.length > 0 ? among[which % among.length]! : fallback
  switch (op.t) {
    case 'hostOnCandidate': {
      const [p, m] = splitPair(pick(op.which, candidates))
      return { t: 'host', name: op.name, spec: { kind: 'subset', provider: p, models: [m] } }
    }
    case 'grantOnCandidate': {
      const openai = candidates.filter(c => c.startsWith(`${GRANT_PROVIDER}/`))
      const [, m] = splitPair(pick(op.which, openai))
      return { t: 'grant', name: op.name, write: { allowed: [], target: m } }
    }
    case 'putOnCandidate':
      return { t: 'put', pair: pick(op.which, candidates), body: op.body }
  }
}

const showRaceOp = (op: RaceOp): string =>
  op.t === 'hostOnCandidate' || op.t === 'grantOnCandidate' || op.t === 'putOnCandidate'
    ? `${op.t}#${op.which}${'name' in op ? ` ${op.name}` : ''}${'body' in op ? ` ${JSON.stringify(op.body)}` : ''}`
    : showOp(op)

/** Listing per pool pair; 'keep' repeats the previous sync's listing, 'back' lists it again if pruned. */
type ListingChoice = Listing | 'keep' | 'back'

interface RawSyncSpec {
  source: SyncSpec['source']
  listing: Record<string, ListingChoice>
  reEnableCap: number
}

function resolveSpec(M: Model, raw: RawSyncSpec): SyncSpec {
  const listing: Record<string, Listing> = {}
  for (const pair of POOL_PAIRS) {
    const choice = raw.listing[pair]!
    if (choice === 'back') {
      // A pruned model returns to the catalog; anything else keeps its listing.
      listing[pair] = M.rows[pair]?.token ? 'listed' : M.lastListing[pair]!
    } else listing[pair] = choice === 'keep' ? M.lastListing[pair]! : choice
  }
  return { source: raw.source, listing, reEnableCap: raw.reEnableCap }
}

const showSpec = (raw: RawSyncSpec) =>
  `${raw.source}{${POOL_PAIRS.map(p => `${p.split('/')[1]}:${raw.listing[p]}`).join(',')}}` +
  (raw.reEnableCap < UNCAPPED ? ` cap=${raw.reEnableCap}` : '')

const showOp = (op: Op): string => {
  switch (op.t) {
    case 'host':
      if (!op.spec) return `host ${op.name} delete`
      return op.spec.kind === 'all'
        ? `host ${op.name} all-models ${op.spec.provider}`
        : `host ${op.name} subset ${op.spec.provider}[${op.spec.models.join(',')}]`
    case 'grant':
      return op.write
        ? `grant ${op.name} allowed[${op.write.allowed.join(',')}] target ${op.write.target}`
        : `grant ${op.name} delete`
    case 'recipe':
      return op.model ? `recipe ${op.name} ${op.model}` : `recipe ${op.name} delete`
    case 'put':
      return `put ${op.pair} ${JSON.stringify(op.body)}`
    case 'delete':
      return `delete ${op.pair}`
  }
}

// ── the suite ────────────────────────────────────────────────────────────────

describeRealPostgres(
  'catalog prune, re-enable and attention against a reference model (real PostgreSQL)',
  () => {
    const database = `control_api_prune_model_${randomBytes(6).toString('hex')}`
    const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
    const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

    let adminPool: Pool
    let corePool: Pool
    let limiterPool: Pool
    let mod: {
      createApp: (gateway: unknown) => import('express').Express
      MockGateway: typeof import('./mockGateway.js').MockGateway
      config: typeof import('../src/config.js').config
      syncDiscoveredModels: typeof import('../src/services/llmCatalogSync.js').syncDiscoveredModels
      loadModelsDevCatalog: typeof import('../src/services/modelsDevClient.js').loadModelsDevCatalog
      setProviderAutoEnable: typeof import('../src/services/llmProviderCatalogSettings.js').setProviderAutoEnable
      catalogPruneFromGateway: typeof import('../src/services/llmCatalogPrune.js').catalogPruneFromGateway
      Writer: typeof import('../src/services/llmAllowedModelsConfigMap.js').LlmAllowedModelsConfigMapWriter
    }

    beforeAll(async () => {
      adminPool = new Pool({ connectionString: adminUrl })
      await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
      process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString
      const dbMod = await import('../src/db.js')
      corePool = dbMod.pool as unknown as Pool
      corePool.on('error', () => {})
      limiterPool = dbMod.rateLimitPool as unknown as Pool
      limiterPool.on('error', () => {})
      const migratePool = new Pool({ connectionString })
      await dbMod.initDb({ connect: () => migratePool.connect() })
      await endPoolAndWaitForClients(migratePool)
      const appMod = await import('../src/app.js')
      const configMod = await import('../src/config.js')
      const syncMod = await import('../src/services/llmCatalogSync.js')
      const clientMod = await import('../src/services/modelsDevClient.js')
      const policyMod = await import('../src/services/llmProviderCatalogSettings.js')
      const pruneMod = await import('../src/services/llmCatalogPrune.js')
      const cmMod = await import('../src/services/llmAllowedModelsConfigMap.js')
      const { MockGateway } = await import('./mockGateway.js')
      mod = {
        createApp: appMod.createApp as never,
        MockGateway,
        config: configMod.config,
        syncDiscoveredModels: syncMod.syncDiscoveredModels,
        loadModelsDevCatalog: clientMod.loadModelsDevCatalog,
        setProviderAutoEnable: policyMod.setProviderAutoEnable,
        catalogPruneFromGateway: pruneMod.catalogPruneFromGateway,
        Writer: cmMod.LlmAllowedModelsConfigMapWriter,
      }
      hostNs = mod.config.hostsNamespace
      recipeNs = mod.config.sandboxNamespace
      mockVerifyAdminToken.mockReturnValue(ADMIN_CLAIMS)
      mockIsAdminTokenRevoked.mockResolvedValue(false)
      mockFindAdminById.mockResolvedValue(ACTIVE_ADMIN)
    }, 60_000)

    afterAll(async () => {
      try {
        if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
        else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
        await endPoolAndWaitForClients(corePool).catch(() => {})
        await endPoolAndWaitForClients(limiterPool).catch(() => {})
        if (adminPool) {
          await adminPool.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [database]
          )
          await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
        }
      } finally {
        await adminPool?.end()
      }
    })

    // Per-run state, reset by `startRun`.
    const H = {
      s: null as fc.Scheduler | null,
      /** The run's scheduler; only a race step installs it as `s`. */
      runScheduler: null as fc.Scheduler | null,
      gateway: undefined as unknown as InstanceType<typeof import('./mockGateway.js').MockGateway>,
      cluster: undefined as unknown as FakeConfigMapApi,
      writer: undefined as unknown as InstanceType<
        typeof import('../src/services/llmAllowedModelsConfigMap.js').LlmAllowedModelsConfigMapWriter
      >,
      app: undefined as unknown as import('express').Express,
      M: undefined as unknown as Model,
      violations: [] as string[],
      raceOrder: [] as string[],
    }

    const violation = (message: string) => {
      H.violations.push(message)
    }

    const coverage: Record<string, number> = {}
    const reached = (what: string) => {
      coverage[what] = (coverage[what] ?? 0) + 1
    }

    async function gate(label: string): Promise<void> {
      const s = H.s
      if (!s) return
      H.raceOrder.push(`wait ${label}`)
      await s.schedule(Promise.resolve(label), label)
      H.raceOrder.push(`go ${label}`)
    }

    // ── producers ───────────────────────────────────────────────────────────────

    const vendoredLoader = () =>
      mod.loadModelsDevCatalog({
        fetchImpl: (async () => {
          throw new Error('models.dev unreachable')
        }) as never,
      })

    function realSync(spec: SyncSpec, prune: CatalogPrune | undefined): Promise<CatalogSyncResult> {
      return mod.syncDiscoveredModels(
        {
          materializer: H.writer,
          loadCatalog:
            spec.source === 'vendored'
              ? vendoredLoader
              : loadStub(catalogFor(spec.listing), 'live', LIVE_MODELS_DEV_CAPTURED_AT),
          minPlausibleLiveTotal: spec.source === 'implausible' ? 1_000_000 : 1,
          providerMinLive: 0,
          autoEnableMaxPerProviderPerRun: UNCAPPED,
          autoEnableMaxPerRun: spec.reEnableCap,
          ...(prune ? { prune } : {}),
        },
        corePool as unknown as SyncConnector
      )
    }

    const productionPrune = () =>
      mod.catalogPruneFromGateway(H.gateway, {
        graceMs: GRACE_MS,
        maxPerRun: PRUNE_MAX_PER_RUN,
        txPool: corePool,
        hooks: {
          beforeLock: c => gate(`prune:beforeLock ${c.model}`),
          beforeUpdate: c => gate(`prune:beforeUpdate ${c.model}`),
        },
      })

    const api = () => H.app

    async function rowIdOf(pair: string): Promise<string | null> {
      const [p, m] = splitPair(pair)
      const { rows } = await corePool.query<{ id: string }>(
        `SELECT id FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
        [p, m]
      )
      return rows[0]?.id ?? null
    }

    function hostBody(name: string, spec: HostSpec) {
      const anchor = ANCHOR[spec.provider]
      const model = { provider: spec.provider, name: anchor }
      if (spec.kind === 'all') return { metadata: { name }, spec: { model } }
      return {
        metadata: { name },
        spec: {
          model,
          allowedModels: [anchor, ...spec.models].map(m => ({ provider: spec.provider, model: m })),
        },
      }
    }

    function recipeBody(name: string, model: string) {
      return {
        metadata: { name },
        spec: {
          triggers: { onDemand: { allowedActors: ['user'] } },
          agent: { provider: 'openai', model },
          steps: [{ id: 's1', instruction: 'go' }],
        },
      }
    }

    function grantBody(name: string, write: { allowed: string[]; target: string }) {
      return {
        recipeNamespace: recipeNs,
        recipeName: name,
        capabilityFamily: 'promptBridge',
        provider: GRANT_PROVIDER,
        allowedModels: write.allowed,
        promptTargets: [
          {
            targetRef: 'primary',
            provider: GRANT_PROVIDER,
            model: write.target,
            credentialSlot: 'openai-api-key',
          },
        ],
        defaultTargetRef: 'primary',
        allowedCallers: ['api'],
      }
    }

    function putBody(pair: string, body: PutBody): Record<string, unknown> {
      const [, m] = splitPair(pair)
      switch (body.kind) {
        case 'enabled':
          return body.pin ? { enabled: body.value, pinEnabled: true } : { enabled: body.value }
        case 'display':
          return { display_name: `shown ${m}` }
        case 'pinOnly':
          return { pinEnabled: true }
        case 'rename':
          return { model: m + RENAMED_SUFFIX }
      }
    }

    /** Perform one operator or consumer write; answers its HTTP status. */
    async function performOp(op: Op): Promise<number> {
      const M = H.M
      switch (op.t) {
        case 'host': {
          const exists = op.name in M.hosts
          if (!op.spec) {
            if (!exists) return 204
            const res = await request(api()).delete(`${API}/hosts/${op.name}`).set('Cookie', COOKIE)
            return res.status
          }
          const body = hostBody(op.name, op.spec)
          const res = exists
            ? await request(api()).put(`${API}/hosts/${op.name}`).set('Cookie', COOKIE).send(body)
            : await request(api()).post(`${API}/hosts`).set('Cookie', COOKIE).send(body)
          return res.status
        }
        case 'grant': {
          const stored = M.grants[op.name]
          if (!op.write) {
            if (!stored) return 200
            const res = await request(api())
              .delete(`${API}/plugin-workload-sdk/grants/${stored.id}`)
              .query({ recipeNamespace: recipeNs, recipeName: op.name })
              .set('Cookie', COOKIE)
            return res.status
          }
          const res = await request(api())
            .post(`${API}/plugin-workload-sdk/grants`)
            .set('Cookie', COOKIE)
            .send(grantBody(op.name, op.write))
          return res.status
        }
        case 'recipe': {
          const exists = op.name in M.recipes
          if (op.model === null) {
            if (!exists) return 204
            const res = await request(api())
              .delete(`${API}/recipes/${op.name}`)
              .set('Cookie', COOKIE)
            return res.status
          }
          const body = recipeBody(op.name, op.model)
          const res = exists
            ? await request(api()).put(`${API}/recipes/${op.name}`).set('Cookie', COOKIE).send(body)
            : await request(api()).post(`${API}/recipes`).set('Cookie', COOKIE).send(body)
          return res.status
        }
        case 'put': {
          const id = await rowIdOf(op.pair)
          if (!id) return 404
          const res = await request(api())
            .put(`${API}/llm-models/${id}`)
            .set('Cookie', COOKIE)
            .send(putBody(op.pair, op.body))
          return res.status
        }
        case 'delete': {
          const id = await rowIdOf(op.pair)
          if (!id) return 404
          const res = await request(api()).delete(`${API}/llm-models/${id}`).set('Cookie', COOKIE)
          return res.status
        }
      }
    }

    const ok = (status: number) => status >= 200 && status < 300

    /**
     * What the model says about an op's status on state `M` (before the op), and
     * the model after it. `expect`: 'ok' / 'fail' / 'either' (when only rules the
     * model leaves out, like the editability tolerance of a stored disabled
     * reference, decide). `apply` mutates `M` as the op does when it succeeded.
     */
    function judgeOp(
      M: Model,
      op: Op
    ): { expect: 'ok' | 'fail' | 'either'; expectStatus?: number; apply: (M: Model) => void } {
      const enabledIn = (pair: string) =>
        PROVS.some(p => pair === pairOf(p, ANCHOR[p])) || M.rows[pair]?.enabled === true
      switch (op.t) {
        case 'host': {
          if (!op.spec) return { expect: 'ok', apply: M2 => void delete M2.hosts[op.name] }
          const spec = op.spec
          const stored = M.hosts[op.name]
          const before =
            stored && stored.provider === spec.provider && stored.subset ? stored.subset : []
          const models = spec.kind === 'subset' ? spec.models : []
          const added = models.filter(m => !before.includes(m))
          const expectWhat = added.some(m => !enabledIn(pairOf(spec.provider, m)))
            ? 'fail'
            : models.every(m => enabledIn(pairOf(spec.provider, m)))
              ? 'ok'
              : 'either'
          return {
            expect: expectWhat,
            apply: M2 => {
              M2.hosts[op.name] = {
                provider: spec.provider,
                subset: spec.kind === 'subset' ? [...spec.models] : null,
              }
            },
          }
        }
        case 'grant': {
          if (!op.write) return { expect: 'ok', apply: M2 => void delete M2.grants[op.name] }
          const write = op.write
          const stored = M.grants[op.name]
          const target = pairOf(GRANT_PROVIDER, write.target)
          const expectWhat = enabledIn(target)
            ? 'ok'
            : stored?.target.model === write.target
              ? 'either'
              : 'fail'
          return {
            expect: expectWhat,
            apply: M2 => {
              M2.grants[op.name] = {
                id: '',
                allowed: [...write.allowed],
                target: { provider: GRANT_PROVIDER, model: write.target },
              }
            },
          }
        }
        case 'recipe':
          return {
            expect: 'ok',
            apply: M2 => {
              if (op.model === null) delete M2.recipes[op.name]
              else M2.recipes[op.name] = op.model
            },
          }
        case 'put': {
          const row = M.rows[op.pair]
          if (!row) return { expect: 'fail', expectStatus: 404, apply: () => {} }
          const body = op.body
          if (body.kind === 'pinOnly') return { expect: 'fail', expectStatus: 400, apply: () => {} }
          const renamed = body.kind === 'rename'
          const disables = body.kind === 'enabled' && !body.value
          if (row.enabled && (disables || renamed) && consumersOf(M, op.pair).gate) {
            return { expect: 'fail', expectStatus: 409, apply: () => {} }
          }
          if (renamed && M.rows[op.pair + RENAMED_SUFFIX]) {
            return { expect: 'fail', expectStatus: 409, apply: () => {} }
          }
          return {
            expect: 'ok',
            expectStatus: 200,
            apply: M2 => {
              const r = M2.rows[op.pair]!
              if (body.kind === 'enabled') {
                if (body.value !== r.enabled || body.pin) {
                  r.managedBy = 'operator'
                  r.token = false
                }
                r.enabled = body.value
              }
              if (renamed) {
                delete M2.rows[op.pair]
                r.managedBy = 'operator'
                r.token = false
                r.ack = {}
                r.source = 'manual'
                setStale(r, false)
                r.deprecated = false
                M2.rows[op.pair + RENAMED_SUFFIX] = r
                if (!M2.dismissed.includes(op.pair)) M2.dismissed.push(op.pair)
              }
            },
          }
        }
        case 'delete': {
          const row = M.rows[op.pair]
          if (!row) return { expect: 'fail', expectStatus: 404, apply: () => {} }
          if (consumersOf(M, op.pair).gate)
            return { expect: 'fail', expectStatus: 409, apply: () => {} }
          return {
            expect: 'ok',
            expectStatus: 204,
            apply: M2 => {
              delete M2.rows[op.pair]
              if (!M2.dismissed.includes(op.pair)) M2.dismissed.push(op.pair)
            },
          }
        }
      }
    }

    function statusMatches(j: ReturnType<typeof judgeOp>, status: number): string | null {
      if (j.expectStatus !== undefined && status !== j.expectStatus) {
        return `status ${status}, model expects ${j.expectStatus}`
      }
      if (j.expect === 'ok' && !ok(status)) return `status ${status}, model expects success`
      if (j.expect === 'fail' && ok(status)) return `status ${status}, model expects a rejection`
      return null
    }

    /** Grant ids are the producer's: read them back after a successful upsert. */
    async function fillGrantIds(M: Model) {
      for (const [name, g] of Object.entries(M.grants)) {
        if (g.id) continue
        const { rows } = await corePool.query<{ id: string }>(
          `SELECT id FROM plugin_workload_sdk_grants WHERE recipe_name = $1`,
          [name]
        )
        if (!rows[0]) violation(`grant ${name} succeeded but has no row`)
        else g.id = rows[0].id
      }
    }

    // ── observation ─────────────────────────────────────────────────────────────

    interface DbRow {
      id: string
      provider: string
      model: string
      source: string
      enabled: boolean
      managed: string
      token: boolean
      stale: boolean
      age: number | null
      stale_episode: number
      stale_since_ms: number | null
      dep: boolean
      dep_episode: number
      ack: Record<string, { episode: number; consumerKeys: string[] }> | null
    }

    async function allRows(): Promise<DbRow[]> {
      const { rows } = await corePool.query<DbRow>(
        `SELECT id, provider, model, source, enabled, enabled_managed_by AS managed,
              auto_disabled_at IS NOT NULL AS token, stale,
              CASE WHEN stale_since IS NULL THEN NULL
                   ELSE floor(extract(epoch FROM (now() - stale_since)) / 3600)::int END AS age,
              CASE WHEN stale_since IS NULL THEN NULL
                   ELSE (extract(epoch FROM stale_since) * 1000)::float8 END AS stale_since_ms,
              stale_episode, (catalog_status = 'deprecated') IS TRUE AS dep,
              deprecated_episode AS dep_episode, attention_ack AS ack
         FROM llm_allowed_models`
      )
      return rows
    }

    function published(): Set<string> {
      const out = new Set<string>()
      for (const [provider, json] of Object.entries(H.cluster.data ?? {})) {
        if (provider.includes('.') || provider.includes('/')) continue
        for (const entry of JSON.parse(json) as Array<{ model: string }>) {
          out.add(pairOf(provider, entry.model))
        }
      }
      return out
    }

    async function auditCount(action: string): Promise<number> {
      const { rows } = await corePool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM llm_allowed_models_audit WHERE action = $1`,
        [action]
      )
      return rows[0]!.n
    }

    /** Every difference between Postgres / the ConfigMap / the audit and model `M`. */
    async function diffAgainst(M: Model): Promise<string[]> {
      const out: string[] = []
      const rows = await allRows()
      const byPair = new Map(rows.map(r => [pairOf(r.provider, r.model), r]))
      for (const pair of TRACKED_PAIRS) {
        const m = M.rows[pair]
        const d = byPair.get(pair)
        if (!m && !d) continue
        if (!m || !d) {
          out.push(
            `${pair}: model ${m ? 'has' : 'lacks'} the row, Postgres ${d ? 'has' : 'lacks'} it`
          )
          continue
        }
        const expected = {
          source: m.source,
          enabled: m.enabled,
          managed: m.managedBy,
          token: m.token,
          stale: m.stale,
          age: m.staleAge,
          stale_episode: m.staleEpisode,
          dep: m.deprecated,
          dep_episode: m.depEpisode,
          ack: Object.fromEntries(
            sortedEntries(m.ack).map(([k, a]) => [
              k,
              { episode: a.episode, keys: [...a.keys].sort() },
            ])
          ),
        }
        const actual = {
          source: d.source,
          enabled: d.enabled,
          managed: d.managed,
          token: d.token,
          stale: d.stale,
          age: d.age,
          stale_episode: d.stale_episode,
          dep: d.dep,
          dep_episode: d.dep_episode,
          ack: Object.fromEntries(
            sortedEntries(d.ack ?? {}).map(([k, a]) => [
              k,
              { episode: a.episode, keys: [...a.consumerKeys].sort() },
            ])
          ),
        }
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          out.push(
            `${pair}: model ${JSON.stringify(expected)} ≠ Postgres ${JSON.stringify(actual)}`
          )
        }
      }
      // The published ConfigMap is exactly the enabled catalog-provider rows.
      const cm = published()
      for (const pair of TRACKED_PAIRS) {
        const enabled = M.rows[pair]?.enabled === true
        if (cm.has(pair) !== enabled) {
          out.push(
            `${pair}: ConfigMap ${cm.has(pair) ? 'serves' : 'omits'} it, model enabled=${enabled}`
          )
        }
      }
      for (const r of rows) {
        if (!PROVS.includes(r.provider as Prov)) continue
        if (cm.has(pairOf(r.provider, r.model)) !== r.enabled) {
          out.push(
            `${r.provider}/${r.model}: ConfigMap and Postgres disagree on enabled=${r.enabled}`
          )
        }
      }
      const disables = await auditCount('auto_disable')
      const enables = await auditCount('auto_enable')
      if (disables !== M.autoDisable)
        out.push(`auto_disable audits ${disables}, model ${M.autoDisable}`)
      if (enables !== M.autoEnable) out.push(`auto_enable audits ${enables}, model ${M.autoEnable}`)
      return out
    }

    async function checkAgainstModel(context: string) {
      for (const d of await diffAgainst(H.M)) violation(`${context}: ${d}`)
    }

    /** The prune token lives only on a row the prune may still own. */
    async function checkTokenPredicate(context: string) {
      for (const r of await allRows()) {
        if (!r.token) continue
        if (r.enabled || r.source !== 'discovery' || !r.stale || r.managed !== 'catalog') {
          violation(
            `${context}: ${r.provider}/${r.model} carries the prune token in ${JSON.stringify(r)}`
          )
        }
      }
    }

    /**
     * The sync invariants, on Postgres alone, around one sequential sync:
     * operator and manual rows keep `enabled`; only stale rows outside the grace
     * and without consumers lose it; only token rows gain it; a non-live run
     * leaves `stale` alone; a decidable run leaves nothing to prune and decides
     * every token row it lists.
     */
    function checkSyncTransition(
      before: DbRow[],
      after: DbRow[],
      spec: SyncSpec,
      M: Model,
      pruneAborted: boolean
    ) {
      const afterById = new Map(after.map(r => [r.id, r]))
      for (const b of before) {
        const a = afterById.get(b.id)
        if (!a) {
          violation(`sync removed ${b.provider}/${b.model}`)
          continue
        }
        const tag = `${b.provider}/${b.model}`
        if (b.enabled !== a.enabled && b.managed === 'operator') {
          violation(`sync changed enabled of operator row ${tag}`)
        }
        if (b.enabled !== a.enabled && b.source === 'manual') {
          violation(`sync changed enabled of manual row ${tag}`)
        }
        if (b.enabled && !a.enabled) {
          if (!a.stale) violation(`sync disabled the non-stale row ${tag}`)
          if (b.age === null || b.age < PRUNABLE_AGE)
            violation(`sync disabled ${tag} inside the grace`)
          if (
            POOL_PAIRS.includes(pairOf(b.provider, b.model)) &&
            consumersOf(M, pairOf(b.provider, b.model)).any
          ) {
            violation(`sync disabled ${tag}, which has consumers`)
          }
        }
        if (!b.enabled && a.enabled && !b.token) {
          violation(`sync enabled ${tag}, which had no prune token`)
        }
        if (!isLive(spec)) {
          if (
            a.stale !== b.stale ||
            a.stale_episode !== b.stale_episode ||
            a.stale_since_ms !== b.stale_since_ms
          ) {
            violation(`a ${spec.source} run changed stale / stale_since / stale_episode of ${tag}`)
          }
        }
        const pair = pairOf(b.provider, b.model)
        if (
          isDecidable(spec) &&
          b.token &&
          POOL_PAIRS.includes(pair) &&
          spec.listing[pair] !== 'gone'
        ) {
          const [p] = splitPair(pair)
          const allowed = M.policy[p] && spec.listing[pair] !== 'deprecated'
          if (allowed && spec.reEnableCap >= UNCAPPED && !a.enabled) {
            violation(`${tag} came back, eligible with the policy on, and stayed disabled`)
          }
          if (!allowed && (a.token || a.enabled)) {
            violation(`${tag} came back refused by the policy or eligibility and kept its token`)
          }
        }
      }
      if (isDecidable(spec) && !pruneAborted) {
        for (const a of after) {
          const pair = pairOf(a.provider, a.model)
          if (
            a.enabled &&
            a.managed === 'catalog' &&
            a.stale &&
            a.source === 'discovery' &&
            (a.age ?? -1) >= PRUNABLE_AGE &&
            !(POOL_PAIRS.includes(pair) && consumersOf(M, pair).any)
          ) {
            violation(
              `${pair} is left enabled, stale outside the grace and unused after a decidable run`
            )
          }
        }
      }
    }

    // ── feed ────────────────────────────────────────────────────────────────────

    interface WireItem {
      kind: string
      provider: string
      model: string
      episode: number
      consumerKeys: string[]
      hostsAffected: Array<{ name: string; roles: string[] }>
      acknowledged?: boolean
    }

    async function readFeed(includeAcknowledged: boolean): Promise<WireItem[] | null> {
      const res = await request(api())
        .get(`${API}/attention${includeAcknowledged ? '?includeAcknowledged=1' : ''}`)
        .set('Cookie', COOKIE)
      if (res.status !== 200) {
        violation(`feed answered ${res.status}: ${JSON.stringify(res.body)}`)
        return null
      }
      return res.body.items as WireItem[]
    }

    async function checkFeed(includeAcknowledged: boolean, save: boolean) {
      const items = await readFeed(includeAcknowledged)
      if (!items) return
      const expected = modelFeed(H.M, includeAcknowledged).map(i => ({
        kind: i.kind,
        provider: i.provider,
        model: i.model,
        episode: i.episode,
        consumerKeys: i.consumerKeys,
        implicitHosts: i.implicitHosts,
        acknowledged: i.acknowledged,
      }))
      const actual = items
        .map(i => ({
          kind: i.kind,
          provider: i.provider,
          model: i.model,
          episode: i.episode,
          consumerKeys: [...i.consumerKeys].sort(),
          implicitHosts: i.hostsAffected
            .filter(h => h.roles.includes('implicit'))
            .map(h => h.name)
            .sort(),
          acknowledged: i.acknowledged === true,
        }))
        .sort((a, b) => feedOrder(a).localeCompare(feedOrder(b)))
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        violation(
          `feed${includeAcknowledged ? ' (with acknowledged)' : ''}: ${JSON.stringify(actual)} ≠ model ${JSON.stringify(expected)}`
        )
      }
      for (const i of actual) {
        if (i.acknowledged) reached('feed listed an acknowledged item')
        if (i.implicitHosts.length > 0) reached('feed listed an all-models Host')
        if (i.kind === DEPRECATED_KIND) reached('feed listed a deprecated model')
      }
      for (const [pair, row] of Object.entries(H.M.rows)) {
        const c = consumersOf(H.M, pair)
        if (row.enabled && row.deprecated && !c.keys.length && c.implicitHosts.length) {
          reached('deprecated model with only an all-models Host left out')
        }
      }
      if (save) {
        for (const i of actual) {
          H.M.saved.push({
            provider: i.provider,
            model: i.model,
            kind: i.kind as Kind,
            episode: i.episode,
            consumerKeys: i.consumerKeys,
          })
        }
        H.M.saved = H.M.saved.slice(-8)
      }
    }

    // ── command execution ───────────────────────────────────────────────────────

    async function runSequentialSync(spec: SyncSpec) {
      const M = H.M
      const before = await allRows()
      const stillAcked = (pair: string) => KINDS.some(k => M.rows[pair]?.ack[k])
      const ackedBefore = POOL_PAIRS.filter(stillAcked)
      const out = modelReconcile(M, spec)
      const pruned = isDecidable(spec) ? modelPrune(M) : []
      M.lastListing = { ...spec.listing }
      let result: CatalogSyncResult
      try {
        result = await realSync(spec, productionPrune())
      } catch (err) {
        violation(`sync threw: ${(err as Error).stack ?? String(err)}`)
        return
      }
      const expectedResult = {
        decidable: isDecidable(spec),
        reEnabled: out.reEnabled,
        reEnableDeferredByCap: out.deferred,
        pruned: pruned.length,
        pruneAborted: false,
      }
      const actualResult = {
        decidable: result.decidable,
        reEnabled: result.reEnabled,
        reEnableDeferredByCap: result.reEnableDeferredByCap,
        pruned: result.pruned,
        pruneAborted: result.pruneAborted,
      }
      if (JSON.stringify(actualResult) !== JSON.stringify(expectedResult)) {
        violation(
          `sync result ${JSON.stringify(actualResult)} ≠ model ${JSON.stringify(expectedResult)}`
        )
      }
      const after = await allRows()
      checkSyncTransition(before, after, spec, M, result.pruneAborted === true)
      if (pruned.length > 0) reached('pruned')
      if (out.reEnabled > 0) reached('re-enabled')
      if (out.deferred > 0) reached('re-enable deferred by the cap')
      for (const b of before) {
        const a = after.find(r => r.id === b.id)
        if (b.token && a && !a.token && !a.enabled)
          reached('token dropped by policy or eligibility')
        const listedByVendored =
          POOL_PAIRS.includes(pairOf(b.provider, b.model)) &&
          vendoredStatus(pairOf(b.provider, b.model)) !== 'absent'
        if (spec.source === 'vendored' && b.stale && a?.stale && listedByVendored) {
          reached('vendored run over a stale pool model')
        }
      }
      for (const pair of ackedBefore) {
        const row = M.rows[pair]
        if (
          row &&
          KINDS.some(
            k =>
              row.ack[k] &&
              row.ack[k]!.episode !== (k === STALE_KIND ? row.staleEpisode : row.depEpisode)
          )
        ) {
          reached('acknowledgement outlived by a new episode')
        }
      }
    }

    async function runOp(op: Op) {
      const M = H.M
      const j = judgeOp(M, op)
      const keysBefore = Object.fromEntries(POOL_PAIRS.map(p => [p, consumersOf(M, p).keys]))
      const status = await performOp(op)
      const mismatch = statusMatches(j, status)
      if (mismatch) violation(`${showOp(op)}: ${mismatch}`)
      if (ok(status)) {
        j.apply(M)
        await fillGrantIds(M)
      }
      if (op.t === 'put' && op.body.kind === 'rename' && ok(status)) reached('renamed')
      if (op.t === 'put' && op.body.kind === 'enabled' && op.body.pin && ok(status))
        reached('pinned')
      // A new explicit consumer after an acknowledgement reopens the item.
      for (const pair of POOL_PAIRS) {
        const row = M.rows[pair]
        if (!row) continue
        const added = consumersOf(M, pair).keys.filter(k => !keysBefore[pair]!.includes(k))
        if (
          added.length &&
          KINDS.some(k => row.ack[k] && added.some(a => !row.ack[k]!.keys.includes(a)))
        ) {
          reached('acknowledged item gained an explicit consumer')
        }
      }
    }

    async function runAck(index: number, dropKey: boolean) {
      const M = H.M
      if (M.saved.length === 0) return
      const item = M.saved[index % M.saved.length]!
      const keys = dropKey ? item.consumerKeys.slice(1) : item.consumerKeys
      const pair = pairOf(item.provider, item.model)
      const row = M.rows[pair]
      const current = row ? (item.kind === STALE_KIND ? row.staleEpisode : row.depEpisode) : -1
      const accepted = row !== undefined && row.enabled && current === item.episode
      const res = await request(api()).post(`${API}/attention/ack`).set('Cookie', COOKIE).send({
        provider: item.provider,
        model: item.model,
        kind: item.kind,
        episode: item.episode,
        consumerKeys: keys,
      })
      const expected = accepted ? 200 : 409
      if (res.status !== expected) {
        violation(
          `ack ${pair} ${item.kind} ep=${item.episode}: status ${res.status}, model expects ${expected}`
        )
        return
      }
      if (accepted) {
        row!.ack[item.kind] = { episode: item.episode, keys: [...keys] }
        reached('acknowledged')
      } else reached('acknowledgement refused as outdated')
    }

    async function runUnack(index: number) {
      const M = H.M
      if (M.saved.length === 0) return
      const { provider: p, model: m, kind } = M.saved[index % M.saved.length]!
      const pair = pairOf(p, m)
      const res = await request(api())
        .delete(`${API}/attention/ack`)
        .set('Cookie', COOKIE)
        .send({ provider: p, model: m, kind })
      if (res.status !== 204) violation(`unack ${pair} ${kind}: status ${res.status}`)
      const row = H.M.rows[pair]
      if (row?.ack[kind]) reached('acknowledgement undone')
      if (row) delete row.ack[kind]
    }

    async function runPolicy(provider: Prov, value: boolean) {
      const res = await request(api())
        .put(`${API}/llm-providers/${provider}/catalog-policy`)
        .set('Cookie', COOKIE)
        .send({ auto_enable: value })
      if (res.status !== 200) {
        violation(`policy ${provider}=${value}: status ${res.status}`)
        return
      }
      H.M.policy[provider] = value
    }

    async function runTick(hours: number) {
      await corePool.query(
        `UPDATE llm_allowed_models
          SET stale_since = stale_since - ($1::int * INTERVAL '1 hour')
        WHERE stale_since IS NOT NULL`,
        [hours]
      )
      for (const row of Object.values(H.M.rows)) {
        if (row.staleAge !== null) row.staleAge += hours
      }
    }

    /**
     * A live sync whose prune races one write. The reconciliation and the first
     * publication run alone (the write starts from inside the prune); then the
     * scheduler orders the write against the pre-filter, each candidate's lock and
     * its re-check.
     */
    async function runRace(spec: SyncSpec, raceOp: RaceOp) {
      const s = H.s!
      const M0 = H.M
      const M1 = clone(M0)
      const out = modelReconcile(M1, spec)
      M1.lastListing = { ...spec.listing }
      const candidates = pruneCandidates(M1)
      const op = resolveRaceOp(raceOp, candidates)
      const consumersBefore = Object.fromEntries(candidates.map(c => [c, consumersOf(M1, c).any]))

      H.raceOrder = [`write: ${showOp(op)}`, `candidates: ${candidates.join(', ') || '(none)'}`]
      let opStatus = -1
      let opPromise: Promise<void> = Promise.resolve()
      const prune = productionPrune()
      const racingPrune: CatalogPrune = run => {
        opPromise = (async () => {
          await gate(`op:start ${showOp(op)}`)
          opStatus = await performOp(op)
          H.raceOrder.push(`op:done ${opStatus}`)
        })().catch(err => violation(`${showOp(op)} threw: ${(err as Error).stack ?? String(err)}`))
        return prune(run)
      }
      let result: CatalogSyncResult | undefined
      try {
        result = await s.waitFor(realSync(spec, racingPrune))
      } catch (err) {
        violation(`race sync threw: ${(err as Error).stack ?? String(err)}`)
      }
      await s.waitFor(opPromise)
      await s.waitIdle()
      if (!result) return

      const rows = await allRows()
      const token = new Set(rows.filter(r => r.token).map(r => pairOf(r.provider, r.model)))
      const prunedNow = candidates.filter(c => token.has(c) && !M1.rows[c]!.token)
      for (const pair of POOL_PAIRS) {
        if (token.has(pair) && !M1.rows[pair]?.token && !candidates.includes(pair)) {
          violation(`race: ${pair} was pruned without being a candidate`)
        }
      }

      // Explanations of the outcome, one per serialization the model accepts.
      const explanations: Array<{ label: string; M: Model; pruned: string[] }> = []
      const opIsOnRow = op.t === 'put' || op.t === 'delete'
      if (opIsOnRow) {
        // The write and the prune of its row are serialized by the row; every
        // other candidate is decided as in a sequential run.
        for (const order of ['prune-first', 'write-first'] as const) {
          const M = clone(M1)
          let pruned: string[] = []
          if (order === 'prune-first') pruned = modelPrune(M)
          const j = judgeOp(M, op)
          if (statusMatches(j, opStatus) !== null) continue
          if (ok(opStatus)) j.apply(M)
          if (order === 'write-first') pruned = modelPrune(M)
          explanations.push({ label: order, M, pruned })
        }
      } else {
        // Consumer writes: a candidate the write did not touch is decided as in a
        // sequential run; one whose consumers it changed may fall on either side.
        // The write's own validation may have read the rows before or after the
        // prunes that did happen.
        const M = clone(M1)
        const j = judgeOp(M1, op)
        const afterPrunes = clone(M1)
        applyPrune(afterPrunes, prunedNow)
        const mismatch = statusMatches(j, opStatus)
        if (mismatch && statusMatches(judgeOp(afterPrunes, op), opStatus) !== null) {
          violation(`race ${showOp(op)}: ${mismatch}`)
        }
        if (ok(opStatus)) {
          j.apply(M)
          await fillGrantIds(M)
        }
        let explained = true
        for (const c of candidates) {
          const usedBefore = consumersBefore[c]!
          const usedAfter = consumersOf(M, c).any
          const pruned = prunedNow.includes(c)
          if (!usedBefore && !usedAfter && !pruned) {
            violation(`race: ${c} was unused on both sides of the write and not pruned`)
            explained = false
          }
          if (usedBefore && usedAfter && pruned) {
            violation(`race: ${c} was used on both sides of the write and pruned`)
            explained = false
          }
          if (usedBefore !== usedAfter) reached('race: candidate whose consumers the write changed')
        }
        // A validated reference the write added and committed must not be pruned.
        if (ok(opStatus) && (op.t === 'host' || op.t === 'grant')) {
          for (const c of prunedNow) {
            if (!consumersOf(M1, c).any && consumersOf(M, c).any) {
              if ((op.t === 'host' && op.spec?.kind === 'subset') || op.t === 'grant') {
                const [p, m] = splitPair(c)
                const named =
                  op.t === 'host'
                    ? op.spec?.kind === 'subset' &&
                      op.spec.provider === p &&
                      op.spec.models.includes(m)
                    : p === GRANT_PROVIDER && op.write?.target === m
                if (named) {
                  violation(
                    `race: ${showOp(op)} committed a validated reference to ${c}, which the prune disabled`
                  )
                  explained = false
                }
              }
            }
          }
        }
        if (explained) {
          applyPrune(M, prunedNow)
          explanations.push({ label: 'interleaved', M, pruned: prunedNow })
        }
      }

      let chosen: { label: string; M: Model; pruned: string[] } | undefined
      const diffs: string[] = []
      for (const e of explanations) {
        const d = await diffAgainst(e.M)
        if (d.length === 0 && result.pruned === e.pruned.length) {
          chosen = e
          break
        }
        diffs.push(
          `${e.label}: ${[...d, `pruned ${result.pruned} vs ${e.pruned.length}`].join('; ')}`
        )
      }
      if (!chosen) {
        violation(
          `race ${showOp(op)}: no serialization explains the outcome (status ${opStatus})\n    ${diffs.join('\n    ')}`
        )
        return
      }
      if (result.reEnabled !== out.reEnabled || result.pruneAborted) {
        violation(`race sync result ${JSON.stringify(result)} ≠ model reEnabled=${out.reEnabled}`)
      }
      H.M = chosen.M
      reached(`race explained (${chosen.label})`)
      if (out.reEnabled > 0) reached('re-enabled')
      if (out.deferred > 0) reached('re-enable deferred by the cap')
      for (const [pair, before] of Object.entries(M0.rows)) {
        const after = M1.rows[pair]
        if (before.token && after && !after.token && !after.enabled) {
          reached('token dropped by policy or eligibility')
        }
      }
      if (chosen.pruned.length > 0) reached('race pruned')
    }

    async function exec(cmd: Cmd) {
      switch (cmd.t) {
        case 'sync':
          return runSequentialSync(cmd.spec)
        case 'tick':
          return runTick(cmd.hours)
        case 'feed':
          return checkFeed(cmd.includeAcknowledged, true)
        case 'ack':
          return runAck(cmd.index, cmd.dropKey)
        case 'unack':
          return runUnack(cmd.index)
        case 'policy':
          return runPolicy(cmd.provider, cmd.value)
        case 'op':
          return runOp(cmd.op)
        case 'opOnSaved': {
          const pairs = [...new Set(H.M.saved.map(i => pairOf(i.provider, i.model)))].filter(pair =>
            POOL_PAIRS.includes(pair)
          )
          const op = resolveSavedOp(cmd.op, pairs)
          return op ? runOp(op) : undefined
        }
        case 'race':
          return runRace(cmd.spec, cmd.op)
      }
    }

    // ── run lifecycle ───────────────────────────────────────────────────────────

    async function startRun() {
      H.violations = []
      await corePool.query(`
      DELETE FROM plugin_workload_sdk_grants;
      DELETE FROM llm_allowed_models;
      DELETE FROM llm_allowed_models_audit;
      DELETE FROM llm_catalog_dismissed;
      DELETE FROM llm_model_prices;
      DELETE FROM llm_provider_catalog_settings;
      DELETE FROM llm_catalog_sync_runs;
      DELETE FROM llm_catalog_prune_runs;
    `)
      const gateway = new mod.MockGateway()
      const rawList = gateway.listResource.bind(gateway)
      gateway.listResource = async (plural, namespace) => {
        await gate(`list:${plural}`)
        return rawList(plural, namespace)
      }
      H.gateway = gateway
      H.cluster = new FakeConfigMapApi()
      H.writer = new mod.Writer(H.cluster as never, 'mcp-host', 3, corePool)
      gateway.setLlmAllowedModelsConfigMapMaterialize(() => H.writer.materialize())
      H.app = mod.createApp(gateway)
      for (const p of PROVS) await mod.setProviderAutoEnable(p, true, 'test-admin', corePool)
      const listing = Object.fromEntries(POOL_PAIRS.map(p => [p, 'listed' as Listing]))
      H.M = {
        rows: {},
        dismissed: [],
        policy: { openai: true, claude: true },
        hosts: {},
        grants: {},
        recipes: {},
        autoDisable: 0,
        autoEnable: 0,
        saved: [],
        lastListing: listing,
      }
      for (const pair of POOL_PAIRS) H.M.rows[pair] = newDiscoveryRow(true, false)
      await realSync({ source: 'live', listing, reEnableCap: UNCAPPED }, undefined)
      // The recipes the grants belong to: a grant delete republishes the recipe's
      // grant identity, which needs the recipe. They name only the anchor, which
      // no step tracks.
      for (const name of GRANT_RECIPES) {
        const res = await request(api())
          .post(`${API}/recipes`)
          .set('Cookie', COOKIE)
          .send(recipeBody(name, ANCHOR.openai))
        if (res.status !== 201)
          violation(`setup recipe ${name}: ${res.status} ${JSON.stringify(res.body)}`)
      }
      await checkAgainstModel('setup')
    }

    async function checkAtRest(context: string) {
      await checkAgainstModel(context)
      await checkTokenPredicate(context)
    }

    // ── generators ──────────────────────────────────────────────────────────────

    const listingChoice = fc.constantFrom<ListingChoice>(
      'back',
      'back',
      'keep',
      'keep',
      'keep',
      'keep',
      'keep',
      'gone',
      'gone',
      'gone',
      'listed',
      'listed',
      'deprecated'
    )
    const rawSpec = (sources: SyncSpec['source'][]): fc.Arbitrary<RawSyncSpec> =>
      fc.record({
        source: fc.constantFrom(...sources),
        listing: fc.record(
          Object.fromEntries(POOL_PAIRS.map(p => [p, listingChoice]))
        ) as fc.Arbitrary<Record<string, ListingChoice>>,
        reEnableCap: fc.constantFrom(UNCAPPED, UNCAPPED, 1, 0),
      })

    const provider = fc.constantFrom<Prov>('openai', 'openai', 'claude')
    const anyTracked = fc.constantFrom(
      ...POOL_PAIRS,
      ...POOL_PAIRS,
      ...POOL_PAIRS.map(p => p + RENAMED_SUFFIX)
    )
    const openaiNames = [...POOL.openai, ANCHOR.openai]
    const allNames = [...POOL.openai, ...POOL.claude, ANCHOR.openai]

    const hostOp: fc.Arbitrary<Op> = fc
      .tuple(
        fc.constantFrom('h1', 'h2'),
        fc.oneof(
          {
            weight: 4,
            arbitrary: provider.chain(p =>
              fc
                .subarray(POOL[p], { minLength: 1 })
                .map(models => ({ kind: 'subset' as const, provider: p, models }))
            ),
          },
          { weight: 1, arbitrary: provider.map(p => ({ kind: 'all' as const, provider: p })) },
          { weight: 2, arbitrary: fc.constant(null) }
        )
      )
      .map(([name, spec]) => ({ t: 'host' as const, name, spec: spec as HostSpec | null }))
    const grantOp: fc.Arbitrary<Op> = fc
      .tuple(
        fc.constantFrom(...GRANT_RECIPES),
        fc.oneof(
          {
            weight: 4,
            arbitrary: fc.record({
              allowed: fc.subarray(openaiNames),
              target: fc.constantFrom(...openaiNames),
            }),
          },
          { weight: 1, arbitrary: fc.constant(null) }
        )
      )
      .map(([name, write]) => ({ t: 'grant' as const, name, write }))
    const recipeOp: fc.Arbitrary<Op> = fc
      .tuple(
        fc.constantFrom('r1', 'r2'),
        fc.oneof(
          { weight: 4, arbitrary: fc.constantFrom(...allNames) },
          { weight: 1, arbitrary: fc.constant(null) }
        )
      )
      .map(([name, model]) => ({ t: 'recipe' as const, name, model }))
    // Only a pool pair is renamed: the renamed pair is tracked, a second rename
    // would leave the tracked set.
    const putOp: fc.Arbitrary<Op> = anyTracked.chain(pair => {
      const bodies: Array<fc.WeightedArbitrary<PutBody>> = [
        {
          weight: 6,
          arbitrary: fc.record({
            kind: fc.constant('enabled' as const),
            value: fc.boolean(),
            pin: fc.boolean(),
          }),
        },
        { weight: 2, arbitrary: fc.constant({ kind: 'display' as const }) },
        { weight: 1, arbitrary: fc.constant({ kind: 'pinOnly' as const }) },
      ]
      if (POOL_PAIRS.includes(pair)) {
        bodies.push({ weight: 2, arbitrary: fc.constant({ kind: 'rename' as const }) })
      }
      return fc.oneof(...bodies).map(body => ({ t: 'put' as const, pair, body }))
    })
    const deleteOp: fc.Arbitrary<Op> = anyTracked.map(pair => ({ t: 'delete' as const, pair }))
    const anyOp: fc.Arbitrary<Op> = fc.oneof(
      { weight: 4, arbitrary: hostOp },
      { weight: 2, arbitrary: grantOp },
      { weight: 2, arbitrary: recipeOp },
      { weight: 3, arbitrary: putOp },
      { weight: 1, arbitrary: deleteOp }
    )

    const putBodyArb: fc.Arbitrary<PutBody> = fc.oneof(
      {
        weight: 3,
        arbitrary: fc.record({
          kind: fc.constant('enabled' as const),
          value: fc.boolean(),
          pin: fc.boolean(),
        }),
      },
      { weight: 1, arbitrary: fc.constant({ kind: 'display' as const }) }
    )
    const raceOp: fc.Arbitrary<RaceOp> = fc.oneof(
      {
        weight: 3,
        arbitrary: fc
          .tuple(fc.constantFrom('h1', 'h2'), fc.nat(3))
          .map(([name, which]) => ({ t: 'hostOnCandidate' as const, name, which })),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.constantFrom(...GRANT_RECIPES), fc.nat(3))
          .map(([name, which]) => ({ t: 'grantOnCandidate' as const, name, which })),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.nat(3), putBodyArb)
          .map(([which, body]) => ({ t: 'putOnCandidate' as const, which, body })),
      },
      { weight: 2, arbitrary: hostOp },
      { weight: 1, arbitrary: grantOp },
      { weight: 1, arbitrary: recipeOp },
      { weight: 1, arbitrary: putOp },
      { weight: 1, arbitrary: deleteOp }
    )

    type RawCmd =
      | { t: 'sync'; raw: RawSyncSpec }
      | { t: 'race'; raw: RawSyncSpec; op: RaceOp }
      | Exclude<Cmd, { t: 'sync' } | { t: 'race' }>

    class Step implements fc.AsyncCommand<object, object> {
      constructor(readonly cmd: RawCmd) {}
      check() {
        return true
      }
      async run() {
        const c = this.cmd
        if (c.t === 'sync') await exec({ t: 'sync', spec: resolveSpec(H.M, c.raw) })
        else if (c.t === 'race') {
          H.s = H.runScheduler
          try {
            await exec({ t: 'race', spec: resolveSpec(H.M, c.raw), op: c.op })
          } finally {
            H.s = null
          }
        } else await exec(c)
        // After the first violation the state has already diverged from the
        // model; further diffs would only bury the counterexample.
        if (H.violations.length === 0) await checkAtRest(this.toString())
      }
      toString() {
        const c = this.cmd
        switch (c.t) {
          case 'sync':
            return `sync ${showSpec(c.raw)}`
          case 'race':
            return `race ${showSpec(c.raw)} ∥ ${showRaceOp(c.op)}`
          case 'tick':
            return `tick +${c.hours}h`
          case 'feed':
            return `feed${c.includeAcknowledged ? '?includeAcknowledged' : ''}`
          case 'ack':
            return `ack #${c.index}${c.dropKey ? ' (one key dropped)' : ''}`
          case 'unack':
            return `unack #${c.index}`
          case 'policy':
            return `policy ${c.provider}=${c.value}`
          case 'op':
            return showOp(c.op)
          case 'opOnSaved':
            return `${c.op.via} ${c.op.name} on saved #${c.op.which}`
        }
      }
    }

    const step: fc.Arbitrary<fc.AsyncCommand<object, object>> = fc.oneof(
      {
        weight: 5,
        arbitrary: rawSpec(['live', 'live', 'live', 'live', 'live', 'vendored', 'implausible']).map(
          raw => new Step({ t: 'sync', raw })
        ),
      },
      {
        weight: 6,
        arbitrary: fc.constantFrom(1, 3, 3).map(hours => new Step({ t: 'tick', hours })),
      },
      {
        weight: 5,
        arbitrary: fc.boolean().map(b => new Step({ t: 'feed', includeAcknowledged: b })),
      },
      {
        weight: 5,
        arbitrary: fc
          .tuple(fc.nat(7), fc.constantFrom(false, false, false, true))
          .map(([index, dropKey]) => new Step({ t: 'ack', index, dropKey })),
      },
      { weight: 3, arbitrary: fc.nat(7).map(index => new Step({ t: 'unack', index })) },
      {
        weight: 2,
        arbitrary: fc
          .tuple(provider, fc.boolean())
          .map(([p, value]) => new Step({ t: 'policy', provider: p, value })),
      },
      { weight: 5, arbitrary: anyOp.map(op => new Step({ t: 'op', op })) },
      {
        weight: 3,
        // Each kind of consumer writes to its own object (h2, r2, g2).
        arbitrary: fc
          .tuple(fc.constantFrom<SavedOp['via']>('host', 'recipe', 'grant'), fc.nat(7))
          .map(
            ([via, which]) =>
              new Step({
                t: 'opOnSaved',
                op: { via, which, name: { host: 'h2', recipe: 'r2', grant: 'g2' }[via] },
              })
          ),
      },
      {
        weight: 7,
        arbitrary: fc
          .tuple(rawSpec(['live']), raceOp)
          .map(([raw, op]) => new Step({ t: 'race', raw, op })),
      }
    )

    // Most sequences open by dropping part of the pool from a live catalog and,
    // often, letting the grace run out, so the prune and the return of a pruned
    // model are reached within the sequence instead of only at its very end.
    const prefix: fc.Arbitrary<Step[]> = fc
      .tuple(fc.subarray(POOL_PAIRS), fc.constantFrom(0, 3, 3))
      .map(([dropped, hours]) => {
        if (dropped.length === 0) return []
        const listing = Object.fromEntries(
          POOL_PAIRS.map(p => [p, (dropped.includes(p) ? 'gone' : 'listed') as ListingChoice])
        )
        const steps = [
          new Step({ t: 'sync', raw: { source: 'live', listing, reEnableCap: UNCAPPED } }),
        ]
        if (hours > 0) steps.push(new Step({ t: 'tick', hours }))
        return steps
      })

    it('every sequence and interleaving prunes, re-enables, publishes and shows attention as the model says', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          prefix,
          fc.commands([step], { maxCommands: MAX_COMMANDS, size: 'max' }),
          async (s, head, tail) => {
            const cmds = [...head, ...tail]
            await startRun()
            H.runScheduler = s
            if (H.violations.length > 0) {
              throw new Error(
                ['setup violations:', ...H.violations.map(v => `  - ${v}`)].join('\n')
              )
            }
            let failedAt = ''
            await fc.asyncModelRun(
              () => ({ model: {}, real: {} }),
              [...cmds].map(cmd => ({
                check: () => true,
                run: async () => {
                  if (H.violations.length > 0) return
                  await cmd.run({}, {})
                  // Every step ends with a full feed check on top of what it asserted.
                  if (H.violations.length === 0) await checkFeed(true, false)
                  if (H.violations.length > 0) failedAt = cmd.toString()
                },
                toString: () => cmd.toString(),
              }))
            )
            if (H.violations.length > 0) {
              throw new Error(
                [
                  `violations (first failing step: ${failedAt}):`,
                  ...H.violations.map(v => `  - ${v}`),
                  `commands: ${[...cmds].map(c => String(c)).join(' ; ')}`,
                  ...(failedAt.startsWith('race')
                    ? [
                        `scheduler order of that race:`,
                        ...H.raceOrder.map((l, i) => `  ${i + 1}. ${l}`),
                      ]
                    : []),
                ].join('\n')
              )
            }
          }
        ),
        { numRuns: NUM_RUNS, seed: SEED, endOnFailure: !SHRINK }
      )
      if (process.env.FC_COVERAGE)
        writeFileSync(process.env.FC_COVERAGE, JSON.stringify(coverage, null, 2))
      for (const what of [
        'pruned',
        're-enabled',
        're-enable deferred by the cap',
        'token dropped by policy or eligibility',
        'vendored run over a stale pool model',
        'acknowledged',
        'acknowledgement refused as outdated',
        'acknowledgement outlived by a new episode',
        'acknowledged item gained an explicit consumer',
        'acknowledgement undone',
        'feed listed an acknowledged item',
        'feed listed an all-models Host',
        'feed listed a deprecated model',
        'deprecated model with only an all-models Host left out',
        'pinned',
        'renamed',
        'race pruned',
        'race: candidate whose consumers the write changed',
      ]) {
        expect(
          coverage[what] ?? 0,
          `runs never reached: ${what} (reached: ${JSON.stringify(coverage)})`
        ).toBeGreaterThan(0)
      }
    }, 600_000)
  }
)
