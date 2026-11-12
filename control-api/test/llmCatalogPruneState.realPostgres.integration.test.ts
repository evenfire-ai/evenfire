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
import { CATALOG_CAPTURE_0135, applyLegacyCatalogSeeds } from './helpers/llmCatalogLegacySeeds.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  LIVE_MODELS_DEV_CATALOG,
  loadStub,
  trimLiveCatalog,
} from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// Migration 0139 and the writers of the authority over `enabled`, on real
// PostgreSQL: who owns `enabled` after a sync INSERT and after each kind of
// admin PUT (decided on the row the service locks), the episode trigger as the
// sync drives it, the conservative backfill over a database whose rows came
// from the real producers, and the runtime role's grants on the prune log.
// Rows are only ever written by the sync, the admin router or service, the
// legacy seed migrations and 0139 itself. Skipped without
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
const MIGRATION = '0139_llm_catalog_prune_state'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

// The provider every case syncs: its whole captured live catalog. Which models
// play each role is decided by the real mapper and eligibility predicate.
const PROVIDER = 'openai' as const
const PROVIDER_KEY = PROVIDER_KEY_MAP[PROVIDER]
const FULL_CATALOG = trimLiveCatalog({
  [PROVIDER_KEY]: Object.keys(LIVE_MODELS_DEV_CATALOG[PROVIDER_KEY].models).length,
})

function discovered(catalog: RawModelsDevCatalog): DiscoveredModel[] {
  return mapCatalogToProviders(catalog)[PROVIDER as LlmProviderId]
}

/** Raw entry id whose mapped model id is `modelId` (they can differ by normalization). */
function rawIdOf(catalog: RawModelsDevCatalog, modelId: string): string {
  const entries = catalog[PROVIDER_KEY].models
  for (const rawId of Object.keys(entries)) {
    const [d] = discovered({
      [PROVIDER_KEY]: { ...catalog[PROVIDER_KEY], models: { [rawId]: entries[rawId] } },
    })
    if (d?.model_id === modelId) return rawId
  }
  throw new Error(`rawIdOf: ${modelId} not in catalog`)
}

function withoutModel(catalog: RawModelsDevCatalog, modelId: string): RawModelsDevCatalog {
  const rawId = rawIdOf(catalog, modelId)
  const models = { ...catalog[PROVIDER_KEY].models }
  delete models[rawId]
  return { ...catalog, [PROVIDER_KEY]: { ...catalog[PROVIDER_KEY], models } }
}

function withEntry(
  catalog: RawModelsDevCatalog,
  modelId: string,
  patch: (entry: RawModelsDevModel) => RawModelsDevModel
): RawModelsDevCatalog {
  const rawId = rawIdOf(catalog, modelId)
  const entry = catalog[PROVIDER_KEY].models[rawId]
  return {
    ...catalog,
    [PROVIDER_KEY]: {
      ...catalog[PROVIDER_KEY],
      models: { ...catalog[PROVIDER_KEY].models, [rawId]: patch(entry) },
    },
  }
}

const ELIGIBLE = discovered(FULL_CATALOG).filter(
  m => isAutoEnableEligible(m) && m.catalog_status === null
)
const DEPRECATED = discovered(FULL_CATALOG).filter(m => m.catalog_status === 'deprecated')
if (ELIGIBLE.length < 6 || DEPRECATED.length < 1) {
  throw new Error('the live fixture no longer has the models these cases need')
}
const pick = (index: number) => ELIGIBLE[index]!.model_id

interface StateRow {
  id: string
  enabled: boolean
  stale: boolean
  catalog_status: string | null
  enabled_managed_by: string
  auto_disabled_at: Date | null
  attention_ack: unknown
  stale_since: Date | null
  stale_episode: unknown
  deprecated_episode: unknown
}

async function stateOf(pool: Pool, model: string): Promise<StateRow> {
  const { rows } = await pool.query<StateRow>(
    `SELECT id, enabled, stale, catalog_status, enabled_managed_by, auto_disabled_at,
            attention_ack, stale_since, stale_episode, deprecated_episode
       FROM llm_allowed_models WHERE provider = $1 AND model = $2`,
    [PROVIDER, model]
  )
  expect(rows, `${PROVIDER}/${model}`).toHaveLength(1)
  return rows[0]!
}

