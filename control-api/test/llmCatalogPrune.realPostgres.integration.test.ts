import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import type { LlmProviderId } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../src/data/modelsDevSnapshot.js'
import type { CatalogPruneHooks, CatalogPruneResult } from '../src/services/llmCatalogPrune.js'
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

// The catalog prune (R-A) and the sync's re-enable of pruned rows, on real
// PostgreSQL through the real producers: the catalog sync from the captured
// live models.dev fixture (and the real vendored fallback of the loader), the
// admin routes for models, Hosts, recipes and grants (grants through
// `upsertGrant`), and the real ConfigMap writer. The Kubernetes API is the
// MockGateway (plus a FakeConfigMapApi for the published allowlist); races are
// driven by the prune's interleaving hooks and by waiting until Postgres
// reports the other session blocked on a lock. Assertions are on `enabled`, the
// published ConfigMap and the attention feed (T4). Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

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
const MODELS_PATH = '/api/v1/admin/llm-models'
const HOSTS_PATH = '/api/v1/admin/hosts'
const STALE_KIND = 'stale_model_referenced'
const SYNC_ACTOR = 'system:catalog-sync'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

type CatalogProvider = 'openai' | 'claude'
const PROVIDER: CatalogProvider = 'openai'
const OTHER: CatalogProvider = 'claude'
const keyOf = (provider: CatalogProvider) => PROVIDER_KEY_MAP[provider]

function wholeProviders(providers: CatalogProvider[]): RawModelsDevCatalog {
  return trimLiveCatalog(
    Object.fromEntries(
      providers.map(p => [keyOf(p), Object.keys(LIVE_MODELS_DEV_CATALOG[keyOf(p)].models).length])
    )
  )
}

const FULL = wholeProviders([PROVIDER, OTHER])

function discovered(catalog: RawModelsDevCatalog, provider: CatalogProvider): DiscoveredModel[] {
  return mapCatalogToProviders(catalog)[provider as LlmProviderId] ?? []
}

function rawIdOf(catalog: RawModelsDevCatalog, provider: CatalogProvider, modelId: string): string {
  const entries = catalog[keyOf(provider)].models
  for (const rawId of Object.keys(entries)) {
    const [d] = discovered(
      { [keyOf(provider)]: { ...catalog[keyOf(provider)], models: { [rawId]: entries[rawId] } } },
      provider
    )
    if (d?.model_id === modelId) return rawId
  }
  throw new Error(`rawIdOf: ${provider}/${modelId} not in catalog`)
}

type Edit = {
  provider?: CatalogProvider
  gone?: string[]
  patch?: Record<string, Partial<RawModelsDevModel>>
}

/** FULL with some models dropped and some entries patched. */
function catalogWith(...edits: Edit[]): RawModelsDevCatalog {
  let catalog = FULL
  for (const edit of edits) {
    const provider = edit.provider ?? PROVIDER
    const key = keyOf(provider)
    const models = { ...catalog[key].models }
    for (const [modelId, patch] of Object.entries(edit.patch ?? {})) {
      const rawId = rawIdOf(FULL, provider, modelId)
      models[rawId] = { ...models[rawId], ...patch }
    }
    for (const modelId of edit.gone ?? []) delete models[rawIdOf(FULL, provider, modelId)]
    catalog = { ...catalog, [key]: { ...catalog[key], models } }
  }
  return catalog
}

const gone = (...models: string[]) => catalogWith({ gone: models })

const eligible = (provider: CatalogProvider) =>
  discovered(FULL, provider)
    .filter(m => isAutoEnableEligible(m) && m.catalog_status === null)
    .map(m => m.model_id)
const ELIGIBLE = eligible(PROVIDER)
const ELIGIBLE_OTHER = eligible(OTHER)
const VENDORED_IDS = new Set(
  discovered(VENDORED_MODELS_DEV_SNAPSHOT as RawModelsDevCatalog, PROVIDER).map(m => m.model_id)
)
// Live models the vendored snapshot also lists, and live models it does not.
const IN_VENDORED = ELIGIBLE.filter(m => VENDORED_IDS.has(m))
const NOT_IN_VENDORED = ELIGIBLE.filter(m => !VENDORED_IDS.has(m))
if (ELIGIBLE.length < 12 || ELIGIBLE_OTHER.length < 4) {
  throw new Error('the live fixture no longer has the models these cases need')
}
if (IN_VENDORED.length < 2 || NOT_IN_VENDORED.length < 1) {
  throw new Error('the vendored snapshot no longer overlaps the live fixture as these cases need')
}
const pick = (i: number) => ELIGIBLE[i]!
const pickOther = (i: number) => ELIGIBLE_OTHER[i]!
const deprecate = { status: 'deprecated' } as Partial<RawModelsDevModel>

interface RowState {
  enabled: boolean
  source: string
  stale: boolean
  enabled_managed_by: string
  auto_disabled_at: Date | null
  stale_since: Date | null
  stale_episode: number
}

