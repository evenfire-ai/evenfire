import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import type { LlmProviderId } from '@clerum/llm-providers'
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

// The attention feed's R-B filter, its acknowledgement and the consumers it
// counts, on real PostgreSQL through the real routes. Every row comes from a
// producer: the catalog sync (from the captured live models.dev fixture), the
// admin llm-models routes, the codex union rebuild; Hosts, WorkflowRecipes and
// grants go through their admin routes (grants through `upsertGrant`). The
// Kubernetes API is the MockGateway, the only stand-in besides the admin
// session. Assertions are on the feed body the UI reads (T4). Skipped without
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
const ATTENTION_PATH = '/api/v1/admin/attention'
const ACK_PATH = '/api/v1/admin/attention/ack'
const STALE_KIND = 'stale_model_referenced'
const DEPRECATED_KIND = 'deprecated_model_enabled'

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
  return mapCatalogToProviders(catalog)[provider as LlmProviderId]
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

/** FULL with some models dropped and some entries patched (e.g. `status: 'deprecated'`). */
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

const eligible = (provider: CatalogProvider) =>
  discovered(FULL, provider)
    .filter(m => isAutoEnableEligible(m) && m.catalog_status === null)
    .map(m => m.model_id)
const ELIGIBLE = eligible(PROVIDER)
const ELIGIBLE_OTHER = eligible(OTHER)
if (ELIGIBLE.length < 8 || ELIGIBLE_OTHER.length < 8) {
  throw new Error('the live fixture no longer has the models these cases need')
}
const pick = (i: number) => ELIGIBLE[i]!
const pickOther = (i: number) => ELIGIBLE_OTHER[i]!
const deprecate = { status: 'deprecated' } as Partial<RawModelsDevModel>

interface FeedItem {
  kind: string
  provider: string
  model: string
  displayName?: string
  hostsAffected: Array<{ namespace: string; name: string; roles: string[] }>
  grantsAffected: Array<{ id: string; recipeName: string }>
  recipesAffected?: Array<{ namespace: string; name: string }>
  episode: number
  consumerKeys: string[]
  acknowledged?: true
}

