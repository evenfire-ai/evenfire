import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import { VENDORED_MODELS_DEV_SNAPSHOT } from '../src/data/modelsDevSnapshot.js'
import type { SyncConnector } from '../src/services/llmCatalogSync.js'
import {
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  isAutoEnableEligible,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { FakeConfigMapApi } from './helpers/fakeAllowlistCluster.js'
import type { FakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  LIVE_MODELS_DEV_CATALOG,
  loadStub,
  trimLiveCatalog,
  trimSnapshot,
} from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// The strict fake DB is only a valid substrate for the model-based test if it
// leaves the tables exactly as Postgres does. This runs one scripted sequence —
// sync runs (live, capped, vendored, implausible), admin create / disable /
// rename / delete, conflicting creates, policy toggles and price creates —
// against the fake and against real Postgres, through the same production
// functions, and requires the same observable state after every step. The fake
// starts from what the real migrations seed. Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

type CatalogProvider = keyof typeof PROVIDER_KEY_MAP

// Two providers whose policy is on by default and two where it is off; one of
// the latter (openrouter) carries ids the runtime cannot execute.
const PROVIDERS: CatalogProvider[] = ['claude', 'deepseek', 'groq', 'openrouter']

function wholeLive(providers: CatalogProvider[]): RawModelsDevCatalog {
  return trimLiveCatalog(
    Object.fromEntries(
      providers.map(p => [
        PROVIDER_KEY_MAP[p],
        Object.keys(LIVE_MODELS_DEV_CATALOG[PROVIDER_KEY_MAP[p]].models).length,
      ])
    )
  )
}

function withoutFirst(catalog: RawModelsDevCatalog, provider: CatalogProvider, n: number) {
  const key = PROVIDER_KEY_MAP[provider]
  const models = Object.fromEntries(Object.entries(catalog[key].models).slice(n))
  return { ...catalog, [key]: { ...catalog[key], models } }
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** JSON with object keys sorted: jsonb does not keep the key order it was given. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map(k => [k, canonical((value as Record<string, unknown>)[k])])
    )
  }
  return value
}

interface Side {
  name: 'postgres' | 'fake'
  pool: Pool
  connector: SyncConnector
  cluster: FakeConfigMapApi
}

