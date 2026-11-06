import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { type LlmProviderId, PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import type { CatalogSyncResult, SyncConnector } from '../src/services/llmCatalogSync.js'
import {
  type DiscoveredModel,
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  type RawModelsDevModel,
  autoEnableRejection,
  isAutoEnableEligible,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { FakeConfigMapApi } from './helpers/fakeAllowlistCluster.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  LIVE_MODELS_DEV_CATALOG,
  loadStub,
  trimLiveCatalog,
  trimSnapshot,
} from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// The catalog sync deciding `enabled` on INSERT, against REAL PostgreSQL: the
// tombstone read inside the INSERT under READ COMMITTED, the partial-index
// ON CONFLICT of the catalog price, the id+pair guard of the refresh UPDATEs,
// and concurrent admin writes on independent sessions. Catalogs come from the
// captured live api.json fixture; which models are eligible is decided by the
// real predicate over that data, never by naming ids. Admin mutations go
// through the real router or the real service functions. Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

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

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

type CatalogProvider = keyof typeof PROVIDER_KEY_MAP
type QueryResult = { rows: unknown[]; rowCount: number | null }

interface DbRow {
  id: string
  provider: string
  model: string
  enabled: boolean
  source: string
  stale: boolean
  catalog_status: string | null
  image_input: unknown
}

/** Every model of the given providers, straight from the captured live catalog. */
function wholeLiveProviders(providers: CatalogProvider[]): RawModelsDevCatalog {
  return trimLiveCatalog(
    Object.fromEntries(
      providers.map(p => {
        const key = PROVIDER_KEY_MAP[p]
        return [key, Object.keys(LIVE_MODELS_DEV_CATALOG[key].models).length]
      })
    )
  )
}

/** The catalog with ONE field of ONE real entry altered (out-of-domain cases). */
function withEntryField(
  catalog: RawModelsDevCatalog,
  provider: CatalogProvider,
  rawId: string,
  patch: Partial<RawModelsDevModel>
): RawModelsDevCatalog {
  const key = PROVIDER_KEY_MAP[provider]
  const entry = catalog[key]?.models[rawId]
  if (!entry) throw new Error(`withEntryField: ${provider}/${rawId} not in catalog`)
  return {
    ...catalog,
    [key]: { ...catalog[key], models: { ...catalog[key].models, [rawId]: { ...entry, ...patch } } },
  }
}

/** The catalog without some entries of one provider. */
function withoutEntries(
  catalog: RawModelsDevCatalog,
  provider: CatalogProvider,
  rawIds: string[]
): RawModelsDevCatalog {
  const key = PROVIDER_KEY_MAP[provider]
  const models = { ...catalog[key].models }
  for (const id of rawIds) delete models[id]
  return { ...catalog, [key]: { ...catalog[key], models } }
}

/** What the real mapper makes of a catalog, for one provider. */
function discoveredOf(catalog: RawModelsDevCatalog, provider: CatalogProvider): DiscoveredModel[] {
  return mapCatalogToProviders(catalog)[provider as LlmProviderId]
}

/** Raw entry id whose mapped model id is `modelId` (they can differ by normalization). */
function rawIdOf(catalog: RawModelsDevCatalog, provider: CatalogProvider, modelId: string): string {
  const key = PROVIDER_KEY_MAP[provider]
  for (const rawId of Object.keys(catalog[key].models)) {
    const [d] = mapCatalogToProviders({
      [key]: { name: catalog[key].name, models: { [rawId]: catalog[key].models[rawId] } },
    })[provider as LlmProviderId]
    if (d?.model_id === modelId) return rawId
  }
  throw new Error(`rawIdOf: ${provider}/${modelId} not in catalog`)
}

function first<T>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const found = items.find(predicate)
  if (!found) throw new Error(`fixture has no ${label}`)
  return found
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The order in which candidates take the auto-enable cap, written out here as
 * the reference: newest `release_date` first (compared as text, by code
 * units), undated last, then `model_id` ascending.
 */
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

const ids = (models: DiscoveredModel[]) => models.map(m => m.model_id)

/** No lone surrogate: `encodeURIComponent` throws on exactly those. */
function isWellFormedUtf16(s: string): boolean {
  try {
    encodeURIComponent(s)
    return true
  } catch {
    return false
  }
}

describeRealPostgres('catalog sync auto-enable on insert (real PostgreSQL)', () => {
  const database = `control_api_auto_enable_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let racePool: Pool
  let cluster: FakeConfigMapApi
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    MockGateway: typeof import('./mockGateway.js').MockGateway
    syncDiscoveredModels: typeof import('../src/services/llmCatalogSync.js').syncDiscoveredModels
    getLastCatalogSyncRun: typeof import('../src/services/llmCatalogSync.js').getLastCatalogSyncRun
    createAllowedModel: typeof import('../src/services/llmAllowedModels.js').createAllowedModel
    createLlmPrice: typeof import('../src/services/llmPrices.js').createLlmPrice
    setProviderAutoEnable: typeof import('../src/services/llmProviderCatalogSettings.js').setProviderAutoEnable
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
    const syncMod = await import('../src/services/llmCatalogSync.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const pricesMod = await import('../src/services/llmPrices.js')
    const policyMod = await import('../src/services/llmProviderCatalogSettings.js')
    const cmMod = await import('../src/services/llmAllowedModelsConfigMap.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      MockGateway,
      syncDiscoveredModels: syncMod.syncDiscoveredModels,
      getLastCatalogSyncRun: syncMod.getLastCatalogSyncRun,
      createAllowedModel: allowlistMod.createAllowedModel,
      createLlmPrice: pricesMod.createLlmPrice,
      setProviderAutoEnable: policyMod.setProviderAutoEnable,
      Writer: cmMod.LlmAllowedModelsConfigMapWriter,
    }
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
    // initDb seeds no catalog; this clears what earlier cases wrote, so every
    // case starts from an empty installation.
    await corePool.query(`
      DELETE FROM llm_allowed_models;
      DELETE FROM llm_catalog_dismissed;
      DELETE FROM llm_model_prices;
      DELETE FROM llm_provider_catalog_settings;
      DELETE FROM llm_catalog_sync_runs;
    `)
    cluster = new FakeConfigMapApi()
  })

  function app() {
    return mod.createApp(new mod.MockGateway())
  }

  function sync(
    catalog: RawModelsDevCatalog,
    opts: {
      source?: 'live' | 'vendored'
      implausible?: boolean
      maxPerProvider?: number
      maxPerRun?: number
      providerMinLive?: number
      connector?: SyncConnector
    } = {}
  ): Promise<CatalogSyncResult> {
    return mod.syncDiscoveredModels(
      {
        materializer: new mod.Writer(cluster as never, 'mcp-host', 3, corePool),
        loadCatalog: loadStub(catalog, opts.source ?? 'live', LIVE_MODELS_DEV_CAPTURED_AT),
        minPlausibleLiveTotal: opts.implausible ? 1_000_000 : 1,
        // The production caps are far above any single provider of the fixture;
        // T-H24 passes small ones.
        autoEnableMaxPerProviderPerRun: opts.maxPerProvider ?? 1_000,
        autoEnableMaxPerRun: opts.maxPerRun ?? 10_000,
        ...(opts.providerMinLive === undefined ? {} : { providerMinLive: opts.providerMinLive }),
      },
      opts.connector ?? (corePool as unknown as SyncConnector)
    )
  }

  /**
   * The pool, with `around` wrapped over every statement the sync issues on its
   * transaction client: the seam where another session's commit is placed
   * between two of the sync's statements.
   */
  function intercepting(
    around: (
      sql: string,
      params: unknown[],
      run: () => Promise<QueryResult>
    ) => Promise<QueryResult>
  ): SyncConnector {
    return {
      connect: async () => {
        const client = await corePool.connect()
        return {
          query: (sql: string, params?: unknown[]) =>
            around(sql, params ?? [], () => client.query(sql, params) as Promise<QueryResult>),
          release: () => client.release(),
        }
      },
    }
  }

  async function rows(provider?: string): Promise<Map<string, DbRow>> {
    const res = await corePool.query<DbRow>(
      provider
        ? 'SELECT * FROM llm_allowed_models WHERE provider = $1 ORDER BY model'
        : 'SELECT * FROM llm_allowed_models ORDER BY provider, model',
      provider ? [provider] : []
    )
    return new Map(res.rows.map(r => [`${r.provider}/${r.model}`, r]))
  }

  async function rowOf(provider: string, model: string): Promise<DbRow | undefined> {
    const res = await corePool.query<DbRow>(
      'SELECT * FROM llm_allowed_models WHERE provider = $1 AND model = $2',
      [provider, model]
    )
    return res.rows[0]
  }

  async function pricesOf(
    provider: string,
    model: string
  ): Promise<Array<{ enabled: boolean; input_token_price: string; output_token_price: string }>> {
    const res = await corePool.query(
      `SELECT enabled, input_token_price, output_token_price,
              cache_read_token_price, cache_write_token_price
         FROM llm_model_prices WHERE provider = $1 AND model = $2 ORDER BY created_at`,
      [provider, model]
    )
    return res.rows
  }

  /** Model ids per provider served by the fake ConfigMap. */
  function served(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    for (const [provider, json] of Object.entries(cluster.data ?? {})) {
      const entries = JSON.parse(json) as Array<{ model: string }>
      out.set(provider, new Set(entries.map(e => e.model)))
    }
    return out
  }

  async function beginTx(): Promise<PoolClient> {
    const client = await racePool.connect()
    await client.query('BEGIN')
    return client
  }

  async function waitForLockWaiter(): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const res = await adminPool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [database]
      )
      if ((res.rows[0] as { n: number }).n > 0) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error('no session ever blocked on a lock')
  }

  // ON by default: claude, openai, mistral. OFF by default: groq.
  const MIXED: CatalogProvider[] = ['claude', 'openai', 'mistral', 'groq']

  describe('T-L1 · live run on an empty installation', () => {
    it('enabled ⇔ policy ∧ eligible, with the operator override taking precedence', async () => {
      // Override one default in each direction through the real toggle.
      await mod.setProviderAutoEnable('mistral', false, 'test')
      await mod.setProviderAutoEnable('groq', true, 'test')
      const policy: Record<string, boolean> = {
        ...PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT,
        mistral: false,
        groq: true,
      }
      const catalog = wholeLiveProviders([...MIXED, 'bedrock'])
      await sync(catalog)

      const db = await rows()
      let enabledSeen = 0
      let onIneligibleSeen = 0
      let offEligibleSeen = 0
      for (const p of [...MIXED, 'bedrock'] as CatalogProvider[]) {
        for (const m of discoveredOf(catalog, p)) {
          const row = db.get(`${p}/${m.model_id}`)
          expect(row, `${p}/${m.model_id}`).toBeDefined()
          const expected = policy[p] === true && isAutoEnableEligible(m)
          expect(row!.enabled, `${p}/${m.model_id}`).toBe(expected)
          if (expected) enabledSeen += 1
          if (policy[p] && !isAutoEnableEligible(m)) onIneligibleSeen += 1
          if (!policy[p] && isAutoEnableEligible(m)) offEligibleSeen += 1
        }
      }
      // The equivalence is only meaningful if every side of it occurred.
      expect(enabledSeen).toBeGreaterThan(0)
      expect(onIneligibleSeen).toBeGreaterThan(0)
      expect(offEligibleSeen).toBeGreaterThan(0)

      // Everything enabled is published.
      const cm = served()
      for (const row of db.values()) {
        if (row.enabled) expect(cm.get(row.provider)?.has(row.model), row.model).toBe(true)
      }
    })

    it("after a reset to default, the run follows each provider's code default", async () => {
      expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.mistral).toBe(true)
      expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.groq).toBe(false)
      // Override against the default, then reset: the run must not keep the override.
      await mod.setProviderAutoEnable('mistral', false, 'test')
      await mod.setProviderAutoEnable('groq', true, 'test')
      await mod.setProviderAutoEnable('mistral', null, 'test')
      await mod.setProviderAutoEnable('groq', null, 'test')
      const catalog = wholeLiveProviders(['mistral', 'groq'])
      await sync(catalog)

      const db = await rows()
      const enabledOf = (p: CatalogProvider) =>
        discoveredOf(catalog, p).filter(m => db.get(`${p}/${m.model_id}`)!.enabled).length
      const eligibleOf = (p: CatalogProvider) =>
        discoveredOf(catalog, p).filter(isAutoEnableEligible).length
      expect(eligibleOf('mistral')).toBeGreaterThan(0)
      expect(eligibleOf('groq')).toBeGreaterThan(0)
      expect(enabledOf('mistral')).toBe(eligibleOf('mistral'))
      expect(enabledOf('groq')).toBe(0)
    })

    it('L4 · every inserted row with a catalog cost carries that price; unpriced ones carry none', async () => {
      const catalog = wholeLiveProviders(['claude', 'groq'])
      await sync(catalog)
      let priced = 0
      let unpriced = 0
      for (const p of ['claude', 'groq'] as CatalogProvider[]) {
        for (const m of discoveredOf(catalog, p)) {
          const prices = await pricesOf(p, m.model_id)
          if (m.cost === null) {
            expect(prices).toEqual([])
            unpriced += 1
            continue
          }
          priced += 1
          expect(prices).toHaveLength(1)
          expect(prices[0].enabled).toBe(true)
          expect(Number(prices[0].input_token_price)).toBe(m.cost.input)
          expect(Number(prices[0].output_token_price)).toBe(m.cost.output)
        }
      }
      expect(priced).toBeGreaterThan(0)
      expect(unpriced).toBeGreaterThan(0)
    })

    it('with the providers OFF nothing is enabled, while prices and catalog status are still written', async () => {
      await mod.setProviderAutoEnable('claude', false, 'test')
      await mod.setProviderAutoEnable('openai', false, 'test')
      const catalog = wholeLiveProviders(['claude', 'openai'])
      await sync(catalog)
      const db = await rows()
      expect([...db.values()].every(r => !r.enabled)).toBe(true)
      const deprecated = first(
        discoveredOf(catalog, 'openai'),
        m => m.catalog_status === 'deprecated',
        'deprecated openai model'
      )
      expect(db.get(`openai/${deprecated.model_id}`)!.catalog_status).toBe('deprecated')
      const priced = first(discoveredOf(catalog, 'claude'), m => m.cost !== null, 'priced model')
      expect(await pricesOf('claude', priced.model_id)).toHaveLength(1)
    })
  })

  it('T-E4 · ids the runtime cannot execute stay disabled even with the provider ON', async () => {
    await mod.setProviderAutoEnable('vertex', true, 'test')
    await mod.setProviderAutoEnable('openrouter', true, 'test')
    const catalog = wholeLiveProviders(['vertex', 'openrouter'])
    await sync(catalog)
    let notRunnable = 0
    let runnableEligible = 0
    for (const p of ['vertex', 'openrouter'] as CatalogProvider[]) {
      for (const m of discoveredOf(catalog, p)) {
        const row = (await rowOf(p, m.model_id))!
        if (autoEnableRejection(m) === 'not_runnable') {
          notRunnable += 1
          expect(m.model_id).toMatch(/[@~]/)
          expect(row.enabled, m.model_id).toBe(false)
        } else if (isAutoEnableEligible(m)) {
          runnableEligible += 1
          expect(row.enabled, m.model_id).toBe(true)
        }
      }
    }
    expect(notRunnable).toBeGreaterThan(0)
    expect(runnableEligible).toBeGreaterThan(0)
  })

  it('S1 · an operator disable of an auto-enabled row survives the next live run', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = first(discoveredOf(catalog, 'claude'), isAutoEnableEligible, 'eligible model')
    await sync(catalog)
    const before = (await rowOf('claude', target.model_id))!
    expect(before.enabled).toBe(true)
    expect(served().get('claude')?.has(target.model_id)).toBe(true)

    await request(app())
      .put(`${MODELS_PATH}/${before.id}`)
      .set('Cookie', COOKIE)
      .send({ enabled: false })
      .expect(200)
    await sync(catalog)

    const after = (await rowOf('claude', target.model_id))!
    expect(after.id).toBe(before.id)
    expect(after.enabled).toBe(false)
    expect(served().get('claude')?.has(target.model_id) ?? false).toBe(false)
  })

  it('T-H6 · a model deleted through the route comes back disabled on the next live run', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = first(discoveredOf(catalog, 'claude'), isAutoEnableEligible, 'eligible model')
    await sync(catalog)
    const before = (await rowOf('claude', target.model_id))!
    expect(before.enabled).toBe(true)

    await request(app()).delete(`${MODELS_PATH}/${before.id}`).set('Cookie', COOKIE).expect(204)
    await sync(catalog)

    const after = (await rowOf('claude', target.model_id))!
    expect(after.id).not.toBe(before.id)
    expect(after.enabled).toBe(false)
    expect(served().get('claude')?.has(target.model_id) ?? false).toBe(false)
  })

  it('T-H7 · vendored then live on an empty installation: ON eligibles end enabled and served', async () => {
    // The vendored run is the real bundled snapshot; the live run the captured api.json.
    await sync(trimSnapshot({ anthropic: 30, groq: 30 }), { source: 'vendored' })
    expect((await rows('claude')).size).toBe(0)
    const groqAfterVendored = await rows('groq')
    expect(groqAfterVendored.size).toBeGreaterThan(0)
    expect([...groqAfterVendored.values()].every(r => !r.enabled)).toBe(true)

    const live = wholeLiveProviders(['claude', 'groq'])
    await sync(live)
    const eligible = discoveredOf(live, 'claude').filter(isAutoEnableEligible)
    expect(eligible.length).toBeGreaterThan(0)
    const cm = served()
    for (const m of eligible) {
      expect((await rowOf('claude', m.model_id))!.enabled, m.model_id).toBe(true)
      expect(cm.get('claude')?.has(m.model_id), m.model_id).toBe(true)
    }
    expect(cm.has('groq')).toBe(false)
  })

  it('T-H11 · an implausible live run inserts no ON rows; the next plausible run enables them', async () => {
    const catalog = wholeLiveProviders(['claude', 'groq'])
    const result = await sync(catalog, { implausible: true })
    expect((await rows('claude')).size).toBe(0)
    const groq = await rows('groq')
    expect(groq.size).toBe(discoveredOf(catalog, 'groq').length)
    expect([...groq.values()].every(r => !r.enabled)).toBe(true)
    expect(result.providerCounts?.claude?.skippedUndecidable).toBe(
      discoveredOf(catalog, 'claude').length
    )

    await sync(catalog)
    for (const m of discoveredOf(catalog, 'claude')) {
      expect((await rowOf('claude', m.model_id))!.enabled, m.model_id).toBe(isAutoEnableEligible(m))
    }
  })

  it('T-H1 · an admin create committed between the SELECT and the INSERT wins; no price', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = first(
      discoveredOf(catalog, 'claude'),
      m => isAutoEnableEligible(m) && m.cost !== null,
      'eligible priced model'
    )
    let fired = false
    const connector = intercepting(async (sql, params, run) => {
      if (!fired && /INSERT INTO llm_allowed_models/.test(sql) && params[1] === target.model_id) {
        fired = true
        await mod.createAllowedModel(
          { provider: 'claude', model: target.model_id, enabled: false },
          'racing-admin'
        )
      }
      return run()
    })
    const result = await sync(catalog, { connector })
    expect(fired).toBe(true)

    const row = (await rowOf('claude', target.model_id))!
    expect(row.source).toBe('manual')
    expect(row.enabled).toBe(false)
    expect(await pricesOf('claude', target.model_id)).toEqual([])
    const eligibleCount = discoveredOf(catalog, 'claude').filter(isAutoEnableEligible).length
    expect(result.providerCounts?.claude?.autoEnabled).toBe(eligibleCount - 1)
  })

  it('T-H1 (ineligible) · a pair the admin created first is not counted as an ineligible insert', async () => {
    const catalog = wholeLiveProviders(['openai'])
    const target = first(
      discoveredOf(catalog, 'openai'),
      m => autoEnableRejection(m) !== null,
      'ineligible openai model'
    )
    let fired = false
    const connector = intercepting(async (sql, params, run) => {
      if (!fired && /INSERT INTO llm_allowed_models/.test(sql) && params[1] === target.model_id) {
        fired = true
        await mod.createAllowedModel(
          { provider: 'openai', model: target.model_id, enabled: false },
          'racing-admin'
        )
      }
      return run()
    })
    const result = await sync(catalog, { connector })
    expect(fired).toBe(true)
    expect((await rowOf('openai', target.model_id))!.source).toBe('manual')

    const rejections = { no_text_output: 0, no_tool_call: 0, status: 0, not_runnable: 0 }
    for (const m of discoveredOf(catalog, 'openai')) {
      const r = autoEnableRejection(m)
      if (r && m.model_id !== target.model_id) rejections[r] += 1
    }
    expect(result.providerCounts?.openai?.ineligible).toEqual(rejections)
  })

  it('T-H1c · a row reclassified to discovery between the SELECT and its UPDATE is left alone', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = discoveredOf(catalog, 'claude')[0]
    const manual = await mod.createAllowedModel(
      { provider: 'claude', model: target.model_id, enabled: true },
      'seed'
    )
    let fired = false
    const connector = intercepting(async (sql, params, run) => {
      if (!fired && /t\.source = 'manual'/.test(sql) && params[0] === manual.id) {
        fired = true
        // Stand-in for the reclassification migration, which does not exist yet:
        // the same single UPDATE it will issue.
        await racePool.query(`UPDATE llm_allowed_models SET source = 'discovery' WHERE id = $1`, [
          manual.id,
        ])
      }
      return run()
    })
    await sync(catalog, { connector })
    expect(fired).toBe(true)
    const row = (await rowOf('claude', target.model_id))!
    expect(row.source).toBe('discovery')
    expect(row.image_input).toBeNull()
    expect(row.enabled).toBe(true)
  })

  it('T-H12 · admin price racing the sync price: exactly one active row', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = first(discoveredOf(catalog, 'claude'), m => m.cost !== null, 'priced model')
    const admin = await beginTx()
    let fired = false
    try {
      const connector = intercepting(async (sql, params, run) => {
        if (!fired && /INSERT INTO llm_model_prices/.test(sql) && params[1] === target.model_id) {
          fired = true
          // The admin's INSERT is in flight (not committed) when the sync's
          // arrives: the sync's NOT EXISTS cannot see it, so the sync waits on
          // the active-price index and must then do nothing.
          await mod.createLlmPrice(
            {
              provider: 'claude',
              model: target.model_id,
              input_token_price: 99,
              output_token_price: 199,
              cache_read_token_price: 0,
              cache_write_token_price: 0,
              currency: 'USD',
              enabled: true,
            },
            admin as never
          )
          const pending = run()
          await waitForLockWaiter()
          await admin.query('COMMIT')
          return pending
        }
        return run()
      })
      await sync(catalog, { connector })
    } finally {
      await admin.query('ROLLBACK').catch(() => {})
      admin.release()
    }
    expect(fired).toBe(true)
    const prices = await pricesOf('claude', target.model_id)
    expect(prices.filter(p => p.enabled)).toHaveLength(1)
    expect(Number(prices[0].input_token_price)).toBe(99)
  })

  it('T-H13 · a disabled price the admin kept blocks the catalog price', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = first(discoveredOf(catalog, 'claude'), m => m.cost !== null, 'priced model')
    await mod.createLlmPrice({
      provider: 'claude',
      model: target.model_id,
      input_token_price: 1,
      output_token_price: 2,
      cache_read_token_price: 0,
      cache_write_token_price: 0,
      currency: 'USD',
      enabled: false,
    })
    await sync(catalog)
    expect(await rowOf('claude', target.model_id)).toBeDefined()
    const prices = await pricesOf('claude', target.model_id)
    expect(prices).toHaveLength(1)
    expect(prices[0].enabled).toBe(false)
  })

  it('T-H15 · a DELETE committed after the sync lock and before the provider SELECT is honoured', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = first(discoveredOf(catalog, 'claude'), isAutoEnableEligible, 'eligible model')
    await sync(catalog)
    const before = (await rowOf('claude', target.model_id))!
    expect(before.enabled).toBe(true)

    let fired = false
    const connector = intercepting(async (sql, params, run) => {
      if (
        !fired &&
        /SELECT id, model, source FROM llm_allowed_models WHERE provider/.test(sql) &&
        params[0] === 'claude'
      ) {
        fired = true
        // The run already holds the catalog-sync lock; the DELETE never takes it.
        await request(app()).delete(`${MODELS_PATH}/${before.id}`).set('Cookie', COOKIE).expect(204)
      }
      return run()
    })
    await sync(catalog, { connector })
    expect(fired).toBe(true)
    const after = (await rowOf('claude', target.model_id))!
    expect(after.id).not.toBe(before.id)
    expect(after.enabled).toBe(false)
  })

  it('T-H19 · renames committed between the SELECT and the UPDATE inherit neither evidence nor status', async () => {
    const base = wholeLiveProviders(['claude', 'openai'])
    // Two real entries whose catalog status is visible if it leaks.
    const modelRename = first(
      discoveredOf(base, 'openai'),
      m => m.catalog_status === 'deprecated',
      'deprecated openai model'
    )
    const providerRename = first(
      discoveredOf(base, 'openai'),
      m => m.catalog_status === 'deprecated' && m.model_id !== modelRename.model_id,
      'second deprecated openai model'
    )
    await sync(base)
    const a = (await rowOf('openai', modelRename.model_id))!
    const b = (await rowOf('openai', providerRename.model_id))!
    expect(a.catalog_status).toBe('deprecated')

    const renamedModel = `renamed-${randomBytes(4).toString('hex')}`
    const fired = new Set<string>()
    const connector = intercepting(async (sql, params, run) => {
      if (/SET last_seen_at/.test(sql) && (params[0] === a.id || params[0] === b.id)) {
        const id = String(params[0])
        if (!fired.has(id)) {
          fired.add(id)
          const body = id === a.id ? { model: renamedModel } : { provider: 'azure' }
          await request(app())
            .put(`${MODELS_PATH}/${id}?force=true`)
            .set('Cookie', COOKIE)
            .send(body)
            .expect(200)
        }
      }
      return run()
    })
    await sync(base, { connector })
    expect(fired.size).toBe(2)

    const renamedA = (
      await corePool.query<DbRow>('SELECT * FROM llm_allowed_models WHERE id = $1', [a.id])
    ).rows[0]
    expect(renamedA.model).toBe(renamedModel)
    expect(renamedA.image_input).toBeNull()
    expect(renamedA.catalog_status).toBeNull()
    const renamedB = (
      await corePool.query<DbRow>('SELECT * FROM llm_allowed_models WHERE id = $1', [b.id])
    ).rows[0]
    expect(renamedB.provider).toBe('azure')
    expect(renamedB.image_input).toBeNull()
    expect(renamedB.catalog_status).toBeNull()
  })

  it('T-H19 (manual) · a manual row renamed before its UPDATE does not take the old evidence', async () => {
    const catalog = wholeLiveProviders(['claude'])
    const target = discoveredOf(catalog, 'claude')[0]
    const manual = await mod.createAllowedModel(
      { provider: 'claude', model: target.model_id, enabled: false },
      'seed'
    )
    const renamedModel = `renamed-${randomBytes(4).toString('hex')}`
    let fired = false
    const connector = intercepting(async (sql, params, run) => {
      if (!fired && /t\.source = 'manual'/.test(sql) && params[0] === manual.id) {
        fired = true
        await request(app())
          .put(`${MODELS_PATH}/${manual.id}?force=true`)
          .set('Cookie', COOKIE)
          .send({ model: renamedModel })
          .expect(200)
      }
      return run()
    })
    await sync(catalog, { connector })
    expect(fired).toBe(true)
    const renamed = (await rowOf('claude', renamedModel))!
    expect(renamed.id).toBe(manual.id)
    expect(renamed.image_input).toBeNull()
  })

  it('C10 · a vendored run never clears a status a live run recorded', async () => {
    // A deprecated entry the bundled snapshot also lists, so the vendored run
    // reaches the row.
    const snapshotIds = new Set(Object.keys(trimSnapshot({ openai: 1000 }).openai?.models ?? {}))
    const live = wholeLiveProviders(['openai'])
    const target = first(
      discoveredOf(live, 'openai'),
      m =>
        m.catalog_status === 'deprecated' && snapshotIds.has(rawIdOf(live, 'openai', m.model_id)),
      'deprecated openai model present in the snapshot'
    )
    await sync(live)
    expect((await rowOf('openai', target.model_id))!.catalog_status).toBe('deprecated')

    const before = await corePool.query<{ last_seen_at: Date }>(
      'SELECT last_seen_at FROM llm_allowed_models WHERE provider = $1 AND model = $2',
      ['openai', target.model_id]
    )
    await sync(trimSnapshot({ openai: [rawIdOf(live, 'openai', target.model_id)] }), {
      source: 'vendored',
    })
    const after = (await rowOf('openai', target.model_id))! as DbRow & { last_seen_at: Date }
    // The vendored run did reach the row…
    expect(after.last_seen_at.getTime()).toBeGreaterThan(before.rows[0].last_seen_at.getTime())
    // …and left the status alone.
    expect(after.catalog_status).toBe('deprecated')
  })

  it('T-H22 · a negative cost and an unknown status do not fail the run', async () => {
    const base = wholeLiveProviders(['claude'])
    const [costEntry, statusEntry] = discoveredOf(base, 'claude').filter(m => m.cost !== null)
    const altered = withEntryField(
      withEntryField(base, 'claude', rawIdOf(base, 'claude', costEntry.model_id), {
        cost: {
          ...(LIVE_MODELS_DEV_CATALOG.anthropic.models[rawIdOf(base, 'claude', costEntry.model_id)]
            .cost as object),
          input: -1,
        },
      }),
      'claude',
      rawIdOf(base, 'claude', statusEntry.model_id),
      { status: 'retired' }
    )
    const result = await sync(altered)
    expect(result.added).toBe(discoveredOf(base, 'claude').length)
    expect(await pricesOf('claude', costEntry.model_id)).toEqual([])
    expect((await rowOf('claude', statusEntry.model_id))!.catalog_status).toBeNull()
    // The rest of the catalog was reconciled in the same run.
    expect((await rows('claude')).size).toBe(discoveredOf(base, 'claude').length)
  })

  it('an eligible model whose catalog status is unknown is inserted disabled, with no status stored', async () => {
    const base = wholeLiveProviders(['claude'])
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.claude).toBe(true)
    const [target, witness] = discoveredOf(base, 'claude').filter(isAutoEnableEligible)
    const altered = withEntryField(base, 'claude', rawIdOf(base, 'claude', target.model_id), {
      status: 'preview',
    })
    await sync(altered)
    const row = (await rowOf('claude', target.model_id))!
    expect(row.enabled).toBe(false)
    expect(row.catalog_status).toBeNull()
    // The same run enabled an untouched eligible entry of the same provider.
    expect((await rowOf('claude', witness.model_id))!.enabled).toBe(true)
  })

  describe('attention feed', () => {
    it('T-H14 · an enabled model the catalog later deprecates is listed as deprecated_model_enabled', async () => {
      const base = wholeLiveProviders(['claude'])
      const target = first(discoveredOf(base, 'claude'), isAutoEnableEligible, 'eligible model')
      await sync(base)
      expect((await rowOf('claude', target.model_id))!.enabled).toBe(true)

      let res = await request(app())
        .get('/api/v1/admin/attention')
        .set('Cookie', COOKIE)
        .expect(200)
      expect(res.body.items).toEqual([])

      const deprecatedNow = withEntryField(
        base,
        'claude',
        rawIdOf(base, 'claude', target.model_id),
        {
          status: 'deprecated',
        }
      )
      await sync(deprecatedNow)
      const row = (await rowOf('claude', target.model_id))!
      expect(row.enabled).toBe(true)
      expect(row.catalog_status).toBe('deprecated')

      res = await request(app()).get('/api/v1/admin/attention').set('Cookie', COOKIE).expect(200)
      expect(res.body.items).toContainEqual(
        expect.objectContaining({
          kind: 'deprecated_model_enabled',
          provider: 'claude',
          model: target.model_id,
        })
      )
      expect(res.body.items).toHaveLength(1)
    })

    it('T-L6 · an enabled discovery row gone stale is listed, an enabled manual stale row is not', async () => {
      const base = wholeLiveProviders(['claude'])
      const target = first(discoveredOf(base, 'claude'), isAutoEnableEligible, 'eligible model')
      await sync(base)
      await sync(withoutEntries(base, 'claude', [rawIdOf(base, 'claude', target.model_id)]))
      const row = (await rowOf('claude', target.model_id))!
      expect(row.enabled).toBe(true)
      expect(row.stale).toBe(true)

      // No producer marks a manual row stale (the sync never writes `stale` on
      // one), so this row is written directly: it pins that the kind keys on
      // `source`, for data that predates that invariant.
      const manual = await mod.createAllowedModel(
        { provider: 'openai', model: `manual-${randomBytes(4).toString('hex')}`, enabled: true },
        'seed'
      )
      await corePool.query('UPDATE llm_allowed_models SET stale = true WHERE id = $1', [manual.id])

      // A subscription provider's own `discovery` row, enabled and stale. Its
      // rebuild disables a row when it stales it, so no producer emits this
      // combination either: written directly to pin that the kind only covers
      // providers fed by the public catalog.
      const subscription = await mod.createAllowedModel(
        {
          provider: 'codex-subscription',
          model: `sub-${randomBytes(4).toString('hex')}`,
          enabled: true,
        },
        'seed'
      )
      await corePool.query(
        `UPDATE llm_allowed_models SET stale = true, source = 'discovery' WHERE id = $1`,
        [subscription.id]
      )

      const res = await request(app())
        .get('/api/v1/admin/attention')
        .set('Cookie', COOKIE)
        .expect(200)
      const staleDiscovery = (res.body.items as Array<{ kind: string; model: string }>).filter(
        i => i.kind === 'stale_discovery_enabled'
      )
      expect(staleDiscovery.map(i => i.model)).toEqual([target.model_id])
    })

    it('a discovered model renamed by the operator is not flagged stale by the next live run', async () => {
      const base = wholeLiveProviders(['claude'])
      const [live, vanished] = discoveredOf(base, 'claude').filter(isAutoEnableEligible)
      await sync(base)
      // `vanished` is already stale when the operator renames it.
      await sync(withoutEntries(base, 'claude', [rawIdOf(base, 'claude', vanished.model_id)]))
      expect((await rowOf('claude', vanished.model_id))!.stale).toBe(true)

      // Pairs models.dev does not list, like a regional inference profile.
      const renames = [live, vanished].map(m => ({
        id: m.model_id,
        to: `us.${m.model_id}-${randomBytes(3).toString('hex')}`,
      }))
      for (const r of renames) {
        const row = (await rowOf('claude', r.id))!
        expect(row.source).toBe('discovery')
        expect(row.enabled).toBe(true)
        await request(app())
          .put(`${MODELS_PATH}/${row.id}?force=true`)
          .set('Cookie', COOKIE)
          .send({ model: r.to })
          .expect(200)
      }
      await sync(base)

      const res = await request(app())
        .get('/api/v1/admin/attention')
        .set('Cookie', COOKIE)
        .expect(200)
      expect(res.body.items).toEqual([])
      for (const r of renames) {
        const row = (await rowOf('claude', r.to))!
        expect(row.enabled, r.to).toBe(true)
        expect(row.stale, r.to).toBe(false)
        expect(row.source, r.to).toBe('manual')
      }
    })
  })

  describe('T-H24 · per-run caps on auto-enabled inserts', () => {
    async function enabledIds(provider: string): Promise<string[]> {
      const res = await corePool.query<{ model: string }>(
        'SELECT model FROM llm_allowed_models WHERE provider = $1 AND enabled',
        [provider]
      )
      return res.rows.map(r => r.model).sort(byCodeUnits)
    }

    it('(1) a provider over its cap enables exactly N per run, newest first, and the rest do not exist until a later run', async () => {
      const base = wholeLiveProviders(['openai'])
      // The newest eligible entry, made undated: it must go from the first run
      // to the last one.
      const newest = capOrder(discoveredOf(base, 'openai').filter(isAutoEnableEligible))[0]
      const catalog = withEntryField(base, 'openai', rawIdOf(base, 'openai', newest.model_id), {
        release_date: undefined,
      })
      const discovered = discoveredOf(catalog, 'openai')
      const order = capOrder(discovered.filter(isAutoEnableEligible))
      const ineligible = discovered.filter(m => !isAutoEnableEligible(m))
      const N = 10
      const k = order.length
      expect(k).toBeGreaterThan(3 * N)
      expect(order.at(-1)!.model_id).toBe(newest.model_id)
      // Guard: the first N by date are not simply the first N by id.
      expect(ids(order.slice(0, N))).not.toEqual(ids(order).sort(byCodeUnits).slice(0, N))

      const runs = Math.ceil(k / N)
      for (let run = 1; run <= runs; run++) {
        const result = await sync(catalog, { maxPerProvider: N })
        const admitted = order.slice(0, Math.min(run * N, k))
        expect(await enabledIds('openai'), `run ${run}`).toEqual(ids(admitted).sort(byCodeUnits))
        for (const m of order.slice(admitted.length)) {
          expect(await rowOf('openai', m.model_id), `run ${run} ${m.model_id}`).toBeUndefined()
        }
        // Outside the cap: every ineligible model went in on the first run, disabled.
        for (const m of ineligible) {
          expect((await rowOf('openai', m.model_id))?.enabled, m.model_id).toBe(false)
        }
        expect(result.providerCounts?.openai?.autoEnabled).toBe(admitted.length - (run - 1) * N)
        expect(result.providerCounts?.openai?.deferredByCap ?? 0).toBe(k - admitted.length)
      }
      const cm = served()
      for (const m of order) expect(cm.get('openai')?.has(m.model_id), m.model_id).toBe(true)

      // Converged: one more run enables nothing new and defers nothing.
      const after = await sync(catalog, { maxPerProvider: N })
      expect(after.providerCounts?.openai).toBeUndefined()
    })

    it('(2) more candidates than the per-run cap across providers: the run enables exactly G, in PROVIDER_IDS order', async () => {
      const catalog = wholeLiveProviders(['openai', 'claude', 'gemini'])
      const order = (p: CatalogProvider) =>
        capOrder(discoveredOf(catalog, p).filter(isAutoEnableEligible))
      const N = 20
      const G = 25
      expect(order('openai').length).toBeGreaterThan(N)

      const result = await sync(catalog, { maxPerProvider: N, maxPerRun: G })
      const all = await rows()
      expect([...all.values()].filter(r => r.enabled)).toHaveLength(G)
      expect(await enabledIds('openai')).toEqual(ids(order('openai').slice(0, N)).sort(byCodeUnits))
      expect(await enabledIds('claude')).toEqual(
        ids(order('claude').slice(0, G - N)).sort(byCodeUnits)
      )
      expect(await enabledIds('gemini')).toEqual([])
      expect(result.providerCounts?.openai?.deferredByCap).toBe(order('openai').length - N)
      expect(result.providerCounts?.claude?.deferredByCap).toBe(order('claude').length - (G - N))
      expect(result.providerCounts?.gemini?.deferredByCap).toBe(order('gemini').length)
      // The global cap governs the inserts of eligible models only.
      for (const m of discoveredOf(catalog, 'gemini').filter(m => !isAutoEnableEligible(m))) {
        expect((await rowOf('gemini', m.model_id))?.enabled, m.model_id).toBe(false)
      }
    })

    it('(3) a tombstoned candidate is inserted disabled and does not take a slot', async () => {
      const catalog = wholeLiveProviders(['claude'])
      const order = capOrder(discoveredOf(catalog, 'claude').filter(isAutoEnableEligible))
      const removed = order[0]
      // The tombstone comes from its real producer: an operator DELETE.
      const created = await mod.createAllowedModel(
        { provider: 'claude', model: removed.model_id, enabled: false },
        'seed'
      )
      await request(app()).delete(`${MODELS_PATH}/${created.id}`).set('Cookie', COOKIE).expect(204)

      const N = 3
      const result = await sync(catalog, { maxPerProvider: N })
      expect((await rowOf('claude', removed.model_id))?.enabled).toBe(false)
      expect(await enabledIds('claude')).toEqual(ids(order.slice(1, 1 + N)).sort(byCodeUnits))
      expect(result.providerCounts?.claude).toMatchObject({
        inserted: N + 1,
        autoEnabled: N,
        dismissed: 1,
        deferredByCap: order.length - N - 1,
      })
    })

    it('(3b) a tombstoned candidate does not take a slot of the per-run cap either', async () => {
      const catalog = wholeLiveProviders(['openai'])
      const order = capOrder(discoveredOf(catalog, 'openai').filter(isAutoEnableEligible))
      const removed = order[0]
      const created = await mod.createAllowedModel(
        { provider: 'openai', model: removed.model_id, enabled: false },
        'seed'
      )
      await request(app()).delete(`${MODELS_PATH}/${created.id}`).set('Cookie', COOKIE).expect(204)

      // Only the per-run cap binds here: the per-provider one is far above it.
      const G = 5
      const result = await sync(catalog, { maxPerProvider: 1_000, maxPerRun: G })
      expect((await rowOf('openai', removed.model_id))?.enabled).toBe(false)
      expect(await enabledIds('openai')).toEqual(ids(order.slice(1, 1 + G)).sort(byCodeUnits))
      expect(result.providerCounts?.openai).toMatchObject({
        autoEnabled: G,
        dismissed: 1,
        deferredByCap: order.length - G - 1,
      })
    })

    it('(4) stale-marking and the per-provider floor see the whole catalog while the cap is exhausted', async () => {
      const base = wholeLiveProviders(['claude'])
      const order = capOrder(discoveredOf(base, 'claude').filter(isAutoEnableEligible))
      await sync(base, { maxPerProvider: 5 })
      const vanished = order[0]
      const catalog = withoutEntries(base, 'claude', [rawIdOf(base, 'claude', vanished.model_id)])
      const liveCount = discoveredOf(catalog, 'claude').length

      // A floor equal to the catalog's size passes only if the deferred models
      // are counted; the run itself inserts 2 of them.
      const result = await sync(catalog, { maxPerProvider: 2, providerMinLive: liveCount })
      expect(result.staled).toBe(1)
      expect((await rowOf('claude', vanished.model_id))!.stale).toBe(true)
      for (const m of order.slice(1, 5)) {
        expect((await rowOf('claude', m.model_id))!.stale, m.model_id).toBe(false)
      }
      expect(result.providerCounts?.claude?.deferredByCap).toBe(order.length - 5 - 2)
      expect(await enabledIds('claude')).toEqual(ids(order.slice(0, 7)).sort(byCodeUnits))
    })

    it('(5) a provider whose new models were all deferred still appears in provider_counts', async () => {
      const catalog = wholeLiveProviders(['openai', 'claude'])
      const openaiEligible = discoveredOf(catalog, 'openai').filter(isAutoEnableEligible).length
      const claudeEligible = discoveredOf(catalog, 'claude').filter(isAutoEnableEligible).length
      // Every claude entry is eligible, so with openai using up the run's cap
      // claude has nothing but deferred models.
      expect(claudeEligible).toBe(discoveredOf(catalog, 'claude').length)

      const result = await sync(catalog, { maxPerProvider: 100, maxPerRun: openaiEligible })
      expect((await rows('claude')).size).toBe(0)
      const expected = {
        inserted: 0,
        autoEnabled: 0,
        skippedUndecidable: 0,
        deferredByCap: claudeEligible,
        ineligible: { no_text_output: 0, no_tool_call: 0, status: 0, not_runnable: 0 },
        dismissed: 0,
        pricesLoaded: 0,
      }
      expect(result.providerCounts?.claude).toEqual(expected)
      expect((await mod.getLastCatalogSyncRun())?.providerCounts?.claude).toEqual(expected)
    })

    it('(6) a 400-character multibyte display_name is stored within 256 bytes of UTF-8, cut between code points', async () => {
      const base = wholeLiveProviders(['claude'])
      const target = first(discoveredOf(base, 'claude'), isAutoEnableEligible, 'eligible model')
      // 1 + 399 × 4 bytes, and a cut at 400 UTF-16 units would split a pair.
      const longName = `a${'😀'.repeat(399)}`
      expect([...longName]).toHaveLength(400)
      const catalog = withEntryField(base, 'claude', rawIdOf(base, 'claude', target.model_id), {
        name: longName,
      })
      await sync(catalog)

      const row = (await rowOf('claude', target.model_id))! as DbRow & { display_name: string }
      expect(row.enabled).toBe(true)
      expect(Buffer.byteLength(row.display_name, 'utf8')).toBeLessThanOrEqual(256)
      expect(isWellFormedUtf16(row.display_name)).toBe(true)
      expect(longName.startsWith(row.display_name)).toBe(true)
      expect(row.display_name.length).toBeGreaterThan(1)
      const served = JSON.parse(cluster.data!.claude) as Array<{
        model: string
        displayName?: string
      }>
      expect(served.find(e => e.model === target.model_id)?.displayName).toBe(row.display_name)
    })

    it('(7) a served entry with a hostile display_name stays within 640 bytes of JSON', async () => {
      const base = wholeLiveProviders(['claude'])
      // The heaviest evidence the sync writes is a KNOWN state (it carries an
      // expiry); the longest id is the closest the fixture gets to the worst case.
      const target = discoveredOf(base, 'claude')
        .filter(m => isAutoEnableEligible(m) && m.image_input_state === 'supported')
        .sort((a, b) => b.model_id.length - a.model_id.length)[0]
      expect(target).toBeDefined()
      // Quotes and backslashes double when serialized; the emoji and the euro
      // sign are 4 and 3 bytes.
      const hostile = '"\\😀€'.repeat(100)
      const catalog = withEntryField(base, 'claude', rawIdOf(base, 'claude', target.model_id), {
        name: hostile,
      })
      await sync(catalog)
      expect((await rowOf('claude', target.model_id))!.enabled).toBe(true)

      // The entry exactly as the real writer published it.
      const entries = JSON.parse(cluster.data!.claude) as Array<Record<string, unknown>>
      const entry = entries.find(e => e.model === target.model_id)!
      const displayName = String(entry.displayName)
      expect(hostile.startsWith(displayName)).toBe(true)
      expect(isWellFormedUtf16(displayName)).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(displayName)) - 2).toBeLessThanOrEqual(256)
      expect(entry.imageInput).toMatchObject({ state: 'supported' })

      const entryBytes = Buffer.byteLength(JSON.stringify(entry))
      expect(entryBytes).toBeLessThanOrEqual(640)
      // The id is the only other field an external catalog sizes, and the
      // runtime rule bounds it to 128 ASCII bytes: swapping this id for one of
      // that length must still fit.
      expect(entryBytes - Buffer.byteLength(target.model_id) + 128).toBeLessThanOrEqual(640)
    })
  })

  it('T-C12 · the run row records the per-provider counts', async () => {
    const catalog = wholeLiveProviders(['claude', 'openai', 'groq'])
    const dismissedModel = first(discoveredOf(catalog, 'claude'), isAutoEnableEligible, 'eligible')
    await corePool.query(
      `INSERT INTO llm_catalog_dismissed (provider, model) VALUES ('claude', $1)`,
      [dismissedModel.model_id]
    )
    await sync(catalog)

    const stored = await corePool.query<{
      provider_counts: Record<string, Record<string, unknown>>
    }>('SELECT provider_counts FROM llm_catalog_sync_runs ORDER BY ran_at DESC LIMIT 1')
    const counts = stored.rows[0].provider_counts
    for (const p of ['claude', 'openai', 'groq'] as CatalogProvider[]) {
      const discovered = discoveredOf(catalog, p)
      const policyOn = PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT[p]
      const rejections = { no_text_output: 0, no_tool_call: 0, status: 0, not_runnable: 0 }
      if (policyOn) {
        for (const m of discovered) {
          const r = autoEnableRejection(m)
          if (r) rejections[r] += 1
        }
      }
      const eligible = discovered.filter(isAutoEnableEligible).length
      const dismissedHere = p === 'claude' ? 1 : 0
      expect(counts[p], p).toEqual({
        inserted: discovered.length,
        autoEnabled: policyOn ? eligible - dismissedHere : 0,
        skippedUndecidable: 0,
        deferredByCap: 0,
        ineligible: rejections,
        dismissed: dismissedHere,
        pricesLoaded: discovered.filter(m => m.cost !== null).length,
      })
    }
    // The status endpoint's source reports them too.
    expect((await mod.getLastCatalogSyncRun())?.providerCounts).toEqual(counts)
  })

  it('T-C12 · a run recorded before deferredByCap existed reads it as 0', async () => {
    const catalog = wholeLiveProviders(['claude', 'groq'])
    await sync(catalog)
    const current = (await mod.getLastCatalogSyncRun())!.providerCounts!
    // The previous writer's shape is this one without the field.
    await corePool.query(
      `UPDATE llm_catalog_sync_runs
          SET provider_counts = (
            SELECT jsonb_object_agg(key, value - 'deferredByCap')
              FROM jsonb_each(provider_counts)
          )`
    )
    const stored = await corePool.query<{ provider_counts: Record<string, object> }>(
      'SELECT provider_counts FROM llm_catalog_sync_runs'
    )
    expect(Object.values(stored.rows[0].provider_counts).some(c => 'deferredByCap' in c)).toBe(
      false
    )
    expect((await mod.getLastCatalogSyncRun())?.providerCounts).toEqual(current)
  })
})