describeRealPostgres('attention feed, acknowledgement and consumers (real PostgreSQL)', () => {
  const database = `control_api_attention_${randomBytes(6).toString('hex')}`
  // describe.skip still runs this factory, so it must not build a URL without the env.
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let racePool: Pool
  let gateway: InstanceType<typeof import('./mockGateway.js').MockGateway>
  let hostNs: string
  let recipeNs: string
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    MockGateway: typeof import('./mockGateway.js').MockGateway
    config: typeof import('../src/config.js').config
    advisoryLockModelName: typeof import('../src/db.js').advisoryLockModelName
    syncDiscoveredModels: typeof import('../src/services/llmCatalogSync.js').syncDiscoveredModels
    updateAllowedModel: typeof import('../src/services/llmAllowedModels.js').updateAllowedModel
    setProviderAutoEnable: typeof import('../src/services/llmProviderCatalogSettings.js').setProviderAutoEnable
    rebuildLiveCodexUnionAllowlist: typeof import('../src/services/codexSubscriptionCatalog.js').rebuildLiveCodexUnionAllowlist
    computeModelConsumers: typeof import('../src/services/llmModelConsumers.js').computeModelConsumers
    modelConsumerSourcesFromGateway: typeof import('../src/services/llmModelConsumers.js').modelConsumerSourcesFromGateway
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
    racePool = new Pool({ connectionString })
    racePool.on('error', () => {})

    const appMod = await import('../src/app.js')
    const configMod = await import('../src/config.js')
    const syncMod = await import('../src/services/llmCatalogSync.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const policyMod = await import('../src/services/llmProviderCatalogSettings.js')
    const codexMod = await import('../src/services/codexSubscriptionCatalog.js')
    const consumersMod = await import('../src/services/llmModelConsumers.js')
    const cmMod = await import('../src/services/llmAllowedModelsConfigMap.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      MockGateway,
      config: configMod.config,
      advisoryLockModelName: dbMod.advisoryLockModelName,
      syncDiscoveredModels: syncMod.syncDiscoveredModels,
      updateAllowedModel: allowlistMod.updateAllowedModel,
      setProviderAutoEnable: policyMod.setProviderAutoEnable,
      rebuildLiveCodexUnionAllowlist: codexMod.rebuildLiveCodexUnionAllowlist,
      computeModelConsumers: consumersMod.computeModelConsumers,
      modelConsumerSourcesFromGateway: consumersMod.modelConsumerSourcesFromGateway,
      Writer: cmMod.LlmAllowedModelsConfigMapWriter,
    }
    hostNs = mod.config.hostsNamespace
    recipeNs = mod.config.sandboxNamespace
  }, 60_000)

  afterAll(async () => {
    try {
      if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
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
    `)
    gateway = new mod.MockGateway()
    await mod.setProviderAutoEnable(PROVIDER, true, 'test-admin', corePool)
    await mod.setProviderAutoEnable(OTHER, true, 'test-admin', corePool)
  })

  // ── producers ────────────────────────────────────────────────────────────────

  function sync(catalog: RawModelsDevCatalog): Promise<CatalogSyncResult> {
    return mod.syncDiscoveredModels(
      {
        materializer: new mod.Writer(new FakeConfigMapApi() as never, 'mcp-host', 3, corePool),
        loadCatalog: loadStub(catalog, 'live', LIVE_MODELS_DEV_CAPTURED_AT),
        minPlausibleLiveTotal: 1,
        autoEnableMaxPerProviderPerRun: 1_000,
        autoEnableMaxPerRun: 10_000,
      },
      corePool as unknown as SyncConnector
    )
  }

  const app = () => mod.createApp(gateway)

  async function feed(includeAcknowledged = false): Promise<FeedItem[]> {
    const res = await request(app())
      .get(includeAcknowledged ? `${ATTENTION_PATH}?includeAcknowledged=1` : ATTENTION_PATH)
      .set('Cookie', COOKIE)
      .expect(200)
    return res.body.items as FeedItem[]
  }

  async function itemsFor(model: string, includeAcknowledged = false): Promise<FeedItem[]> {
    return (await feed(includeAcknowledged)).filter(i => i.model === model)
  }

  async function itemOf(kind: string, model: string): Promise<FeedItem> {
    const found = (await itemsFor(model)).find(i => i.kind === kind)
    expect(found, `${kind} ${model}`).toBeDefined()
    return found!
  }

  /** Acknowledge with exactly what the feed served for the item (as the UI does). */
  function ack(item: FeedItem) {
    return request(app()).post(ACK_PATH).set('Cookie', COOKIE).send({
      provider: item.provider,
      model: item.model,
      kind: item.kind,
      episode: item.episode,
      consumerKeys: item.consumerKeys,
    })
  }

  function unack(item: Pick<FeedItem, 'provider' | 'model' | 'kind'>) {
    return request(app())
      .delete(ACK_PATH)
      .set('Cookie', COOKIE)
      .send({ provider: item.provider, model: item.model, kind: item.kind })
  }

  /** A Host that names only `model` (primary + one-entry subset): explicit, never all-models. */
  async function subsetHost(name: string, model: string, provider: string = PROVIDER) {
    await request(app())
      .post('/api/v1/admin/hosts')
      .set('Cookie', COOKIE)
      .send({
        metadata: { name },
        spec: { model: { provider, name: model }, allowedModels: [{ provider, model }] },
      })
      .expect(201)
  }

  /** A Host with no subset: offers every enabled model of its provider. */
  async function allModelsHost(name: string, model: string, provider: string = PROVIDER) {
    await request(app())
      .post('/api/v1/admin/hosts')
      .set('Cookie', COOKIE)
      .send({ metadata: { name }, spec: { model: { provider, name: model } } })
      .expect(201)
  }

  async function deleteHost(name: string) {
    await request(app())
      .delete(`/api/v1/admin/hosts/${name}`)
      .set('Cookie', COOKIE)
      .expect(res => expect([200, 204]).toContain(res.status))
  }

  async function recipe(name: string, spec: Record<string, unknown>) {
    await request(app())
      .post('/api/v1/admin/recipes')
      .set('Cookie', COOKIE)
      .send({
        metadata: { name },
        spec: { triggers: { onDemand: { allowedActors: ['user'] } }, ...spec },
      })
      .expect(res => expect(res.status, JSON.stringify(res.body)).toBe(201))
  }

  const agentRecipe = (name: string, model: string, provider: string = PROVIDER) =>
    recipe(name, { agent: { provider, model }, steps: [{ id: 's1', instruction: 'go' }] })

  function grantBody(recipeName: string, model: string, allowedModels: string[] = []) {
    return {
      recipeNamespace: recipeNs,
      recipeName,
      capabilityFamily: 'promptBridge',
      provider: PROVIDER,
      allowedModels,
      promptTargets: [
        { targetRef: 'primary', provider: PROVIDER, model, credentialSlot: 'openai-api-key' },
      ],
      defaultTargetRef: 'primary',
      allowedCallers: ['api'],
    }
  }

  async function promptTargetGrant(recipeName: string, model: string): Promise<string> {
    const res = await request(app())
      .post('/api/v1/admin/plugin-workload-sdk/grants')
      .set('Cookie', COOKIE)
      .send(grantBody(recipeName, model))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { rows } = await corePool.query<{ id: string }>(
      `SELECT id FROM plugin_workload_sdk_grants WHERE recipe_name = $1`,
      [recipeName]
    )
    return rows[0]!.id
  }

  async function rowId(provider: string, model: string): Promise<string> {
    const { rows } = await corePool.query<{ id: string }>(
      `SELECT id FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
      [provider, model]
    )
    expect(rows, `${provider}/${model}`).toHaveLength(1)
    return rows[0]!.id
  }

  function put(id: string, body: Record<string, unknown>, query = '') {
    return request(app()).put(`${MODELS_PATH}/${id}${query}`).set('Cookie', COOKIE).send(body)
  }

  const hostKey = (name: string) => `host:${hostNs}/${name}`

  /** A stale (gone from the catalog) enabled openai model. */
  async function staleModel(model: string) {
    await sync(FULL)
    await sync(catalogWith({ gone: [model] }))
  }

  // ── I-V2 ─────────────────────────────────────────────────────────────────────

  describe('I-V2: the feed is exactly the R-B predicate over the rows and their consumers', () => {
    it('default and includeAcknowledged feeds match the reference model case by case', async () => {
      // OTHER (claude) has no all-models Host, so its consumers are exactly the
      // explicit ones listed here. PROVIDER (openai) gets one all-models Host,
      // so every one of its models has K4.
      const C = {
        staleNone: pickOther(0),
        staleExplicit: pickOther(1),
        staleExplicitAcked: pickOther(2),
        deprecatedNone: pickOther(3),
        deprecatedExplicit: pickOther(4),
        deprecatedExplicitAcked: pickOther(5),
        staleDisabledExplicit: pickOther(6),
        staleAndDeprecatedExplicit: pickOther(7),
      }
      const O = { staleK4: pick(0), deprecatedK4: pick(1), host: pick(2) }
      const goneOther = [
        C.staleNone,
        C.staleExplicit,
        C.staleExplicitAcked,
        C.staleDisabledExplicit,
      ]
      const deprecatedOther = [
        C.deprecatedNone,
        C.deprecatedExplicit,
        C.deprecatedExplicitAcked,
        C.staleAndDeprecatedExplicit,
      ]
      const explicit = new Set<string>([
        C.staleExplicit,
        C.staleExplicitAcked,
        C.deprecatedExplicit,
        C.deprecatedExplicitAcked,
        C.staleDisabledExplicit,
        C.staleAndDeprecatedExplicit,
      ])

      await sync(FULL)
      for (const m of explicit)
        await subsetHost(`h-${m.replace(/[^a-z0-9]/g, '')}`.slice(0, 60), m, OTHER)
      await allModelsHost('all-openai', O.host)
      // Deprecate first (and make one of those stale in the next run as well).
      await sync(
        catalogWith(
          { provider: OTHER, patch: Object.fromEntries(deprecatedOther.map(m => [m, deprecate])) },
          { provider: PROVIDER, patch: { [O.deprecatedK4]: deprecate } }
        )
      )
      await sync(
        catalogWith(
          {
            provider: OTHER,
            gone: [...goneOther, C.staleAndDeprecatedExplicit],
            patch: Object.fromEntries(
              deprecatedOther
                .filter(m => m !== C.staleAndDeprecatedExplicit)
                .map(m => [m, deprecate])
            ),
          },
          { provider: PROVIDER, gone: [O.staleK4], patch: { [O.deprecatedK4]: deprecate } }
        )
      )
      await put(
        await rowId(OTHER, C.staleDisabledExplicit),
        { enabled: false },
        '?force=true'
      ).expect(200)
      await ack(await itemOf(STALE_KIND, C.staleExplicitAcked)).expect(200)
      await ack(await itemOf(DEPRECATED_KIND, C.deprecatedExplicitAcked)).expect(200)
      const acked = new Set([
        `${STALE_KIND}:${C.staleExplicitAcked}`,
        `${DEPRECATED_KIND}:${C.deprecatedExplicitAcked}`,
      ])

      // Reference model: row state read back from what the producers wrote,
      // consumers from the setup above.
      const { rows } = await corePool.query<{
        provider: string
        model: string
        enabled: boolean
        stale: boolean
        deprecated: boolean
      }>(
        `SELECT provider, model, enabled, stale, (catalog_status = 'deprecated') IS TRUE AS deprecated
           FROM llm_allowed_models WHERE provider = ANY($1::text[])`,
        [[PROVIDER, OTHER]]
      )
      const expected = { pending: new Set<string>(), acknowledged: new Set<string>() }
      for (const row of rows) {
        const k4 = row.provider === PROVIDER
        const hasExplicit = row.provider === OTHER && explicit.has(row.model)
        const candidates: string[] = []
        if (row.enabled && row.stale && (hasExplicit || k4)) candidates.push(STALE_KIND)
        if (row.enabled && row.deprecated && hasExplicit) candidates.push(DEPRECATED_KIND)
        for (const kind of candidates) {
          const id = `${kind}:${row.model}`
          ;(acked.has(id) ? expected.acknowledged : expected.pending).add(id)
        }
      }
      // The table is not vacuous: every case the predicate distinguishes occurs.
      expect(expected.pending).toEqual(
        new Set([
          `${STALE_KIND}:${C.staleExplicit}`,
          `${STALE_KIND}:${C.staleAndDeprecatedExplicit}`,
          `${STALE_KIND}:${O.staleK4}`,
          `${DEPRECATED_KIND}:${C.deprecatedExplicit}`,
          `${DEPRECATED_KIND}:${C.staleAndDeprecatedExplicit}`,
        ])
      )

      const ids = (items: FeedItem[]) => items.map(i => `${i.kind}:${i.model}`)
      const pending = await feed()
      expect(new Set(ids(pending))).toEqual(expected.pending)
      expect(ids(pending)).toHaveLength(expected.pending.size)
      expect(pending.every(i => i.acknowledged === undefined)).toBe(true)
      expect(pending.map(i => i.kind)).not.toContain('stale_discovery_enabled')

      const all = await feed(true)
      expect(new Set(ids(all))).toEqual(new Set([...expected.pending, ...expected.acknowledged]))
      expect(new Set(ids(all.filter(i => i.acknowledged === true)))).toEqual(expected.acknowledged)

      // The K4-only stale item names its Host with the implicit role and has no
      // fingerprint: an implicit offer is nobody's explicit consumer.
      expect(pending.find(i => i.model === O.staleK4)).toMatchObject({
        hostsAffected: [{ namespace: hostNs, name: 'all-openai', roles: ['implicit'] }],
        consumerKeys: [],
      })
    }, 60_000)
  })

  // ── C5 · R-B filter ──────────────────────────────────────────────────────────

  describe('R-B filter', () => {
    it('S-11: a deprecated model without explicit consumers is hidden; a new Host shows it at the next read', async () => {
      const d = pick(0)
      await sync(FULL)
      await sync(catalogWith({ patch: { [d]: deprecate } }))
      // An all-models Host offering it does not count for a deprecated model.
      await allModelsHost('all-models', pick(1))
      expect(await itemsFor(d)).toEqual([])

      await subsetHost('uses-d', d)
      expect(await itemsFor(d)).toEqual([
        {
          kind: DEPRECATED_KIND,
          provider: PROVIDER,
          model: d,
          displayName: expect.any(String),
          // Same reference body as a stale item: the all-models Host is shown,
          // it just does not make the deprecated model an item on its own.
          hostsAffected: [
            { namespace: hostNs, name: 'uses-d', roles: ['primary', 'allowedModels'] },
            { namespace: hostNs, name: 'all-models', roles: ['implicit'] },
          ],
          grantsAffected: [],
          episode: 1,
          consumerKeys: [hostKey('uses-d')],
        },
      ])
    })

    it('S-21: pinning a stale model on keeps its item until it is acknowledged', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      await put(await rowId(PROVIDER, s), { enabled: true, pinEnabled: true }).expect(200)
      const item = await itemOf(STALE_KIND, s)

      await ack(item).expect(200)
      expect(await itemsFor(s)).toEqual([])
    })

    it('S-22: an all-models Host of a subscription provider does not make its stale model an item', async () => {
      const model = `gpt-sub-${randomBytes(3).toString('hex')}`
      const created = await request(app())
        .post(MODELS_PATH)
        .set('Cookie', COOKIE)
        .send({ provider: 'codex-subscription', model, enabled: true })
        .expect(201)
      // The union rebuild with no live connection marks the row stale and off;
      // the operator then turns it back on (the state the materializer filters).
      await mod.rebuildLiveCodexUnionAllowlist(corePool as never)
      await put(created.body.id, { enabled: true }).expect(200)
      await gateway.createResource(
        'hosts',
        {
          metadata: { name: 'codex-all' },
          spec: { model: { provider: 'codex-subscription', name: model } },
        },
        hostNs
      )
      // Its primary names the model: explicit. A second all-models codex Host
      // that names another model offers it only implicitly — not counted.
      expect((await itemsFor(model)).map(i => i.hostsAffected)).toEqual([
        [{ namespace: hostNs, name: 'codex-all', roles: ['primary'] }],
      ])
      await deleteHost('codex-all')
      await gateway.createResource(
        'hosts',
        {
          metadata: { name: 'codex-other' },
          spec: { model: { provider: 'codex-subscription', name: 'gpt-other' } },
        },
        hostNs
      )
      expect(await itemsFor(model)).toEqual([])
    })
  })

  // ── C10 · acknowledgement ────────────────────────────────────────────────────

  describe('acknowledgement', () => {
    it('S-23: an acknowledged item leaves the default feed and is listed as acknowledged on request', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      const item = await itemOf(STALE_KIND, s)

      const res = await ack(item).expect(200)
      expect(res.body).toMatchObject({
        kind: STALE_KIND,
        episode: item.episode,
        consumerKeys: item.consumerKeys,
      })
      expect(await itemsFor(s)).toEqual([])
      expect(await itemsFor(s, true)).toEqual([{ ...item, acknowledged: true }])
      const audit = await corePool.query(
        `SELECT actor, detail FROM llm_allowed_models_audit WHERE action = 'attention_ack' AND model = $1`,
        [s]
      )
      expect(audit.rows).toEqual([
        {
          actor: ADMIN_CLAIMS.sub,
          detail: { kind: STALE_KIND, episode: 1, consumerKeys: [hostKey('uses-s')] },
        },
      ])
    })

    it('S-27b: the episode the route serves is a JSON integer, and sending it back acknowledges', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      const raw = await request(app()).get(ATTENTION_PATH).set('Cookie', COOKIE).expect(200)
      const item = (raw.body.items as FeedItem[]).find(i => i.model === s)!
      expect(Number.isInteger(item.episode)).toBe(true)
      expect(raw.text).toContain(`"episode":${item.episode},`)

      await ack(item).expect(200)
      expect(await itemsFor(s)).toEqual([])
    })

    it('S-24: the model coming back and vanishing again opens an episode and reopens the item', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      await ack(await itemOf(STALE_KIND, s)).expect(200)

      await sync(FULL)
      expect(await itemsFor(s)).toEqual([])
      await sync(catalogWith({ gone: [s] }))
      expect(await itemsFor(s)).toEqual([expect.objectContaining({ kind: STALE_KIND, episode: 2 })])
    })

    it('S-29: a deprecated model undeprecated and deprecated again reopens its item', async () => {
      const d = pick(0)
      await sync(FULL)
      await sync(catalogWith({ patch: { [d]: deprecate } }))
      await subsetHost('uses-d', d)
      await ack(await itemOf(DEPRECATED_KIND, d)).expect(200)
      expect(await itemsFor(d)).toEqual([])

      await sync(FULL)
      await sync(catalogWith({ patch: { [d]: deprecate } }))
      expect(await itemsFor(d)).toEqual([
        expect.objectContaining({ kind: DEPRECATED_KIND, episode: 2 }),
      ])
    })

    it('S-29b: a model inserted already deprecated and enabled later is at episode 1 and acknowledgeable', async () => {
      const d = pick(0)
      await sync(catalogWith({ patch: { [d]: deprecate } }))
      await put(await rowId(PROVIDER, d), { enabled: true }).expect(200)
      await subsetHost('uses-d', d)
      const item = await itemOf(DEPRECATED_KIND, d)
      expect(item.episode).toBe(1)

      await ack(item).expect(200)
      expect(await itemsFor(d)).toEqual([])
    })

    it('S-29c: a GA model (NULL status) the catalog deprecates opens episode 1, and re-entry another', async () => {
      const d = pick(0)
      await sync(FULL)
      await subsetHost('uses-d', d)
      await sync(catalogWith({ patch: { [d]: deprecate } }))
      const item = await itemOf(DEPRECATED_KIND, d)
      expect(item.episode).toBe(1)
      await ack(item).expect(200)

      await sync(FULL)
      await sync(catalogWith({ patch: { [d]: deprecate } }))
      expect((await itemOf(DEPRECATED_KIND, d)).episode).toBe(2)
    })

    it.each(['host', 'grant', 'recipe'] as const)(
      'S-25: a new explicit %s consumer after the acknowledgement reopens the item',
      async consumer => {
        const s = pick(0)
        await sync(FULL)
        // The grant must be created while the model is not stale (no warning path needed).
        if (consumer === 'grant') await subsetHost('uses-s', s)
        await sync(catalogWith({ gone: [s] }))
        if (consumer !== 'grant') await subsetHost('uses-s', s)
        await ack(await itemOf(STALE_KIND, s)).expect(200)
        expect(await itemsFor(s)).toEqual([])

        let newKey: string
        if (consumer === 'host') {
          await subsetHost('uses-s-too', s)
          newKey = hostKey('uses-s-too')
        } else if (consumer === 'grant') {
          newKey = `grant:${await promptTargetGrant('sdk-recipe', s)}`
        } else {
          await agentRecipe('uses-s-recipe', s)
          newKey = `recipe:${recipeNs}/uses-s-recipe`
        }
        const [item] = await itemsFor(s)
        expect(item).toMatchObject({ kind: STALE_KIND })
        expect(item!.consumerKeys).toEqual([hostKey('uses-s'), newKey].sort())
      }
    )

    it('S-26: removing an explicit consumer after the acknowledgement keeps the item hidden', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      await subsetHost('uses-s-too', s)
      await ack(await itemOf(STALE_KIND, s)).expect(200)

      await deleteHost('uses-s-too')
      expect(await itemsFor(s)).toEqual([])
      expect(await itemsFor(s, true)).toEqual([
        expect.objectContaining({ consumerKeys: [hostKey('uses-s')], acknowledged: true }),
      ])
    })

    it('S-26b: a new all-models Host after the acknowledgement keeps the item hidden', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      await ack(await itemOf(STALE_KIND, s)).expect(200)

      await allModelsHost('all-models', pick(1))
      expect(await itemsFor(s)).toEqual([])
      expect((await itemsFor(s, true))[0]!.hostsAffected).toContainEqual({
        namespace: hostNs,
        name: 'all-models',
        roles: ['implicit'],
      })
    })

    it('S-27: an episode that moved on between the feed and the click is a 409 and acknowledges nothing', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      const seen = await itemOf(STALE_KIND, s)

      await sync(FULL)
      await sync(catalogWith({ gone: [s] }))
      const res = await ack(seen).expect(409)
      expect(res.body.error).toBe('attention_episode_changed')
      expect(await itemsFor(s)).toEqual([expect.objectContaining({ episode: seen.episode + 1 })])
      const audit = await corePool.query(
        `SELECT 1 FROM llm_allowed_models_audit WHERE action = 'attention_ack'`
      )
      expect(audit.rows).toEqual([])
    })

    it('S-27: a model disabled since the feed was loaded is a 409', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      const seen = await itemOf(STALE_KIND, s)
      await put(await rowId(PROVIDER, s), { enabled: false }, '?force=true').expect(200)
      expect((await ack(seen).expect(409)).body.error).toBe('attention_episode_changed')
    })

    it('S-28: a consumer added between the feed and the click is not accepted unseen', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      const seen = await itemOf(STALE_KIND, s)

      await subsetHost('arrived-late', s)
      await ack(seen).expect(200)
      expect(await itemsFor(s)).toEqual([
        expect.objectContaining({
          consumerKeys: [hostKey('arrived-late'), hostKey('uses-s')].sort(),
        }),
      ])
    })

    it('S-31: undoing an acknowledgement brings the item back, and undoing nothing is a no-op', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      const item = await itemOf(STALE_KIND, s)
      await ack(item).expect(200)

      await unack(item).expect(204)
      expect(await itemsFor(s)).toEqual([item])
      await unack(item).expect(204)
      const audit = await corePool.query(
        `SELECT detail FROM llm_allowed_models_audit WHERE action = 'attention_unack'`
      )
      expect(audit.rows).toEqual([{ detail: { kind: STALE_KIND } }])
    })

    it('S-39: a kind outside the closed map, or any unknown field, is a 400 that writes nothing', async () => {
      const s = pick(0)
      await staleModel(s)
      await subsetHost('uses-s', s)
      const item = await itemOf(STALE_KIND, s)
      const body = {
        provider: PROVIDER,
        model: s,
        kind: STALE_KIND,
        episode: item.episode,
        consumerKeys: [],
      }
      for (const bad of [
        { ...body, kind: 'stale_discovery_enabled' },
        { ...body, kind: 'stale_episode = stale_episode; --' },
        { ...body, extra: true },
        { ...body, episode: 1.5 },
        { ...body, consumerKeys: Array.from({ length: 2_001 }, (_, i) => `host:x/${i}`) },
        { ...body, consumerKeys: ['x'.repeat(401)] },
      ]) {
        await request(app()).post(ACK_PATH).set('Cookie', COOKIE).send(bad).expect(400)
      }
      await ack(item).expect(200)
      for (const bad of [
        { provider: PROVIDER, model: s, kind: 'stale_discovery_enabled' },
        { provider: PROVIDER, model: s, kind: STALE_KIND, episode: 1 },
      ]) {
        await request(app()).delete(ACK_PATH).set('Cookie', COOKIE).send(bad).expect(400)
      }
      expect(await itemsFor(s)).toEqual([])
      const audit = await corePool.query(
        `SELECT action FROM llm_allowed_models_audit WHERE action LIKE 'attention_%'`
      )
      expect(audit.rows).toEqual([{ action: 'attention_ack' }])
    })

    it('the ack routes require the admin session', async () => {
      await request(app()).post(ACK_PATH).send({}).expect(401)
      await request(app()).delete(ACK_PATH).send({}).expect(401)
    })

    it('S-41: a rename on a subscription provider drops the acknowledgement of the old pair', async () => {
      // The rename keeps `stale` and the episode on a subscription row, so an
      // acknowledgement left on it would hide the new pair's item.
      const oldModel = `gpt-sub-${randomBytes(3).toString('hex')}`
      const newModel = `${oldModel}-renamed`
      const created = await request(app())
        .post(MODELS_PATH)
        .set('Cookie', COOKIE)
        .send({ provider: 'codex-subscription', model: oldModel, enabled: true })
        .expect(201)
      await mod.rebuildLiveCodexUnionAllowlist(corePool as never)
      await put(created.body.id, { enabled: true }).expect(200)
      // One recipe names both: same consumer key before and after the rename.
      // Recipes match by model name only, and a codex-subscription recipe needs
      // a ChatGPT grant, so the names ride on another provider's agent.
      await recipe('codex-recipe', {
        agent: { provider: PROVIDER, model: oldModel },
        steps: [{ id: 's1', instruction: 'go', agent: { provider: PROVIDER, model: newModel } }],
      })
      const item = await itemOf(STALE_KIND, oldModel)
      expect(item.consumerKeys).toEqual([`recipe:${recipeNs}/codex-recipe`])
      await ack(item).expect(200)
      expect(await itemsFor(oldModel)).toEqual([])

      await put(created.body.id, { model: newModel }).expect(200)
      expect(await itemsFor(newModel)).toEqual([
        expect.objectContaining({
          kind: STALE_KIND,
          episode: item.episode,
          consumerKeys: [`recipe:${recipeNs}/codex-recipe`],
        }),
      ])
    })
  })

  // ── C4 · consumers ───────────────────────────────────────────────────────────

  describe('computeModelConsumers', () => {
    const consumersOf = (provider: string, model: string) =>
      mod.computeModelConsumers(
        provider,
        model,
        mod.modelConsumerSourcesFromGateway(gateway as never, {
          hostNamespaces: Array.from(new Set([mod.config.hostsNamespace, mod.config.namespace])),
          recipeNamespaces: [mod.config.sandboxNamespace],
        })
      )

    it('S-18 basis: K7 recipes name the model in any of the four places WRC resolves', async () => {
      const m = pick(0)
      await sync(FULL)
      await agentRecipe('agent-default', m)
      await recipe('step-agent', {
        agent: { provider: PROVIDER, model: pick(1) },
        steps: [{ id: 's1', instruction: 'go', agent: { provider: PROVIDER, model: m } }],
      })
      await recipe('bridge', {
        agent: { provider: PROVIDER, model: pick(1) },
        pluginWorkloadSdk: { promptBridge: { allowedModels: [m] } },
        steps: [{ id: 's1', instruction: 'go' }],
      })
      await recipe('snippet-bridge', {
        steps: [
          {
            id: 's1',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return {}',
              capabilities: { pluginWorkloadSdk: { promptBridge: { allowedModels: [m] } } },
            },
          },
        ],
      })
      await agentRecipe('other-model', pick(1))

      const consumers = await consumersOf(PROVIDER, m)
      expect(consumers.explicit).toBe(true)
      expect(consumers.recipes.map(r => r.name).sort()).toEqual(
        ['agent-default', 'bridge', 'snippet-bridge', 'step-agent'].sort()
      )
      expect(consumers.recipes.every(r => r.namespace === recipeNs)).toBe(true)
      // Name-only: the same id under another provider still counts.
      expect((await consumersOf(OTHER, m)).recipes).toHaveLength(4)
    })

    it('a per-run child recipe is reported as its parent', async () => {
      const m = pick(0)
      await sync(FULL)
      await agentRecipe('scheduled', m)
      const [parent] = (await gateway.listResource('workflowrecipes', recipeNs)) as Array<{
        metadata: { name: string; uid: string }
        spec: Record<string, unknown>
      }>
      // The workflow-recipes child factory (buildChildRecipe) is not importable
      // from control-api; this mirrors the metadata it writes: the parent label
      // plus the controller ownerReference.
      const child = (name: string, owned: boolean, uid = parent!.metadata.uid) => ({
        metadata: {
          name,
          labels: { 'clerum.io/parent-recipe': 'scheduled', 'clerum.io/managed-by': 'clerum-wrc' },
          ownerReferences: owned
            ? [
                {
                  apiVersion: 'clerum.io/v1alpha1',
                  kind: 'WorkflowRecipe',
                  name: 'scheduled',
                  uid,
                  controller: true,
                  blockOwnerDeletion: true,
                },
              ]
            : [],
        },
        spec: parent!.spec,
      })
      await gateway.createResource(
        'workflowrecipes',
        child('scheduled-20261112-0001', true),
        recipeNs
      )
      await gateway.createResource(
        'workflowrecipes',
        child('scheduled-20261112-0002', true),
        recipeNs
      )
      expect((await consumersOf(PROVIDER, m)).recipes).toEqual([
        { namespace: recipeNs, name: 'scheduled' },
      ])

      // A label without the ownerReference is author-writable: not trusted.
      await gateway.createResource('workflowrecipes', child('forged', false), recipeNs)
      expect((await consumersOf(PROVIDER, m)).recipes.map(r => r.name).sort()).toEqual([
        'forged',
        'scheduled',
      ])

      // Label and controller ownerReference, but not owned by the live parent
      // (a recreated parent, or a forged reference): its own key.
      await gateway.createResource(
        'workflowrecipes',
        child('stale-owner', true, 'uid-of-another-recipe'),
        recipeNs
      )
      expect((await consumersOf(PROVIDER, m)).recipes.map(r => r.name).sort()).toEqual([
        'forged',
        'scheduled',
        'stale-owner',
      ])
    })

    it('K6: a prompt-target grant is a grant consumer of its exact pair', async () => {
      const m = pick(0)
      await sync(FULL)
      const id = await promptTargetGrant('sdk-recipe', m)
      expect((await consumersOf(PROVIDER, m)).impact.grantsAffected.map(g => g.id)).toEqual([id])
      expect((await consumersOf(OTHER, m)).impact.grantsAffected).toEqual([])
    })

    it('K4: only a Host without a subset, of the same catalog provider, offers the model implicitly', async () => {
      const m = pick(0)
      await sync(FULL)
      await allModelsHost('all-openai', pick(1))
      await subsetHost('subset-openai', pick(2))
      await allModelsHost('all-claude', pickOther(0), OTHER)
      const consumers = await consumersOf(PROVIDER, m)
      expect(consumers.implicitHosts).toEqual([{ namespace: hostNs, name: 'all-openai' }])
      expect(consumers.explicit).toBe(false)
      // A Host that also names the model is explicit, not repeated as implicit.
      expect((await consumersOf(PROVIDER, pick(1))).implicitHosts).toEqual([])
    })
  })

  // ── C6 · prompt-target lock ──────────────────────────────────────────────────

  describe('S-5: the grant upsert locks prompt-target models', () => {
    it('a disable that commits while the upsert waits rejects the grant (no grant on an off model)', async () => {
      const m = pick(0)
      await sync(FULL)
      const id = await rowId(PROVIDER, m)
      const rClient = await racePool.connect()
      let grantDone!: Promise<request.Response>
      try {
        await rClient.query('BEGIN')
        await mod.advisoryLockModelName(rClient as never, m)
        await mod.updateAllowedModel(id, { enabled: false }, 'test-reductor', rClient as never)
        // `m` is only a prompt target: allowed_models stays empty.
        grantDone = Promise.resolve(
          request(app())
            .post('/api/v1/admin/plugin-workload-sdk/grants')
            .set('Cookie', COOKIE)
            .send(grantBody('raced', m))
        )
        const deadline = Date.now() + 1_500
        while (Date.now() < deadline) {
          const { rows } = await corePool.query(`SELECT 1 FROM plugin_workload_sdk_grants`)
          if (rows.length > 0) break
          await new Promise(r => setTimeout(r, 25))
        }
        await rClient.query('COMMIT')
      } finally {
        rClient.release()
      }
      const res = await grantDone
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error).toBe('model_not_allowed')
      const { rows } = await corePool.query(`SELECT 1 FROM plugin_workload_sdk_grants`)
      expect(rows).toEqual([])
    }, 30_000)
  })
})