describeRealPostgres('0139 enabled authority and episodes (real PostgreSQL)', () => {
  const database = `control_api_prune_state_${randomBytes(6).toString('hex')}`
  // describe.skip still runs this factory, so it must not build a URL without the env.
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING
  const extraDatabases: string[] = []
  const extraPools: Pool[] = []

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let gateway: InstanceType<typeof import('./mockGateway.js').MockGateway>
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    MockGateway: typeof import('./mockGateway.js').MockGateway
    initDb: typeof import('../src/db.js').initDb
    withTransaction: typeof import('../src/db.js').withTransaction
    syncDiscoveredModels: typeof import('../src/services/llmCatalogSync.js').syncDiscoveredModels
    updateAllowedModel: typeof import('../src/services/llmAllowedModels.js').updateAllowedModel
    deleteAllowedModel: typeof import('../src/services/llmAllowedModels.js').deleteAllowedModel
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

    const appMod = await import('../src/app.js')
    const syncMod = await import('../src/services/llmCatalogSync.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const policyMod = await import('../src/services/llmProviderCatalogSettings.js')
    const cmMod = await import('../src/services/llmAllowedModelsConfigMap.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      MockGateway,
      initDb: dbMod.initDb,
      withTransaction: dbMod.withTransaction,
      syncDiscoveredModels: syncMod.syncDiscoveredModels,
      updateAllowedModel: allowlistMod.updateAllowedModel,
      deleteAllowedModel: allowlistMod.deleteAllowedModel,
      setProviderAutoEnable: policyMod.setProviderAutoEnable,
      Writer: cmMod.LlmAllowedModelsConfigMapWriter,
    }
  }, 60_000)

  afterAll(async () => {
    try {
      if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
      for (const pool of extraPools) await endPoolAndWaitForClients(pool).catch(() => {})
      await endPoolAndWaitForClients(corePool).catch(() => {})
      await endPoolAndWaitForClients(limiterPool).catch(() => {})
      if (adminPool) {
        for (const name of [database, ...extraDatabases]) {
          await adminPool.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [name]
          )
          await adminPool.query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}"`)
        }
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
      DELETE FROM llm_allowed_models;
      DELETE FROM llm_allowed_models_audit;
      DELETE FROM llm_catalog_dismissed;
      DELETE FROM llm_model_prices;
      DELETE FROM llm_provider_catalog_settings;
      DELETE FROM llm_catalog_sync_runs;
    `)
    gateway = new mod.MockGateway()
  })

  function sync(
    catalog: RawModelsDevCatalog,
    pool: Pool = corePool,
    source: 'live' | 'vendored' = 'live'
  ): Promise<CatalogSyncResult> {
    return mod.syncDiscoveredModels(
      {
        materializer: new mod.Writer(new FakeConfigMapApi() as never, 'mcp-host', 3, pool),
        loadCatalog: loadStub(catalog, source, LIVE_MODELS_DEV_CAPTURED_AT),
        minPlausibleLiveTotal: 1,
        autoEnableMaxPerProviderPerRun: 1_000,
        autoEnableMaxPerRun: 10_000,
      },
      pool as unknown as SyncConnector
    )
  }

  async function autoEnable(on: boolean, pool: Pool = corePool): Promise<void> {
    await mod.setProviderAutoEnable(PROVIDER, on, 'test-admin', pool)
  }

  function put(id: string, body: Record<string, unknown>) {
    return request(mod.createApp(gateway))
      .put(`${MODELS_PATH}/${id}`)
      .set('Cookie', COOKIE)
      .send(body)
  }

  describe('sync INSERT', () => {
    it('writes enabled_managed_by=catalog on every row it inserts, enabled or not', async () => {
      await autoEnable(true)
      await sync(FULL_CATALOG)
      const { rows } = await corePool.query<{ enabled: boolean; enabled_managed_by: string }>(
        `SELECT enabled, enabled_managed_by FROM llm_allowed_models WHERE provider = $1`,
        [PROVIDER]
      )
      expect(rows.length).toBe(discovered(FULL_CATALOG).length)
      expect(new Set(rows.map(r => r.enabled))).toEqual(new Set([true, false]))
      expect(rows.every(r => r.enabled_managed_by === 'catalog')).toBe(true)
    })
  })

  describe('PUT authority, decided on the locked row', () => {
    it('S-2: a PUT that turns a catalog row on hands it to the operator', async () => {
      await autoEnable(false)
      await sync(FULL_CATALOG)
      const row = await stateOf(corePool, pick(0))
      expect(row).toMatchObject({ enabled: false, enabled_managed_by: 'catalog' })

      await put(row.id, { enabled: true }).expect(200)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        enabled: true,
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
      })
    })

    it('S-2: a PUT that turns a catalog row off goes through the gate and hands it over', async () => {
      await autoEnable(true)
      await sync(FULL_CATALOG)
      const row = await stateOf(corePool, pick(0))
      expect(row).toMatchObject({ enabled: true, enabled_managed_by: 'catalog' })

      await put(row.id, { enabled: false }).expect(200)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        enabled: false,
        enabled_managed_by: 'operator',
      })
    })

    it('S-2b: the edit form resending the same `enabled` with a new display name keeps catalog', async () => {
      // pick(1) first appears in a run with the policy off, so it is inserted
      // disabled; pick(0) was inserted enabled by the earlier run.
      const offModel = pick(1)
      await autoEnable(true)
      await sync(withoutModel(FULL_CATALOG, offModel))
      const on = await stateOf(corePool, pick(0))
      await autoEnable(false)
      await sync(FULL_CATALOG)
      const off = await stateOf(corePool, offModel)
      expect(on).toMatchObject({ enabled: true, enabled_managed_by: 'catalog' })
      expect(off).toMatchObject({ enabled: false, enabled_managed_by: 'catalog' })

      for (const [row, model] of [
        [on, pick(0)],
        [off, offModel],
      ] as const) {
        const res = await put(row.id, {
          provider: PROVIDER,
          model,
          display_name: 'House name',
          enabled: row.enabled,
        }).expect(200)
        expect(res.body.display_name).toBe('House name')
        expect(await stateOf(corePool, model)).toMatchObject({
          enabled: row.enabled,
          enabled_managed_by: 'catalog',
        })
      }
    })

    it('S-9c: pinEnabled on a stale enabled row hands it to the operator and leaves it on', async () => {
      await autoEnable(true)
      await sync(FULL_CATALOG)
      await sync(withoutModel(FULL_CATALOG, pick(0)))
      const row = await stateOf(corePool, pick(0))
      expect(row).toMatchObject({ enabled: true, stale: true, enabled_managed_by: 'catalog' })

      await put(row.id, { enabled: true, pinEnabled: true }).expect(200)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        enabled: true,
        stale: true,
        enabled_managed_by: 'operator',
      })
    })

    it('S-34: pinEnabled without enabled is a 400 and writes nothing', async () => {
      await autoEnable(true)
      await sync(FULL_CATALOG)
      const row = await stateOf(corePool, pick(0))
      for (const body of [{ pinEnabled: true }, { pinEnabled: true, display_name: 'X' }]) {
        const res = await put(row.id, body).expect(400)
        expect(JSON.stringify(res.body)).toMatch(/pinEnabled requires enabled/)
      }
      expect(await stateOf(corePool, pick(0))).toEqual(row)
      const audit = await corePool.query(`SELECT 1 FROM llm_allowed_models_audit`)
      expect(audit.rows).toEqual([])
    })

    it('S-34b: a pin whose value differs from the locked row turns it on', async () => {
      await autoEnable(false)
      await sync(FULL_CATALOG)
      const row = await stateOf(corePool, pick(0))
      expect(row).toMatchObject({ enabled: false, enabled_managed_by: 'catalog' })

      await put(row.id, { enabled: true, pinEnabled: true }).expect(200)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        enabled: true,
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
      })
    })

    it('S-34c: a pin that turns a row off is a reduction: gated, then off and operator', async () => {
      await autoEnable(true)
      await sync(FULL_CATALOG)
      const row = await stateOf(corePool, pick(0))
      const host = {
        metadata: { name: 'pin-host' },
        spec: { model: { provider: PROVIDER, name: pick(0) } },
      }
      await request(mod.createApp(gateway))
        .post('/api/v1/admin/hosts')
        .set('Cookie', COOKIE)
        .send(host)
        .expect(201)

      const blocked = await put(row.id, { enabled: false, pinEnabled: true }).expect(409)
      expect(blocked.body.error).toBe('model_in_use')
      expect(await stateOf(corePool, pick(0))).toEqual(row)

      await request(mod.createApp(gateway))
        .delete(`/api/v1/admin/hosts/pin-host`)
        .set('Cookie', COOKIE)
        .expect(res => expect([200, 204]).toContain(res.status))
      await put(row.id, { enabled: false, pinEnabled: true }).expect(200)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        enabled: false,
        enabled_managed_by: 'operator',
      })
    })

    it('a rename hands the row to the operator', async () => {
      await autoEnable(false)
      await sync(FULL_CATALOG)
      const row = await stateOf(corePool, pick(0))
      expect(row.enabled_managed_by).toBe('catalog')
      await put(row.id, { model: `${pick(0)}-house` }).expect(200)
      const { rows } = await corePool.query(
        `SELECT enabled_managed_by, auto_disabled_at, attention_ack
           FROM llm_allowed_models WHERE id = $1`,
        [row.id]
      )
      expect(rows[0]).toEqual({
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
        attention_ack: null,
      })
    })
  })

  describe('episode trigger, driven by the sync', () => {
    it('stale entry opens an episode and sets stale_since; leaving clears stale_since', async () => {
      await autoEnable(true)
      await sync(FULL_CATALOG)
      const fresh = await stateOf(corePool, pick(0))
      expect(fresh).toMatchObject({ stale: false, stale_since: null, stale_episode: 0 })

      await sync(withoutModel(FULL_CATALOG, pick(0)))
      const first = await stateOf(corePool, pick(0))
      expect(first.stale).toBe(true)
      expect(first.stale_since).toBeInstanceOf(Date)
      expect(first.stale_episode).toBe(1)
      expect(typeof first.stale_episode).toBe('number')

      // Still absent: the row stays stale, nothing moves.
      await sync(withoutModel(FULL_CATALOG, pick(0)))
      const still = await stateOf(corePool, pick(0))
      expect(still.stale_since).toEqual(first.stale_since)
      expect(still.stale_episode).toBe(1)

      await sync(FULL_CATALOG)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        stale: false,
        stale_since: null,
        stale_episode: 1,
      })

      await sync(withoutModel(FULL_CATALOG, pick(0)))
      const second = await stateOf(corePool, pick(0))
      expect(second.stale_episode).toBe(2)
      expect(second.stale_since!.getTime()).toBeGreaterThan(first.stale_since!.getTime())
    })

    it('S-29b: a row the sync inserts already deprecated starts at deprecated_episode=1', async () => {
      await sync(FULL_CATALOG)
      const row = await stateOf(corePool, DEPRECATED[0]!.model_id)
      expect(row.catalog_status).toBe('deprecated')
      expect(row.deprecated_episode).toBe(1)
      expect(typeof row.deprecated_episode).toBe('number')
      expect((await stateOf(corePool, pick(0))).deprecated_episode).toBe(0)
    })

    it('S-29c: NULL -> deprecated opens an episode, and every re-entry opens another', async () => {
      await sync(FULL_CATALOG)
      const deprecate = (c: RawModelsDevCatalog) =>
        withEntry(c, pick(0), entry => ({ ...entry, status: 'deprecated' }))
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        catalog_status: null,
        deprecated_episode: 0,
      })
      await sync(deprecate(FULL_CATALOG))
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        catalog_status: 'deprecated',
        deprecated_episode: 1,
      })
      await sync(deprecate(FULL_CATALOG))
      expect((await stateOf(corePool, pick(0))).deprecated_episode).toBe(1)
      await sync(FULL_CATALOG)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        catalog_status: null,
        deprecated_episode: 1,
      })
      await sync(deprecate(FULL_CATALOG))
      expect((await stateOf(corePool, pick(0))).deprecated_episode).toBe(2)
    })

    it('an UPDATE that writes the columns without entering a state keeps what it wrote', async () => {
      // The statement under test is the trigger's own contract: the backfill
      // shape, an UPDATE writing the columns directly on a row that does not
      // enter `stale` or `deprecated` in that statement.
      await autoEnable(true)
      await sync(FULL_CATALOG)
      await sync(withoutModel(FULL_CATALOG, pick(0)))
      const staleRow = await stateOf(corePool, pick(0))
      const fixed = new Date('2026-01-02T03:04:05.000Z')
      await corePool.query(
        `UPDATE llm_allowed_models
            SET stale_since = $2, stale_episode = 7, deprecated_episode = 4
          WHERE id = $1`,
        [staleRow.id, fixed]
      )
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        stale: true,
        stale_since: fixed,
        stale_episode: 7,
        deprecated_episode: 4,
      })
    })
  })

  describe('runtime role', () => {
    it('S-17 basis: the runtime appends to and reads llm_catalog_prune_runs, and cannot rewrite it', async () => {
      const runtime = new Pool({ connectionString, options: '-c role=control_api_runtime' })
      extraPools.push(runtime)
      await runtime.query(
        `INSERT INTO llm_catalog_prune_runs
           (sync_ran_at, candidates, prefiltered, examined_locked, pruned, aborted, abort_reason)
         VALUES (NOW(), 3, 1, 2, 1, true, 'host list failed')`
      )
      const read = await runtime.query(
        `SELECT candidates, prefiltered, examined_locked, pruned, aborted, abort_reason
           FROM llm_catalog_prune_runs`
      )
      expect(read.rows).toEqual([
        {
          candidates: 3,
          prefiltered: 1,
          examined_locked: 2,
          pruned: 1,
          aborted: true,
          abort_reason: 'host list failed',
        },
      ])
      await expect(
        runtime.query(`UPDATE llm_catalog_prune_runs SET pruned = 0`)
      ).rejects.toMatchObject({ code: '42501' })
      await expect(runtime.query(`DELETE FROM llm_catalog_prune_runs`)).rejects.toMatchObject({
        code: '42501',
      })
    })

    it('the sync runs under the runtime role with the trigger in place', async () => {
      const runtime = new Pool({ connectionString, options: '-c role=control_api_runtime' })
      extraPools.push(runtime)
      await autoEnable(true)
      await sync(FULL_CATALOG, runtime)
      await sync(withoutModel(FULL_CATALOG, pick(0)), runtime)
      expect(await stateOf(corePool, pick(0))).toMatchObject({
        stale: true,
        stale_episode: 1,
        enabled_managed_by: 'catalog',
      })
    })
  })

  describe('S-16: backfill over rows from the real producers', () => {
    const CATALOG_PROVIDERS = new Set(Object.keys(PROVIDER_KEY_MAP))
    let pool: Pool
    let rows: Map<string, Record<string, unknown>>
    let auditFlagged: Set<string>
    let dismissed: Set<string>
    const key = (provider: unknown, model: unknown) => `${String(provider)}/${String(model)}`
    // Roles over the 0135 capture's openai models.
    const capture = CATALOG_CAPTURE_0135.catalog
    const captureModels = mapCatalogToProviders(capture)[PROVIDER as LlmProviderId]
    const clean = { provider: PROVIDER, model: '' }
    const disabledByOperator = { provider: PROVIDER, model: '' }
    const enabledByOperator = { provider: PROVIDER, model: '' }
    const reinsertedTombstone = { provider: PROVIDER, model: '' }
    const staleBefore = { provider: PROVIDER, model: '' }

    beforeAll(async () => {
      const name = `control_api_prune_backfill_${randomBytes(6).toString('hex')}`
      await adminPool.query(`CREATE DATABASE "${name}"`)
      extraDatabases.push(name)
      pool = new Pool({ connectionString: databaseUrl(adminUrl!, name) })
      extraPools.push(pool)
      await mod.initDb({ connect: () => pool.connect() })

      // An installation that applied the legacy seeds and then 0135, which
      // hands the seeds the catalog lists to the sync with discovered_at NULL.
      await pool.query('DELETE FROM schema_migrations WHERE version = $1', [
        '0135_llm_retire_seeded_catalog',
      ])
      await applyLegacyCatalogSeeds(pool)
      await mod.initDb({ connect: () => pool.connect() })

      // Auto-enable on: the eligible models go in enabled, the rest disabled,
      // so the operator can both really disable one and really enable another.
      await mod.setProviderAutoEnable(PROVIDER, true, 'test-admin', pool)
      const loadCapture = (catalog: RawModelsDevCatalog) =>
        mod.syncDiscoveredModels(
          {
            materializer: new mod.Writer(new FakeConfigMapApi() as never, 'mcp-host', 3, pool),
            loadCatalog: loadStub(catalog, 'live', CATALOG_CAPTURE_0135.capturedAt),
            minPlausibleLiveTotal: 1,
          },
          pool as unknown as SyncConnector
        )
      await loadCapture(capture)
      const synced = await pool.query<{ id: string; model: string; enabled: boolean }>(
        `SELECT id, model, enabled FROM llm_allowed_models
          WHERE provider = $1 AND source = 'discovery' AND discovered_at IS NOT NULL
          ORDER BY model`,
        [PROVIDER]
      )
      const enabledRows = synced.rows.filter(r => r.enabled)
      const disabledRows = synced.rows.filter(r => !r.enabled)
      expect(enabledRows.length).toBeGreaterThanOrEqual(4)
      expect(disabledRows.length).toBeGreaterThanOrEqual(1)
      const [a, b, d, e] = enabledRows
      const c = disabledRows[0]
      clean.model = a!.model
      disabledByOperator.model = b!.model
      enabledByOperator.model = c!.model
      reinsertedTombstone.model = d!.model
      staleBefore.model = e!.model
      expect(captureModels.some(m => m.model_id === staleBefore.model)).toBe(true)

      // Operator activity through the real service (what the router calls).
      await mod.withTransaction(
        tx => mod.updateAllowedModel(c!.id, { enabled: true }, 'test-admin', tx),
        pool
      )
      await mod.withTransaction(
        tx => mod.updateAllowedModel(b!.id, { enabled: false }, 'test-admin', tx),
        pool
      )
      await mod.withTransaction(tx => mod.deleteAllowedModel(d!.id, 'test-admin', tx), pool)
      // The fixtures are what they claim: a real disable of an enabled row, and
      // a real enable of a disabled one, as the producer audits them.
      const operatorAudit = await pool.query<{
        model: string
        action: string
        has_enabled: boolean
      }>(
        `SELECT model, action, detail ? 'enabled' AS has_enabled
           FROM llm_allowed_models_audit
          WHERE provider = $1 AND model = ANY($2::text[])
          ORDER BY model`,
        [PROVIDER, [b!.model, c!.model]]
      )
      expect(operatorAudit.rows).toEqual(
        [
          { model: b!.model, action: 'disable', has_enabled: true },
          { model: c!.model, action: 'update', has_enabled: true },
        ].sort((x, y) => (x.model < y.model ? -1 : 1))
      )
      // The tombstoned pair comes back on the next sync, disabled, with
      // discovered_at set; the stale one vanishes from the catalog.
      const rawStale = Object.entries(capture[PROVIDER_KEY].models).find(([rawId, entry]) => {
        const [m] = mapCatalogToProviders({
          [PROVIDER_KEY]: { ...capture[PROVIDER_KEY], models: { [rawId]: entry } },
        })[PROVIDER as LlmProviderId]
        return m?.model_id === staleBefore.model
      })![0]
      const without = structuredClone(capture)
      delete without[PROVIDER_KEY].models[rawStale]
      await loadCapture(without)

      // Back to the schema before 0139, keeping every row: the producers above
      // run the current code, which writes 0139's columns.
      await pool.query(`
        DROP TRIGGER llm_allowed_models_track_episodes ON llm_allowed_models;
        DROP FUNCTION llm_allowed_models_track_episodes();
        ALTER TABLE llm_allowed_models
          DROP COLUMN enabled_managed_by,
          DROP COLUMN auto_disabled_at,
          DROP COLUMN stale_since,
          DROP COLUMN stale_episode,
          DROP COLUMN deprecated_episode,
          DROP COLUMN attention_ack;
        DROP TABLE llm_catalog_prune_runs;
      `)
      await pool.query('DELETE FROM schema_migrations WHERE version = $1', [MIGRATION])
      await mod.initDb({ connect: () => pool.connect() })

      const all = await pool.query<Record<string, unknown>>(`SELECT * FROM llm_allowed_models`)
      rows = new Map(all.rows.map(r => [key(r.provider, r.model), r]))
      const flagged = await pool.query<{ provider: string; model: string }>(
        `SELECT DISTINCT provider, model FROM llm_allowed_models_audit
          WHERE action = 'disable' OR detail ? 'enabled'`
      )
      auditFlagged = new Set(flagged.rows.map(r => key(r.provider, r.model)))
      const tomb = await pool.query<{ provider: string; model: string }>(
        `SELECT provider, model FROM llm_catalog_dismissed`
      )
      dismissed = new Set(tomb.rows.map(r => key(r.provider, r.model)))
    }, 120_000)

    const at = (pair: { provider: string; model: string }) =>
      rows.get(key(pair.provider, pair.model))!

    it('a clean synced catalog row becomes catalog', () => {
      expect(at(clean).enabled_managed_by).toBe('catalog')
    })

    // The only writer of an audit `disable` (updateAllowedModel) stores the
    // request body as `detail`, and a disable always carries `enabled`, so a
    // disable row also matches `detail ? 'enabled'`. No producer can write a
    // `disable` without it; the two cases below are told apart by the action
    // only in the sense that one is a disable and the other an update.
    it('an operator disable (audit `disable`, detail with `enabled`) stays operator', () => {
      expect(at(disabledByOperator)).toMatchObject({
        enabled: false,
        enabled_managed_by: 'operator',
      })
    })

    it('an operator enable (audit `update` with `enabled`) stays operator', () => {
      expect(at(enabledByOperator)).toMatchObject({ enabled: true, enabled_managed_by: 'operator' })
    })

    it('a pair with a tombstone the sync re-inserted stays operator', () => {
      expect(at(reinsertedTombstone)).toMatchObject({
        enabled: false,
        enabled_managed_by: 'operator',
      })
      expect(at(reinsertedTombstone).discovered_at).not.toBeNull()
    })

    it('the seeded rows 0135 handed to the sync stay operator', () => {
      const seeded = [...rows.values()].filter(
        r => r.source === 'discovery' && r.discovered_at === null
      )
      expect(seeded.length).toBeGreaterThan(0)
      expect(seeded.every(r => r.enabled_managed_by === 'operator')).toBe(true)
    })

    it('every row follows the conservative rule, and nothing else is catalog', () => {
      for (const [k, r] of rows) {
        const expected =
          r.source === 'discovery' &&
          r.discovered_at !== null &&
          CATALOG_PROVIDERS.has(String(r.provider)) &&
          !dismissed.has(k) &&
          !auditFlagged.has(k)
        expect(r.enabled_managed_by, k).toBe(expected ? 'catalog' : 'operator')
      }
    })

    it('rows already stale or deprecated open their first episode at the upgrade', () => {
      const stale = at(staleBefore)
      expect(stale).toMatchObject({ stale: true, stale_episode: 1 })
      expect(stale.stale_since).toBeInstanceOf(Date)
      for (const [k, r] of rows) {
        expect(r.stale_episode, k).toBe(r.stale ? 1 : 0)
        expect(r.stale_since === null, k).toBe(!r.stale)
        expect(r.deprecated_episode, k).toBe(r.catalog_status === 'deprecated' ? 1 : 0)
        expect(r.auto_disabled_at, k).toBeNull()
        expect(r.attention_ack, k).toBeNull()
      }
      expect([...rows.values()].some(r => r.catalog_status === 'deprecated')).toBe(true)
    })
  })
})