describeRealPostgres('strict catalog fake DB vs real PostgreSQL (differential)', () => {
  const database = `control_api_fake_diff_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let fake: FakeDb
  let pg: Side
  let fk: Side
  let mod: {
    syncDiscoveredModels: typeof import('../src/services/llmCatalogSync.js').syncDiscoveredModels
    getLastCatalogSyncRun: typeof import('../src/services/llmCatalogSync.js').getLastCatalogSyncRun
    createAllowedModel: typeof import('../src/services/llmAllowedModels.js').createAllowedModel
    updateAllowedModel: typeof import('../src/services/llmAllowedModels.js').updateAllowedModel
    deleteAllowedModel: typeof import('../src/services/llmAllowedModels.js').deleteAllowedModel
    listEnabledGroupedByProvider: typeof import('../src/services/llmAllowedModels.js').listEnabledGroupedByProvider
    createLlmPrice: typeof import('../src/services/llmPrices.js').createLlmPrice
    setProviderAutoEnable: typeof import('../src/services/llmProviderCatalogSettings.js').setProviderAutoEnable
    listProviderCatalogPolicy: typeof import('../src/services/llmProviderCatalogSettings.js').listProviderCatalogPolicy
    withTransaction: typeof import('../src/db.js').withTransaction
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

    const syncMod = await import('../src/services/llmCatalogSync.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const pricesMod = await import('../src/services/llmPrices.js')
    const policyMod = await import('../src/services/llmProviderCatalogSettings.js')
    const cmMod = await import('../src/services/llmAllowedModelsConfigMap.js')
    // Imported only now: the helper loads db.js, whose pool must see the URL above.
    const { makeFakeDb } = await import('./helpers/llmCatalogSyncFakeDb.js')
    mod = {
      syncDiscoveredModels: syncMod.syncDiscoveredModels,
      getLastCatalogSyncRun: syncMod.getLastCatalogSyncRun,
      createAllowedModel: allowlistMod.createAllowedModel,
      updateAllowedModel: allowlistMod.updateAllowedModel,
      deleteAllowedModel: allowlistMod.deleteAllowedModel,
      listEnabledGroupedByProvider: allowlistMod.listEnabledGroupedByProvider,
      createLlmPrice: pricesMod.createLlmPrice,
      setProviderAutoEnable: policyMod.setProviderAutoEnable,
      listProviderCatalogPolicy: policyMod.listProviderCatalogPolicy,
      withTransaction: dbMod.withTransaction,
      Writer: cmMod.LlmAllowedModelsConfigMapWriter,
    }

    // The fake starts from the state the real migrations leave behind.
    const seeded = await corePool.query(
      `SELECT provider, model, enabled, source, stale, context_window_tokens,
              display_name, vendor, image_input, catalog_status
         FROM llm_allowed_models`
    )
    const seededPrices = await corePool.query(
      `SELECT provider, model, input_token_price, output_token_price,
              cache_read_token_price, cache_write_token_price, currency, enabled
         FROM llm_model_prices`
    )
    const others = await corePool.query(
      `SELECT (SELECT count(*) FROM llm_catalog_dismissed)::int AS dismissed,
              (SELECT count(*) FROM llm_provider_catalog_settings)::int AS settings,
              (SELECT count(*) FROM llm_catalog_sync_runs)::int AS runs`
    )
    expect(others.rows[0]).toEqual({ dismissed: 0, settings: 0, runs: 0 })
    expect(seeded.rows.length).toBeGreaterThan(0)
    fake = makeFakeDb(seeded.rows, {
      prices: seededPrices.rows.map(r => ({
        ...r,
        input_token_price: Number(r.input_token_price),
        output_token_price: Number(r.output_token_price),
        cache_read_token_price: Number(r.cache_read_token_price),
        cache_write_token_price: Number(r.cache_write_token_price),
      })),
    })
    pg = {
      name: 'postgres',
      pool: corePool,
      connector: corePool as unknown as SyncConnector,
      cluster: new FakeConfigMapApi(),
    }
    fk = {
      name: 'fake',
      pool: fake.pool('admin'),
      connector: fake.connector,
      cluster: new FakeConfigMapApi(),
    }
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

  type Rows = Array<Record<string, unknown>>

  /** Raw table contents: Postgres through SQL, the fake through its committed views. */
  async function tables(side: Side) {
    if (side.name === 'fake') {
      return {
        models: fake.rows as unknown as Rows,
        prices: fake.prices as unknown as Rows,
        dismissed: [...fake.dismissed],
        settings: fake.settings as unknown as Rows,
        audit: fake.audit,
      }
    }
    const q = (sql: string) => corePool.query(sql).then(r => r.rows as Rows)
    return {
      models: await q(`SELECT * FROM llm_allowed_models`),
      prices: await q(`SELECT * FROM llm_model_prices`),
      dismissed: (await q(`SELECT provider, model FROM llm_catalog_dismissed`)).map(
        r => `${r.provider}/${r.model}`
      ),
      settings: await q(`SELECT * FROM llm_provider_catalog_settings`),
      audit: await q(`SELECT * FROM llm_allowed_models_audit`),
    }
  }

  const pick = (r: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
    Object.fromEntries(keys.map(k => [k, r[k]]))
  const byPair = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    byCodeUnits(String(a.provider), String(b.provider)) ||
    byCodeUnits(String(a.model), String(b.model))

  async function state(side: Side) {
    const t = await tables(side)
    return {
      models: t.models
        .map(
          (r): Record<string, unknown> => ({
            ...pick(r, [
              'provider',
              'model',
              'enabled',
              'source',
              'stale',
              'context_window_tokens',
              'display_name',
              'vendor',
              'catalog_status',
            ]),
            image_input: canonical(r.image_input),
            discovered: r.discovered_at !== null,
            seen: r.last_seen_at !== null,
          })
        )
        .sort(byPair),
      prices: t.prices
        .map(r => ({
          ...pick(r, ['provider', 'model', 'currency', 'enabled']),
          enabled: r.enabled,
          input_token_price: Number(r.input_token_price),
          output_token_price: Number(r.output_token_price),
          cache_read_token_price: Number(r.cache_read_token_price),
          cache_write_token_price: Number(r.cache_write_token_price),
        }))
        .sort(
          (a, b) =>
            byPair(a, b) ||
            Number(b.enabled) - Number(a.enabled) ||
            a.input_token_price - b.input_token_price
        ),
      dismissed: t.dismissed.sort(byCodeUnits),
      settings: t.settings
        .map(r => pick(r, ['provider', 'auto_enable', 'updated_by']))
        .sort((a, b) => byCodeUnits(String(a.provider), String(b.provider))),
      audit: t.audit.map(r => `${r.actor} ${r.action} ${r.provider}/${r.model}`).sort(byCodeUnits),
      // What the GET and the sync derive from the stored rows, NULL included.
      policy: (await mod.listProviderCatalogPolicy(side.pool)).map(
        ({ updated_at: _at, ...rest }) => rest
      ),
      lastRun: await lastRun(side),
      configMap: configMapOf(side.cluster),
    }
  }

  async function lastRun(side: Side) {
    const run = await mod.getLastCatalogSyncRun(side.pool)
    if (!run) return null
    const { id: _id, ranAt: _ranAt, ...rest } = run
    return rest
  }

  // Row order inside a provider follows the database collation, which the fake
  // does not model, so each provider's entries are compared as a set.
  function configMapOf(cluster: FakeConfigMapApi) {
    const data = cluster.data
    if (!data) return null
    const out: Record<string, unknown> = {}
    for (const provider of Object.keys(data).sort()) {
      const entries = JSON.parse(data[provider]) as Array<{ model: string }>
      out[provider] = canonical(entries.sort((a, b) => byCodeUnits(a.model, b.model)))
    }
    const { 'clerum.io/content-hash': _hash, ...annotations } = cluster.annotations ?? {}
    return { data: out, annotations }
  }

  async function both<T>(label: string, op: (side: Side) => Promise<T>): Promise<[T, T]> {
    const settle = async (side: Side) => {
      try {
        return { ok: true as const, value: await op(side) }
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.constructor.name : String(err),
        }
      }
    }
    const a = await settle(pg)
    const b = await settle(fk)
    expect({ label, outcome: b.ok ? 'ok' : b.error }).toEqual({
      label,
      outcome: a.ok ? 'ok' : a.error,
    })
    const [sa, sb] = [await state(pg), await state(fk)]
    expect({ label, ...sb }).toEqual({ label, ...sa })
    return [a.ok ? a.value : (undefined as T), b.ok ? b.value : (undefined as T)]
  }

  function sync(
    side: Side,
    catalog: RawModelsDevCatalog,
    opts: {
      source?: 'live' | 'vendored'
      implausible?: boolean
      maxPerProvider?: number
      maxPerRun?: number
    } = {}
  ) {
    return mod.syncDiscoveredModels(
      {
        materializer: new mod.Writer(side.cluster as never, 'mcp-host', 3, side.pool),
        loadCatalog: loadStub(catalog, opts.source ?? 'live', LIVE_MODELS_DEV_CAPTURED_AT),
        minPlausibleLiveTotal: opts.implausible ? 1_000_000 : 1,
        autoEnableMaxPerProviderPerRun: opts.maxPerProvider ?? 1_000,
        autoEnableMaxPerRun: opts.maxPerRun ?? 1_000,
      },
      side.connector
    )
  }

  async function idOf(side: Side, provider: string, model: string): Promise<string> {
    const row = (await tables(side)).models.find(r => r.provider === provider && r.model === model)
    if (!row) throw new Error(`${side.name}: no row ${provider}/${model}`)
    return String(row.id)
  }

  /** Enabled discovery rows of a provider, from the Postgres side (both are equal here). */
  async function enabledDiscovery(provider: string): Promise<string[]> {
    return (await state(pg)).models
      .filter(r => r.provider === provider && r.enabled === true && r.source === 'discovery')
      .map(r => String(r.model))
  }

  /** Eligible catalog entries of a provider with no row yet (deferred by the cap). */
  async function missingEligible(catalog: RawModelsDevCatalog, provider: CatalogProvider) {
    const present = new Set(
      (await state(pg)).models.filter(r => r.provider === provider).map(r => String(r.model))
    )
    return mapCatalogToProviders(catalog)
      [provider]!.filter(isAutoEnableEligible)
      .map(m => m.model_id)
      .filter(m => !present.has(m))
  }

  it('leaves the same table and ConfigMap state as Postgres after every step', async () => {
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.claude).toBe(true)
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.deepseek).toBe(true)
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.groq).toBe(false)
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.openrouter).toBe(false)
    const full = wholeLive(PROVIDERS)
    await both('initial', async () => undefined)

    // Capped live runs: each enables a slice, the rest are not inserted.
    await both('live capped 1', side => sync(side, full, { maxPerProvider: 4, maxPerRun: 6 }))
    await both('live capped 2', side => sync(side, full, { maxPerProvider: 4, maxPerRun: 6 }))

    const [deferredA, deferredB, deferredC] = await missingEligible(full, 'claude')
    expect(deferredC).toBeDefined()
    const [toDisable, toRename, toDelete, toClear] = await enabledDiscovery('claude')
    expect(toClear).toBeDefined()

    await both('admin create manual off-catalog', side =>
      mod.createAllowedModel(
        { provider: 'claude', model: 'differential-manual', enabled: true } as never,
        'admin',
        side.pool
      )
    )
    await both('admin create a deferred catalog pair, disabled', side =>
      mod.createAllowedModel(
        { provider: 'claude', model: deferredA, enabled: false } as never,
        'admin',
        side.pool
      )
    )
    await both('admin create conflict', side =>
      mod.createAllowedModel(
        { provider: 'claude', model: deferredA, enabled: true } as never,
        'admin',
        side.pool
      )
    )
    await both('admin disable', async side =>
      mod.withTransaction(
        async db =>
          mod.updateAllowedModel(
            await idOf(side, 'claude', toDisable),
            { enabled: false } as never,
            'admin',
            db
          ),
        side.pool
      )
    )
    // A later sync must leave an enabled row's served metadata alone.
    await both('admin clears the context window of an enabled discovery row', async side =>
      mod.withTransaction(
        async db =>
          mod.updateAllowedModel(
            await idOf(side, 'claude', toClear),
            { context_window_tokens: null } as never,
            'admin',
            db
          ),
        side.pool
      )
    )
    await both('admin rename', async side =>
      mod.withTransaction(
        async db =>
          mod.updateAllowedModel(
            await idOf(side, 'claude', toRename),
            { model: `${toRename}-renamed`, display_name: 'Renamed' } as never,
            'admin',
            db
          ),
        side.pool
      )
    )
    await both('admin rename into an existing pair (conflict)', async side =>
      mod.withTransaction(
        async db =>
          mod.updateAllowedModel(
            await idOf(side, 'claude', 'differential-manual'),
            { model: deferredA } as never,
            'admin',
            db
          ),
        side.pool
      )
    )
    await both('admin delete', async side =>
      mod.withTransaction(
        async db => mod.deleteAllowedModel(await idOf(side, 'claude', toDelete), 'admin', db),
        side.pool
      )
    )

    await both('toggle deepseek off', side =>
      mod.setProviderAutoEnable('deepseek', false, 'admin', side.pool)
    )
    await both('toggle groq on', side =>
      mod.setProviderAutoEnable('groq', true, 'admin', side.pool)
    )

    const price = {
      input_token_price: 1.123456789,
      output_token_price: 2,
      cache_read_token_price: 0,
      cache_write_token_price: 0,
      currency: 'USD',
    }
    await both('price for a deferred pair', side =>
      mod.createLlmPrice(
        { provider: 'claude', model: deferredB, enabled: true, ...price } as never,
        side.pool
      )
    )
    await both('disabled price for a deferred pair', side =>
      mod.createLlmPrice(
        { provider: 'claude', model: deferredC, enabled: false, ...price } as never,
        side.pool
      )
    )
    await both('price conflict', side =>
      mod.createLlmPrice(
        { provider: 'claude', model: deferredB, enabled: true, ...price } as never,
        side.pool
      )
    )

    const snapshot = trimSnapshot(
      Object.fromEntries(
        PROVIDERS.map(p => [
          PROVIDER_KEY_MAP[p],
          Object.keys(VENDORED_MODELS_DEV_SNAPSHOT[PROVIDER_KEY_MAP[p]].models).length,
        ])
      )
    )
    await both('vendored', side => sync(side, snapshot, { source: 'vendored' }))
    await both('implausible live', side => sync(side, full, { implausible: true }))

    const shrunk = withoutFirst(withoutFirst(full, 'claude', 3), 'groq', 2)
    await both('live, some entries gone', side => sync(side, shrunk))
    await both('live again (idempotent)', side => sync(side, shrunk))

    // Reset both overrides (NULL), and one provider that never had a row.
    await both('reset deepseek to default', side =>
      mod.setProviderAutoEnable('deepseek', null, 'admin', side.pool)
    )
    await both('reset groq to default', side =>
      mod.setProviderAutoEnable('groq', null, 'admin', side.pool)
    )
    await both('reset openrouter (no override yet)', side =>
      mod.setProviderAutoEnable('openrouter', null, 'admin', side.pool)
    )
    await both('live with the deleted and renamed pairs back', side => sync(side, full))
    await both('override again after a reset', side =>
      mod.setProviderAutoEnable('groq', true, 'admin', side.pool)
    )
  }, 120_000)
})