describeRealPostgres('catalog prune and re-enable (real PostgreSQL)', () => {
  const database = `control_api_prune_${randomBytes(6).toString('hex')}`
  // describe.skip still runs this factory, so it must not build a URL without the env.
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let racePool: Pool
  let runtimePool: Pool
  let gateway: InstanceType<typeof import('./mockGateway.js').MockGateway>
  let cluster: FakeConfigMapApi
  let hostNs: string
  let recipeNs: string
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    MockGateway: typeof import('./mockGateway.js').MockGateway
    config: typeof import('../src/config.js').config
    withTransaction: typeof import('../src/db.js').withTransaction
    syncDiscoveredModels: typeof import('../src/services/llmCatalogSync.js').syncDiscoveredModels
    CatalogPublishAfterCommitError: typeof import('../src/services/llmCatalogSync.js').CatalogPublishAfterCommitError
    loadModelsDevCatalog: typeof import('../src/services/modelsDevClient.js').loadModelsDevCatalog
    updateAllowedModel: typeof import('../src/services/llmAllowedModels.js').updateAllowedModel
    setProviderAutoEnable: typeof import('../src/services/llmProviderCatalogSettings.js').setProviderAutoEnable
    pruneStaleCatalogModels: typeof import('../src/services/llmCatalogPrune.js').pruneStaleCatalogModels
    computeModelConsumers: typeof import('../src/services/llmModelConsumers.js').computeModelConsumers
    modelHasConsumers: typeof import('../src/services/llmModelConsumers.js').modelHasConsumers
    modelConsumerSourcesFromGateway: typeof import('../src/services/llmModelConsumers.js').modelConsumerSourcesFromGateway
    consumerNamespacesFromConfig: typeof import('../src/services/llmModelConsumers.js').consumerNamespacesFromConfig
    Writer: typeof import('../src/services/llmAllowedModelsConfigMap.js').LlmAllowedModelsConfigMapWriter
    AllowlistPublishRetry: typeof import('../src/services/llmAllowlistPublishRetry.js').AllowlistPublishRetry
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
    racePool = new Pool({ connectionString })
    racePool.on('error', () => {})
    runtimePool = new Pool({ connectionString, options: '-c role=control_api_runtime' })
    runtimePool.on('error', () => {})

    const appMod = await import('../src/app.js')
    const configMod = await import('../src/config.js')
    const syncMod = await import('../src/services/llmCatalogSync.js')
    const clientMod = await import('../src/services/modelsDevClient.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const policyMod = await import('../src/services/llmProviderCatalogSettings.js')
    const pruneMod = await import('../src/services/llmCatalogPrune.js')
    const consumersMod = await import('../src/services/llmModelConsumers.js')
    const cmMod = await import('../src/services/llmAllowedModelsConfigMap.js')
    const retryMod = await import('../src/services/llmAllowlistPublishRetry.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      MockGateway,
      config: configMod.config,
      withTransaction: dbMod.withTransaction,
      syncDiscoveredModels: syncMod.syncDiscoveredModels,
      CatalogPublishAfterCommitError: syncMod.CatalogPublishAfterCommitError,
      loadModelsDevCatalog: clientMod.loadModelsDevCatalog,
      updateAllowedModel: allowlistMod.updateAllowedModel,
      setProviderAutoEnable: policyMod.setProviderAutoEnable,
      pruneStaleCatalogModels: pruneMod.pruneStaleCatalogModels,
      computeModelConsumers: consumersMod.computeModelConsumers,
      modelHasConsumers: consumersMod.modelHasConsumers,
      modelConsumerSourcesFromGateway: consumersMod.modelConsumerSourcesFromGateway,
      consumerNamespacesFromConfig: consumersMod.consumerNamespacesFromConfig,
      Writer: cmMod.LlmAllowedModelsConfigMapWriter,
      AllowlistPublishRetry: retryMod.AllowlistPublishRetry,
    }
    hostNs = mod.config.hostsNamespace
    recipeNs = mod.config.sandboxNamespace
  }, 60_000)

  afterAll(async () => {
    try {
      if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
      await endPoolAndWaitForClients(runtimePool).catch(() => {})
      await endPoolAndWaitForClients(racePool).catch(() => {})
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

  beforeEach(async () => {
    mockVerifyAdminToken.mockReset().mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset().mockResolvedValue(false)
    mockFindAdminById.mockReset().mockResolvedValue(ACTIVE_ADMIN)
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
    gateway = new mod.MockGateway()
    cluster = new FakeConfigMapApi()
    await mod.setProviderAutoEnable(PROVIDER, true, 'test-admin', corePool)
    await mod.setProviderAutoEnable(OTHER, true, 'test-admin', corePool)
  })

  // ── producers ────────────────────────────────────────────────────────────────

  interface SyncOptions {
    source?: 'live' | 'vendored'
    implausible?: boolean
    /** No prune phase (to make rows stale without pruning them). */
    noPrune?: boolean
    graceMs?: number
    maxPerRun?: number
    hooks?: CatalogPruneHooks
    maxPerProvider?: number
    autoEnableMaxPerRun?: number
    connector?: Pool
    txPool?: Pool
    publishRetry?: InstanceType<typeof mod.AllowlistPublishRetry>
  }

  const consumerSources = (db: import('../src/db.js').DbClient) =>
    mod.modelConsumerSourcesFromGateway(gateway, mod.consumerNamespacesFromConfig(), db)

  function prune(o: SyncOptions = {}) {
    return (run: Parameters<typeof mod.pruneStaleCatalogModels>[0]) =>
      mod.pruneStaleCatalogModels(run, {
        consumerSources,
        graceMs: o.graceMs ?? 0,
        maxPerRun: o.maxPerRun ?? 50,
        txPool: o.txPool ?? corePool,
        hooks: o.hooks,
      })
  }

  /** The loader's real vendored fallback: the live fetch fails. */
  const vendoredLoader = () =>
    mod.loadModelsDevCatalog({
      fetchImpl: (async () => {
        throw new Error('models.dev unreachable')
      }) as never,
    })

  function sync(catalog: RawModelsDevCatalog, o: SyncOptions = {}): Promise<CatalogSyncResult> {
    return mod.syncDiscoveredModels(
      {
        materializer: new mod.Writer(cluster as never, 'mcp-host', 3, corePool),
        loadCatalog:
          o.source === 'vendored'
            ? vendoredLoader
            : loadStub(catalog, 'live', LIVE_MODELS_DEV_CAPTURED_AT),
        minPlausibleLiveTotal: o.implausible ? 1_000_000 : 1,
        autoEnableMaxPerProviderPerRun: o.maxPerProvider ?? 1_000,
        autoEnableMaxPerRun: o.autoEnableMaxPerRun ?? 10_000,
        ...(o.publishRetry ? { publishRetry: o.publishRetry } : {}),
        ...(o.noPrune ? {} : { prune: prune(o) }),
      },
      (o.connector ?? corePool) as unknown as SyncConnector
    )
  }

  const vendoredSync = (o: SyncOptions = {}) => sync(FULL, { ...o, source: 'vendored' })

  const app = () => mod.createApp(gateway)

  async function feedItems(model: string) {
    const res = await request(app())
      .get('/api/v1/admin/attention')
      .set('Cookie', COOKIE)
      .expect(200)
    return (res.body.items as Array<{ kind: string; model: string }>).filter(i => i.model === model)
  }

  /** `provider/model` of every entry of the published allowlist ConfigMap. */
  function published(): Set<string> {
    const out = new Set<string>()
    for (const [provider, json] of Object.entries(cluster.data ?? {})) {
      if (provider.includes('.') || provider.includes('/')) continue
      for (const entry of JSON.parse(json) as Array<{ model: string }>) {
        out.add(`${provider}/${entry.model}`)
      }
    }
    return out
  }
  const isPublished = (model: string, provider: string = PROVIDER) =>
    published().has(`${provider}/${model}`)

  async function subsetHost(name: string, model: string, provider: string = PROVIDER) {
    const res = await request(app())
      .post(HOSTS_PATH)
      .set('Cookie', COOKIE)
      .send({
        metadata: { name },
        spec: { model: { provider, name: model }, allowedModels: [{ provider, model }] },
      })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  }

  function postSubsetHost(name: string, model: string, provider: string = PROVIDER) {
    return request(app())
      .post(HOSTS_PATH)
      .set('Cookie', COOKIE)
      .send({
        metadata: { name },
        spec: { model: { provider, name: model }, allowedModels: [{ provider, model }] },
      })
  }

  async function allModelsHost(name: string, model: string, provider: string = PROVIDER) {
    await request(app())
      .post(HOSTS_PATH)
      .set('Cookie', COOKIE)
      .send({ metadata: { name }, spec: { model: { provider, name: model } } })
      .expect(201)
  }

  async function deleteHost(name: string) {
    await request(app())
      .delete(`${HOSTS_PATH}/${name}`)
      .set('Cookie', COOKIE)
      .expect(res => expect([200, 204]).toContain(res.status))
  }

  async function agentRecipe(name: string, model: string) {
    await request(app())
      .post('/api/v1/admin/recipes')
      .set('Cookie', COOKIE)
      .send({
        metadata: { name },
        spec: {
          triggers: { onDemand: { allowedActors: ['user'] } },
          agent: { provider: PROVIDER, model },
          steps: [{ id: 's1', instruction: 'go' }],
        },
      })
      .expect(res => expect(res.status, JSON.stringify(res.body)).toBe(201))
  }

  function upsertGrant(recipeName: string, promptTarget: string, allowedModels: string[]) {
    return request(app())
      .post('/api/v1/admin/plugin-workload-sdk/grants')
      .set('Cookie', COOKIE)
      .send({
        recipeNamespace: recipeNs,
        recipeName,
        capabilityFamily: 'promptBridge',
        provider: PROVIDER,
        allowedModels,
        promptTargets: [
          {
            targetRef: 'primary',
            provider: PROVIDER,
            model: promptTarget,
            credentialSlot: 'openai-api-key',
          },
        ],
        defaultTargetRef: 'primary',
        allowedCallers: ['api'],
      })
  }

  async function rowId(model: string, provider: string = PROVIDER): Promise<string> {
    const { rows } = await corePool.query<{ id: string }>(
      `SELECT id FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
      [provider, model]
    )
    expect(rows, `${provider}/${model}`).toHaveLength(1)
    return rows[0]!.id
  }

  async function row(model: string, provider: string = PROVIDER): Promise<RowState> {
    const { rows } = await corePool.query<RowState>(
      `SELECT enabled, source, stale, enabled_managed_by, auto_disabled_at, stale_since, stale_episode
         FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
      [provider, model]
    )
    expect(rows, `${provider}/${model}`).toHaveLength(1)
    return rows[0]!
  }

  /** What the Discovery panel lists as new: discovery, disabled, not stale. */
  async function inDiscoveryQueue(model: string): Promise<boolean> {
    const res = await request(app()).get(MODELS_PATH).set('Cookie', COOKIE).expect(200)
    const r = (
      res.body.rows as Array<{
        provider: string
        model: string
        source: string
        enabled: boolean
        stale: boolean
      }>
    ).find(x => x.provider === PROVIDER && x.model === model)
    return r !== undefined && r.source === 'discovery' && !r.enabled && !r.stale
  }

  function put(id: string, body: Record<string, unknown>, query = '') {
    return request(app()).put(`${MODELS_PATH}/${id}${query}`).set('Cookie', COOKIE).send(body)
  }

  async function audits(action: string, model?: string): Promise<string[]> {
    const { rows } = await corePool.query<{ actor: string; model: string }>(
      `SELECT actor, model FROM llm_allowed_models_audit WHERE action = $1 ORDER BY created_at, id`,
      [action]
    )
    return rows.filter(r => model === undefined || r.model === model).map(r => r.actor)
  }

  async function pruneRuns() {
    const { rows } = await corePool.query(
      `SELECT candidates, prefiltered, examined_locked, pruned, aborted, abort_reason
         FROM llm_catalog_prune_runs ORDER BY ran_at, id`
    )
    return rows
  }

  /** `models` in the prune's candidate order (stale_since, then id). */
  async function candidateOrder(...models: string[]): Promise<string[]> {
    const { rows } = await corePool.query<{ model: string }>(
      `SELECT model FROM llm_allowed_models
        WHERE provider = $1 AND model = ANY($2::text[])
        ORDER BY stale_since ASC, id ASC`,
      [PROVIDER, models]
    )
    return rows.map(r => r.model)
  }

  /** Make `models` stale (gone from a live catalog) without pruning them. */
  async function makeStale(...models: string[]) {
    await sync(FULL, { noPrune: true })
    await sync(gone(...models), { noPrune: true })
  }

  /** Make `models` stale and let that run's prune disable them. */
  async function makePruned(...models: string[]) {
    await sync(FULL, { noPrune: true })
    const res = await sync(gone(...models))
    expect(res.pruned).toBe(models.length)
  }

  /** Resolve once Postgres reports at least `n` sessions of this database waiting on a lock. */
  async function untilBlocked(n = 1, kind?: 'advisory' | 'row') {
    const deadline = Date.now() + 10_000
    for (;;) {
      const { rows } = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'
            AND ($2::text IS NULL
                 OR ($2 = 'advisory' AND wait_event = 'advisory')
                 OR ($2 = 'row' AND wait_event IN ('transactionid', 'tuple')))`,
        [database, kind ?? null]
      )
      if (rows[0]!.n >= n) return
      if (Date.now() > deadline) throw new Error('untilBlocked: no session blocked on a lock')
      await new Promise(r => setTimeout(r, 10))
    }
  }

  /** Run `fn` exactly once, for the candidate `model`. */
  function onceFor(model: string, fn: () => Promise<void>) {
    let done = false
    return async (c: { model: string }) => {
      if (done || c.model !== model) return
      done = true
      await fn()
    }
  }

  // ── at-rest invariants, checked after every case ─────────────────────────────

  // The prune token only exists on a row the prune may still own: catalog-
  // managed, discovered, disabled and stale. It covers I-S2 (no 'operator' row
  // carries the prune's decision), I-S3 (no manual row: a rename or an operator
  // PUT drops it) and I-S4 (the prune never left a non-stale row disabled), and
  // that a pruned row never reaches the Discovery queue.
  async function assertTokenInvariant() {
    const { rows } = await corePool.query(
      `SELECT provider, model, enabled, source, stale, enabled_managed_by
         FROM llm_allowed_models WHERE auto_disabled_at IS NOT NULL`
    )
    for (const r of rows) {
      expect(r, `${r.provider}/${r.model}`).toMatchObject({
        enabled: false,
        source: 'discovery',
        stale: true,
        enabled_managed_by: 'catalog',
      })
    }
    // Every automatic `enabled` change is the sync's, on a catalog provider.
    const { rows: automated } = await corePool.query(
      `SELECT actor, provider FROM llm_allowed_models_audit
        WHERE action IN ('auto_disable', 'auto_enable')`
    )
    for (const a of automated) {
      expect(a.actor).toBe(SYNC_ACTOR)
      expect(Object.keys(PROVIDER_KEY_MAP)).toContain(a.provider)
    }
  }

  // I-V1, for a run that did not abort and stayed under its cap: no enabled
  // catalog-managed stale row outside the grace is left without a consumer.
  async function assertNothingLeftToPrune() {
    const { rows } = await corePool.query<{ provider: string; model: string }>(
      `SELECT provider, model FROM llm_allowed_models
        WHERE enabled AND enabled_managed_by = 'catalog' AND stale AND source = 'discovery'`
    )
    for (const r of rows) {
      const consumers = await mod.computeModelConsumers(
        r.provider,
        r.model,
        consumerSources(corePool)
      )
      expect(mod.modelHasConsumers(consumers), `${r.provider}/${r.model}`).toBe(true)
    }
  }

  afterEach(async () => {
    await assertTokenInvariant()
  })

  // ── invariants first (T5) ────────────────────────────────────────────────────

  describe('invariants', () => {
    it('I-V1 / I-S1: a decidable run prunes every stale unused catalog model and none that is used', async () => {
      const used = { explicit: pick(0), recipe: pick(1), grant: pick(2), k4: pickOther(0) }
      const unused = [pick(3), pick(4), pickOther(1)]
      await sync(FULL, { noPrune: true })
      await subsetHost('h-explicit', used.explicit)
      await agentRecipe('r-uses', used.recipe)
      expect((await upsertGrant('g-uses', pick(5), [used.grant])).status).toBe(200)
      await allModelsHost('all-claude', pickOther(2), OTHER)
      const res = await sync(
        catalogWith(
          { gone: [used.explicit, used.recipe, used.grant, unused[0]!, unused[1]!] },
          { provider: OTHER, gone: [used.k4, unused[2]!] }
        )
      )
      // claude has an all-models Host: every claude model has a consumer (K4).
      expect(res).toMatchObject({ pruned: 2, pruneAborted: false })
      for (const m of [unused[0]!, unused[1]!]) {
        expect((await row(m)).enabled).toBe(false)
        expect(isPublished(m)).toBe(false)
      }
      for (const m of [used.explicit, used.recipe, used.grant]) {
        expect((await row(m)).enabled).toBe(true)
        expect(isPublished(m)).toBe(true)
      }
      expect((await row(used.k4, OTHER)).enabled).toBe(true)
      expect((await row(unused[2]!, OTHER)).enabled).toBe(true)
      await assertNothingLeftToPrune()
      expect(await audits('auto_disable')).toEqual([SYNC_ACTOR, SYNC_ACTOR])
    })

    it('I-S8 / S-33: a vendored run never changes stale, stale_since or the episode, with or without an acknowledgement', async () => {
      const [m, n] = [IN_VENDORED[0]!, IN_VENDORED[1]!]
      await sync(FULL, { noPrune: true })
      // Consumers keep both out of the prune; `n` gets acknowledged.
      await subsetHost('h-m', m)
      await subsetHost('h-n', n)
      await sync(gone(m, n))
      const item = (
        await request(app()).get('/api/v1/admin/attention').set('Cookie', COOKIE)
      ).body.items.find(
        (i: { kind: string; model: string }) => i.kind === STALE_KIND && i.model === n
      )
      await request(app())
        .post('/api/v1/admin/attention/ack')
        .set('Cookie', COOKIE)
        .send({
          provider: item.provider,
          model: item.model,
          kind: item.kind,
          episode: item.episode,
          consumerKeys: item.consumerKeys,
        })
        .expect(200)
      const before = { m: await row(m), n: await row(n) }
      expect(before.m.stale && before.n.stale).toBe(true)

      const res = await vendoredSync()
      expect(res.source).toBe('vendored')
      expect(res).toMatchObject({ pruned: 0, pruneAborted: false })
      expect(await row(m)).toEqual(before.m)
      expect(await row(n)).toEqual(before.n)
      // The acknowledgement still holds; the unacknowledged item is still there.
      expect((await feedItems(n)).map(i => i.kind)).toEqual([])
      expect((await feedItems(m)).map(i => i.kind)).toEqual([STALE_KIND])

      // A live run that lists them clears `stale`.
      await sync(FULL)
      expect((await row(m)).stale).toBe(false)
    })
  })

  // ── C3: the prune ────────────────────────────────────────────────────────────

  describe('C3: pre-filter, lock and per-row recheck', () => {
    it('S-1: a sync that lists the candidate again between the query and the lock leaves it enabled', async () => {
      const m = pick(0)
      await makeStale(m)
      const res = await sync(gone(m), {
        hooks: { beforeLock: onceFor(m, async () => void (await sync(FULL, { noPrune: true }))) },
      })
      expect(res).toMatchObject({ pruned: 0, pruneAborted: false })
      expect(await row(m)).toMatchObject({ enabled: true, stale: false, auto_disabled_at: null })
      expect(isPublished(m)).toBe(true)
      expect(await audits('auto_disable')).toEqual([])
    })

    it('S-2: a PUT that pins enabled between the query and the lock makes the row the operator’s', async () => {
      const m = pick(0)
      await makeStale(m)
      const id = await rowId(m)
      const res = await sync(gone(m), {
        hooks: {
          beforeLock: onceFor(m, async () => {
            await put(id, { enabled: true, pinEnabled: true }).expect(200)
          }),
        },
      })
      expect(res.pruned).toBe(0)
      expect(await row(m)).toMatchObject({ enabled: true, enabled_managed_by: 'operator' })
      expect(isPublished(m)).toBe(true)
    })

    it('S-2b: a PUT that only edits display_name keeps the row the catalog’s, and it is pruned', async () => {
      const m = pick(0)
      await makeStale(m)
      const id = await rowId(m)
      const res = await sync(gone(m), {
        hooks: {
          beforeLock: onceFor(m, async () => {
            // The edit form resends `enabled` unchanged with every save.
            await put(id, { enabled: true, display_name: 'Edited' }).expect(200)
          }),
        },
      })
      expect(res.pruned).toBe(1)
      expect(await row(m)).toMatchObject({ enabled: false, enabled_managed_by: 'catalog' })
      expect(isPublished(m)).toBe(false)
    })

    it('S-3 (h0): a Host that names the model between the pre-filter and the lock is seen live', async () => {
      const m = pick(0)
      await makeStale(m)
      const res = await sync(gone(m), {
        hooks: { beforeLock: onceFor(m, () => subsetHost('h-late', m)) },
      })
      expect(res.pruned).toBe(0)
      expect((await row(m)).enabled).toBe(true)
      expect(isPublished(m)).toBe(true)
      await assertNothingLeftToPrune()
    })

    it('S-3 (h2): a Host write that waits on the model lock is refused after the prune commits', async () => {
      const m = pick(0)
      await makeStale(m)
      let hostWrite!: Promise<request.Response>
      const res = await sync(gone(m), {
        hooks: {
          beforeUpdate: onceFor(m, async () => {
            hostWrite = Promise.resolve(postSubsetHost('h-blocked', m))
            await untilBlocked(1, 'advisory')
          }),
        },
      })
      expect(res.pruned).toBe(1)
      const hostRes = await hostWrite
      expect(hostRes.status, JSON.stringify(hostRes.body)).not.toBe(201)
      expect(await gateway.listResource('hosts', hostNs)).toEqual([])
      expect(await row(m)).toMatchObject({ enabled: false })
      expect(isPublished(m)).toBe(false)
    })

    it('S-4: a grant that names the model in allowed_models before the lock keeps it; one after the prune is stored (pre-existing gap)', async () => {
      const [m, n, target] = [pick(0), pick(1), pick(2)]
      await makeStale(m, n)
      const res = await sync(gone(m, n), {
        hooks: {
          beforeLock: onceFor(m, async () => {
            expect((await upsertGrant('g-before', target, [m])).status).toBe(200)
          }),
        },
      })
      expect(res.pruned).toBe(1)
      expect((await row(m)).enabled).toBe(true)
      expect((await row(n)).enabled).toBe(false)
      // The upsert does not validate `enabled` for allowed_models.
      expect((await upsertGrant('g-after', target, [n])).status).toBe(200)
      expect((await row(n)).enabled).toBe(false)
    })

    it('S-6: a Host turned all-models while the prune holds the lock does not stop it (accepted)', async () => {
      const [m, x] = [pick(0), pick(1)]
      await sync(FULL, { noPrune: true })
      await subsetHost('h-x', x)
      await sync(gone(m), { noPrune: true })
      const res = await sync(gone(m), {
        hooks: {
          beforeUpdate: onceFor(m, async () => {
            await request(app())
              .put(`${HOSTS_PATH}/h-x`)
              .set('Cookie', COOKIE)
              .send({ metadata: { name: 'h-x' }, spec: { model: { provider: PROVIDER, name: x } } })
              .expect(res => expect(res.status, JSON.stringify(res.body)).toBe(200))
          }),
        },
      })
      expect(res.pruned).toBe(1)
      expect((await row(m)).enabled).toBe(false)
      expect(isPublished(m)).toBe(false)
    })

    it('S-15: candidates used through an all-models Host do not use up the locked examinations', async () => {
      const k4 = [pick(1), pick(2), pick(3), pick(4), pick(5)]
      const free = [pickOther(0), pickOther(1), pickOther(2)]
      await sync(FULL, { noPrune: true })
      await allModelsHost('all-openai', pick(0))
      // The K4 candidates become stale first, so they come first in the order.
      await sync(gone(...k4), { noPrune: true })
      const res = await sync(catalogWith({ gone: k4 }, { provider: OTHER, gone: free }), {
        maxPerRun: 2,
      })
      expect(res.pruned).toBe(2)
      expect(await pruneRuns()).toEqual([
        {
          candidates: 8,
          prefiltered: 5,
          examined_locked: 2,
          pruned: 2,
          aborted: false,
          abort_reason: null,
        },
      ])
      for (const m of k4) expect((await row(m)).enabled).toBe(true)
      const disabled = []
      for (const m of free) if (!(await row(m, OTHER)).enabled) disabled.push(m)
      expect(disabled).toHaveLength(2)
      for (const m of disabled) expect(isPublished(m, OTHER)).toBe(false)
    })

    it('S-18: a recipe that names the model keeps it enabled', async () => {
      const m = pick(0)
      await sync(FULL, { noPrune: true })
      await agentRecipe('r-m', m)
      const res = await sync(gone(m))
      expect(res).toMatchObject({ pruned: 0 })
      expect(await pruneRuns()).toMatchObject([{ candidates: 1, prefiltered: 1, pruned: 0 }])
      expect((await row(m)).enabled).toBe(true)
      expect((await feedItems(m)).map(i => i.kind)).toEqual([STALE_KIND])
    })

    it('S-36: two syncs that relist and re-stale the model during the locked phase restart its grace', async () => {
      const m = pick(0)
      await makeStale(m)
      const before = await row(m)
      const res = await sync(gone(m), {
        hooks: {
          beforeUpdate: onceFor(m, async () => {
            await sync(FULL, { noPrune: true })
            await sync(gone(m), { noPrune: true })
          }),
        },
      })
      expect(res.pruned).toBe(0)
      const after = await row(m)
      expect(after).toMatchObject({ enabled: true, stale: true })
      expect(after.stale_episode).toBe(before.stale_episode + 1)
      expect(isPublished(m)).toBe(true)
    })

    it('S-38: the locked phase stops after 2·TOPE examinations when candidates gain consumers between the phases', async () => {
      await makeStale(pick(0), pick(1), pick(2), pick(3))
      // Ties on stale_since are broken by id: take the prune's own order.
      const [a, b, c, d] = await candidateOrder(pick(0), pick(1), pick(2), pick(3))
      const res = await sync(gone(a, b, c, d), {
        maxPerRun: 1,
        hooks: {
          beforeLock: onceFor(a, async () => {
            await subsetHost('h-a', a)
            await subsetHost('h-b', b)
          }),
        },
      })
      expect(res).toMatchObject({ pruned: 0, pruneAborted: false })
      expect(await pruneRuns()).toEqual([
        {
          candidates: 4,
          prefiltered: 0,
          examined_locked: 2,
          pruned: 0,
          aborted: false,
          abort_reason: null,
        },
      ])
      for (const m of [a, b, c, d]) expect((await row(m)).enabled).toBe(true)
    })

    it('S-32: an acknowledged stale model whose consumers went away is pruned all the same', async () => {
      const m = pick(0)
      await sync(FULL, { noPrune: true })
      await subsetHost('h-m', m)
      await sync(gone(m))
      const res0 = await request(app()).get('/api/v1/admin/attention').set('Cookie', COOKIE)
      const item = res0.body.items.find((i: { model: string }) => i.model === m)
      await request(app())
        .post('/api/v1/admin/attention/ack')
        .set('Cookie', COOKIE)
        .send({
          provider: item.provider,
          model: m,
          kind: item.kind,
          episode: item.episode,
          consumerKeys: item.consumerKeys,
        })
        .expect(200)
      expect(await feedItems(m)).toEqual([])
      await deleteHost('h-m')
      const res = await sync(gone(m))
      expect(res.pruned).toBe(1)
      expect((await row(m)).enabled).toBe(false)
      expect(isPublished(m)).toBe(false)
      expect(await feedItems(m)).toEqual([])
    })
  })

  // ── C8: grace from stale_since ───────────────────────────────────────────────

  describe('C8: grace', () => {
    it('S-13: a candidate inside the default grace is not touched', async () => {
      const m = pick(0)
      await sync(FULL, { noPrune: true })
      const res = await mod.syncDiscoveredModels(
        {
          materializer: new mod.Writer(cluster as never, 'mcp-host', 3, corePool),
          loadCatalog: loadStub(gone(m), 'live', LIVE_MODELS_DEV_CAPTURED_AT),
          minPlausibleLiveTotal: 1,
          prune: run => mod.pruneStaleCatalogModels(run, { consumerSources }),
        },
        corePool as unknown as SyncConnector
      )
      expect(mod.config.llmCatalogPruneStaleGraceMs).toBe(7 * 24 * 60 * 60 * 1000)
      expect(res).toMatchObject({ pruned: 0, pruneAborted: false })
      expect(await pruneRuns()).toMatchObject([{ candidates: 0, pruned: 0 }])
      expect(await row(m)).toMatchObject({ enabled: true, stale: true })
    })

    it('S-19: the grace counts from when the row became stale, not from its last sighting', async () => {
      const m = NOT_IN_VENDORED[0]!
      await sync(FULL, { noPrune: true })
      // The catalog is down for a while: runs fall back to the vendored
      // snapshot, which does not list `m`, so its last sighting ages.
      await new Promise(r => setTimeout(r, 1_600))
      await vendoredSync({ graceMs: 1_000 })
      // The first good run misses `m` once.
      const res = await sync(gone(m), { graceMs: 1_000 })
      expect(res.pruned).toBe(0)
      expect(await row(m)).toMatchObject({ enabled: true, stale: true })
    })
  })

  // ── C9: abort, never throws, cap, audit, run log ─────────────────────────────

  describe('C9: abort, concurrency and the run log', () => {
    it('S-12: two concurrent prunes disable a model once, with one audit row', async () => {
      const m = pick(0)
      await makeStale(m)
      const run = { decidable: true, syncRanAt: new Date().toISOString() }
      let second!: Promise<CatalogPruneResult>
      const first = await mod.pruneStaleCatalogModels(run, {
        consumerSources,
        graceMs: 0,
        hooks: {
          beforeCommit: onceFor(m, async () => {
            second = mod.pruneStaleCatalogModels(run, { consumerSources, graceMs: 0 })
            await untilBlocked(1, 'advisory')
          }),
        },
      })
      const other = await second
      expect(first.pruned).toBe(1)
      expect(other).toMatchObject({ candidates: 1, examinedLocked: 1, pruned: 0, aborted: false })
      expect(await audits('auto_disable')).toEqual([SYNC_ACTOR])
      expect(await pruneRuns()).toHaveLength(2)
    })

    it('S-14: a failed LIST mid-run keeps what was pruned, publishes it and records an aborted run', async () => {
      const [a, b] = [pick(0), pick(1)]
      await makeStale(a, b)
      const original = gateway.listResource.bind(gateway)
      let failing = false
      vi.spyOn(gateway, 'listResource').mockImplementation(async (plural, ns) => {
        if (failing && plural === 'hosts')
          throw Object.assign(new Error('apiserver down'), { statusCode: 503 })
        return original(plural, ns)
      })
      const [first, second] = await candidateOrder(a, b)
      const res = await sync(gone(a, b), {
        hooks: { beforeLock: onceFor(second!, async () => void (failing = true)) },
      })
      expect(res).toMatchObject({ pruned: 1, pruneAborted: true })
      expect((await row(first!)).enabled).toBe(false)
      expect((await row(second!)).enabled).toBe(true)
      expect(isPublished(first!)).toBe(false)
      expect(isPublished(second!)).toBe(true)
      expect(await pruneRuns()).toEqual([
        {
          candidates: 2,
          prefiltered: 0,
          examined_locked: 2,
          pruned: 1,
          aborted: true,
          abort_reason: 'locked_phase_failed',
        },
      ])
    })

    it('S-14: a failed LIST in the pre-filter prunes nothing and records an aborted run', async () => {
      const m = pick(0)
      await makeStale(m)
      vi.spyOn(gateway, 'listResource').mockRejectedValue(new Error('apiserver down'))
      const res = await sync(gone(m))
      expect(res).toMatchObject({ pruned: 0, pruneAborted: true })
      expect((await row(m)).enabled).toBe(true)
      expect(await pruneRuns()).toMatchObject([{ aborted: true, abort_reason: 'prefilter_failed' }])
    })

    it('S-17: the whole run, prune included, works with the control_api_runtime role', async () => {
      const m = pick(0)
      await sync(FULL, { noPrune: true, connector: runtimePool })
      const res = await sync(gone(m), { connector: runtimePool, txPool: runtimePool })
      expect(res).toMatchObject({ pruned: 1, pruneAborted: false })
      expect((await row(m)).enabled).toBe(false)
      expect(await pruneRuns()).toMatchObject([{ candidates: 1, pruned: 1, aborted: false }])
      expect(await audits('auto_disable')).toEqual([SYNC_ACTOR])
    })

    it('S-7: a failed publication after the prune is retried until the ConfigMap drops the model', async () => {
      const m = pick(0)
      await makeStale(m)
      expect(isPublished(m)).toBe(true)
      const retry = new mod.AllowlistPublishRetry({ baseDelayMs: 20, maxDelayMs: 50 })
      try {
        // The reconciliation changes nothing here, so the first publication
        // writes nothing and the armed failure hits the one after the prune.
        // Three: the writer's own attempts.
        cluster.failNextWrites(3)
        await expect(sync(gone(m), { publishRetry: retry })).rejects.toBeInstanceOf(
          mod.CatalogPublishAfterCommitError
        )
        expect((await row(m)).enabled).toBe(false)
        const deadline = Date.now() + 5_000
        while (isPublished(m) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
        expect(isPublished(m)).toBe(false)
      } finally {
        retry.stop()
      }
    })

    it('a run that cannot decide does not prune and records nothing', async () => {
      const m = pick(0)
      await makeStale(m)
      const res = await sync(gone(m), { implausible: true })
      expect(res).toMatchObject({ decidable: false, pruned: 0, pruneAborted: false })
      expect(await pruneRuns()).toEqual([])
      expect((await row(m)).enabled).toBe(true)
    })

    it('the on-demand sync route runs the prune', async () => {
      // The route loads the catalog itself: the vendored fallback here (no
      // network in tests) cannot decide, so it reports a skipped prune.
      const offline = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
      try {
        const res = await request(app())
          .post(`${MODELS_PATH}/discovery/sync`)
          .set('Cookie', COOKIE)
          .expect(200)
        expect(res.body).toMatchObject({ source: 'vendored', pruned: 0, pruneAborted: false })
      } finally {
        offline.mockRestore()
      }
    })
  })

  // ── C7: re-enable ────────────────────────────────────────────────────────────

  describe('C7: re-enable of pruned rows', () => {
    it('S-8 / I-V3: a pruned model the catalog lists again is enabled and published in that run', async () => {
      const m = pick(0)
      await makePruned(m)
      expect(isPublished(m)).toBe(false)
      const res = await sync(FULL)
      // Counted as re-enabled, never as a row inserted enabled.
      expect(res.providerCounts?.[PROVIDER]).toMatchObject({
        inserted: 0,
        autoEnabled: 0,
        reEnabled: 1,
        reEnableDeferredByCap: 0,
      })
      expect(res).toMatchObject({ added: 0, reEnabled: 1, reEnableDeferredByCap: 0 })
      expect(await row(m)).toMatchObject({
        enabled: true,
        stale: false,
        auto_disabled_at: null,
        enabled_managed_by: 'catalog',
      })
      expect(isPublished(m)).toBe(true)
      expect(await audits('auto_enable', m)).toEqual([SYNC_ACTOR])
    })

    it('S-8b: a pruned model that comes back deprecated stays off, loses its token and is not an item', async () => {
      const m = pick(0)
      await makePruned(m)
      await sync(catalogWith({ patch: { [m]: deprecate } }))
      expect(await row(m)).toMatchObject({ enabled: false, stale: false, auto_disabled_at: null })
      expect(isPublished(m)).toBe(false)
      expect(await feedItems(m)).toEqual([])
      expect(await audits('auto_enable')).toEqual([])
    })

    it('S-8c: a vendored run between the prune and the relisting neither clears stale nor re-enables', async () => {
      const m = IN_VENDORED[0]!
      await makePruned(m)
      const before = await row(m)
      await vendoredSync()
      expect(await row(m)).toEqual(before)
      expect(await inDiscoveryQueue(m)).toBe(false)
      await sync(FULL)
      expect(await row(m)).toMatchObject({ enabled: true, stale: false, auto_disabled_at: null })
      expect(isPublished(m)).toBe(true)
    })

    it('S-8d: a prune that commits while the reconciliation waits on the row is re-enabled by that run', async () => {
      const m = pick(0)
      await makeStale(m)
      let relist!: Promise<CatalogSyncResult>
      const res = await sync(gone(m), {
        hooks: {
          beforeCommit: onceFor(m, async () => {
            relist = sync(FULL, { noPrune: true })
            await untilBlocked(1, 'row')
          }),
        },
      })
      expect(res.pruned).toBe(1)
      const relisted = await relist
      expect(relisted.providerCounts?.[PROVIDER]).toMatchObject({ autoEnabled: 0, reEnabled: 1 })
      expect(await row(m)).toMatchObject({ enabled: true, stale: false, auto_disabled_at: null })
      expect(await audits('auto_disable', m)).toEqual([SYNC_ACTOR])
      expect(await audits('auto_enable', m)).toEqual([SYNC_ACTOR])
      expect(isPublished(m)).toBe(true)
    })

    it('S-8e / S-40: a relisting over the cap re-enables up to the cap; the rest keep token and stale', async () => {
      const [a, b, c] = [pick(0), pick(1), pick(2)]
      await makePruned(a, b, c)
      const res = await sync(FULL, { maxPerProvider: 1 })
      expect(res.providerCounts?.[PROVIDER]).toMatchObject({
        autoEnabled: 0,
        reEnabled: 1,
        reEnableDeferredByCap: 2,
      })
      expect(res).toMatchObject({ reEnabled: 1, reEnableDeferredByCap: 2 })
      const states = [await row(a), await row(b), await row(c)]
      expect(states.filter(s => s.enabled)).toHaveLength(1)
      const waiting = [a, b, c].filter((_, i) => !states[i]!.enabled)
      for (const m of waiting) {
        expect(await row(m)).toMatchObject({ enabled: false, stale: true })
        expect((await row(m)).auto_disabled_at).not.toBeNull()
        // Not listed by Discovery as a new model.
        expect(await inDiscoveryQueue(m)).toBe(false)
      }
      await sync(FULL, { maxPerProvider: 1 })
      await sync(FULL, { maxPerProvider: 1 })
      for (const m of [a, b, c]) expect((await row(m)).enabled).toBe(true)
    })

    for (const cap of ['per run', 'per provider'] as const) {
      it(`re-enables and new inserts together never exceed the auto-enable cap (${cap})`, async () => {
        const [a, b, n1, n2] = [pick(0), pick(1), pick(2), pick(3)]
        // n1 and n2 are new to the table; a and b get pruned.
        await sync(gone(n1, n2), { noPrune: true })
        await sync(gone(n1, n2, a, b))
        expect((await row(a)).enabled || (await row(b)).enabled).toBe(false)
        const res = await sync(
          FULL,
          cap === 'per run' ? { autoEnableMaxPerRun: 3 } : { maxPerProvider: 3 }
        )
        const counts = res.providerCounts?.[PROVIDER]
        // Re-enables take the cap first (catalog order, before any insert).
        expect(counts).toMatchObject({
          reEnabled: 2,
          reEnableDeferredByCap: 0,
          autoEnabled: 1,
          deferredByCap: 1,
        })
        const turnedOn = [a, b, n1, n2]
        let enabled = 0
        for (const m of turnedOn) {
          const { rows } = await corePool.query<{ enabled: boolean }>(
            `SELECT enabled FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
            [PROVIDER, m]
          )
          if (rows[0]?.enabled) enabled += 1
        }
        expect(enabled).toBe(3)
      })
    }

    it('S-8f: an implausible live run that lists a pruned row keeps its token and stale', async () => {
      const m = pick(0)
      await makePruned(m)
      const before = await row(m)
      await sync(FULL, { implausible: true })
      expect(await row(m)).toEqual(before)
      expect(await inDiscoveryQueue(m)).toBe(false)
    })

    it('S-20: with the policy off the relisted row stays off and loses its token; turning it on later changes nothing', async () => {
      const m = pick(0)
      await makePruned(m)
      await mod.setProviderAutoEnable(PROVIDER, false, 'test-admin', corePool)
      await sync(FULL)
      expect(await row(m)).toMatchObject({ enabled: false, stale: false, auto_disabled_at: null })
      await mod.setProviderAutoEnable(PROVIDER, true, 'test-admin', corePool)
      await sync(FULL)
      expect((await row(m)).enabled).toBe(false)
      expect(isPublished(m)).toBe(false)
    })

    it('S-37: a policy toggled off and on while the pruned model is absent still re-enables it', async () => {
      const m = pick(0)
      await makePruned(m)
      await mod.setProviderAutoEnable(PROVIDER, false, 'test-admin', corePool)
      await sync(gone(m))
      await mod.setProviderAutoEnable(PROVIDER, true, 'test-admin', corePool)
      await sync(FULL)
      expect((await row(m)).enabled).toBe(true)
      expect(isPublished(m)).toBe(true)
    })

    it('S-35: a rename committed while the reconciliation waits on the row is never re-enabled', async () => {
      const m = pick(0)
      await makePruned(m)
      const id = await rowId(m)
      let release!: () => void
      let renamedInTx!: () => void
      const held = new Promise<void>(r => (release = r))
      const renameApplied = new Promise<void>(r => (renamedInTx = r))
      const rename = mod.withTransaction(async db => {
        await mod.updateAllowedModel(id, { model: `${m}-renamed` }, 'test-admin', db)
        renamedInTx()
        await held
      }, racePool)
      // The rename holds the row; the sync's SELECT reads the old pair and its
      // UPDATE then waits on the rename.
      await renameApplied
      const relist = sync(FULL, { noPrune: true })
      await untilBlocked(1, 'row')
      release()
      await rename
      await relist
      expect(await row(`${m}-renamed`)).toMatchObject({
        enabled: false,
        source: 'manual',
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
      })
      expect(await audits('auto_enable')).toEqual([])
      expect(isPublished(`${m}-renamed`)).toBe(false)
    })

    it('S-10: a deleted row reinserted from its tombstone is outside the prune and the re-enable', async () => {
      const m = pick(0)
      await makePruned(m)
      await request(app())
        .delete(`${MODELS_PATH}/${await rowId(m)}`)
        .set('Cookie', COOKIE)
        .expect(res => expect([200, 204]).toContain(res.status))
      await sync(FULL)
      expect(await row(m)).toMatchObject({ enabled: false, auto_disabled_at: null })
      await sync(gone(m))
      await sync(FULL)
      expect(await row(m)).toMatchObject({ enabled: false, auto_disabled_at: null })
      expect(await audits('auto_enable')).toEqual([])
    })
  })

  // ── C2 against the prune: authority on the locked row ───────────────────────

  describe('operator authority against pruned rows', () => {
    it('S-9: enabling a pruned row makes it the operator’s: never pruned or re-enabled again', async () => {
      const m = pick(0)
      await makePruned(m)
      await put(await rowId(m), { enabled: true }).expect(200)
      expect(await row(m)).toMatchObject({
        enabled: true,
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
      })
      await sync(gone(m))
      expect((await row(m)).enabled).toBe(true)
      expect(isPublished(m)).toBe(true)
    })

    it('S-9b: pinning a pruned row off adopts the prune: the token goes and the relisting does not touch it', async () => {
      const m = pick(0)
      await makePruned(m)
      await put(await rowId(m), { enabled: false, pinEnabled: true }).expect(200)
      expect(await row(m)).toMatchObject({
        enabled: false,
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
      })
      await sync(FULL)
      // A live run that lists it clears `stale` (no token left to keep it).
      expect(await row(m)).toMatchObject({ enabled: false, stale: false })
      expect(isPublished(m)).toBe(false)
    })

    it('S-9d: a display_name edit of a pruned row keeps the token, and the relisting re-enables it', async () => {
      const m = pick(0)
      await makePruned(m)
      await put(await rowId(m), { enabled: false, display_name: 'Edited' }).expect(200)
      const edited = await row(m)
      expect(edited).toMatchObject({ enabled: false, enabled_managed_by: 'catalog' })
      expect(edited.auto_disabled_at).not.toBeNull()
      await sync(FULL)
      expect((await row(m)).enabled).toBe(true)
      expect(isPublished(m)).toBe(true)
    })

    it('a PUT read before a prune that commits first decides authority on the locked row', async () => {
      const m = pick(0)
      await makeStale(m)
      const id = await rowId(m)
      let edit!: Promise<request.Response>
      const res = await sync(gone(m), {
        hooks: {
          beforeCommit: onceFor(m, async () => {
            // The edit form loaded `enabled: true` and saves it again.
            edit = Promise.resolve(put(id, { enabled: true, display_name: 'Edited' }))
            await untilBlocked(1, 'row')
          }),
        },
      })
      expect(res.pruned).toBe(1)
      expect((await edit).status).toBe(200)
      // `enabled` changed against the locked row (false → true): an operator decision.
      expect(await row(m)).toMatchObject({
        enabled: true,
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
      })
      await sync(gone(m))
      expect((await row(m)).enabled).toBe(true)
    })
  })

  // ── C11: publication before the prune ────────────────────────────────────────

  describe('C11: publication', () => {
    it('S-42: the run’s additions are published before the prune’s locked phase', async () => {
      const [m, added] = [pick(0), pick(1)]
      await sync(gone(added), { noPrune: true })
      await sync(gone(added, m), { noPrune: true })
      expect(isPublished(added)).toBe(false)
      let seenDuringPrune: boolean | undefined
      const res = await sync(gone(m), {
        hooks: { beforeLock: onceFor(m, async () => void (seenDuringPrune = isPublished(added))) },
      })
      expect(res.pruned).toBe(1)
      expect(seenDuringPrune).toBe(true)
      expect(isPublished(added)).toBe(true)
      expect(isPublished(m)).toBe(false)
    })
  })
})
