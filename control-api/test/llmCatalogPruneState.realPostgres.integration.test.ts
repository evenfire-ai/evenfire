import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
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

// Migrations 0139/0140 and the writers of the authority over `enabled`, on
// real PostgreSQL: who owns `enabled` after a sync INSERT and after each kind
// of admin PUT (decided on the row the service locks), the episode trigger as
// the sync drives it, the conservative backfill over a database whose rows
// came from the real producers, the runtime role's grants on the prune log,
// the columns migration's lock_timeout behind a reader, and the previous
// image's statements over the migrated table. Rows are only ever written by
// the sync, the admin router or service, the legacy seed migrations, the
// migrations themselves and the previous image's verbatim statements. Skipped
// without CONTROL_API_REAL_PG_ADMIN_URL.

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
const MIGRATIONS = ['0139_llm_catalog_prune_columns', '0140_llm_catalog_prune_episodes']

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

/** Back to the schema before the prune-state migrations, keeping every row. */
async function undoPruneStateMigrations(pool: Pool): Promise<void> {
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
  await pool.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [MIGRATIONS])
}

/**
 * Back to the database between the two migrations: the columns at the
 * defaults the columns migration gives every existing row, no trigger.
 */
async function undoEpisodesMigration(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TRIGGER llm_allowed_models_track_episodes ON llm_allowed_models;
    DROP FUNCTION llm_allowed_models_track_episodes();
    DROP TABLE llm_catalog_prune_runs;
    UPDATE llm_allowed_models
       SET enabled_managed_by = 'operator', auto_disabled_at = NULL, stale_since = NULL,
           stale_episode = 0, deprecated_episode = 0, attention_ack = NULL;
  `)
  await pool.query('DELETE FROM schema_migrations WHERE version = $1', [MIGRATIONS[1]])
}

async function pruneStateColumns(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'llm_allowed_models'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [PRUNE_STATE_COLUMNS]
  )
  return rows.map(r => r.column_name)
}

async function recordedPruneStateVersions(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version`,
    [MIGRATIONS]
  )
  return rows.map(r => r.version)
}

const PRUNE_STATE_COLUMNS = [
  'attention_ack',
  'auto_disabled_at',
  'deprecated_episode',
  'enabled_managed_by',
  'stale_episode',
  'stale_since',
]

/*
 * The statements the image before this change runs on llm_allowed_models,
 * copied verbatim from the merge base (control-api/src/services/llmCatalogSync.ts
 * and the SET list llmAllowedModels.ts builds for an `enabled` PUT). They are
 * checked against that commit below when it is in the clone.
 */
// The commit this change branched from. When a sync with dev brings changes to
// these statements, move it to the new merge base and copy them again.
const PREVIOUS_IMAGE_BASE = 'e611ebfcb'
const PREVIOUS_SYNC_INSERT = `INSERT INTO llm_allowed_models
       (provider, model, enabled, source, discovered_at, last_seen_at, stale,
        context_window_tokens, display_name, image_input, catalog_status)
     VALUES ($1, $2,
             $6::boolean AND NOT EXISTS (
               SELECT 1 FROM llm_catalog_dismissed d
                WHERE d.provider = $1 AND d.model = $2
             ),
             'discovery', NOW(), NOW(), false, $3, $4, $5::jsonb, $7)
     ON CONFLICT (provider, model) DO NOTHING
     RETURNING enabled,
               EXISTS (
                 SELECT 1 FROM llm_catalog_dismissed d
                  WHERE d.provider = $1 AND d.model = $2
               ) AS dismissed`
const PREVIOUS_SYNC_MARK_STALE = `UPDATE llm_allowed_models
        SET stale = true
      WHERE provider = $1
        AND source = 'discovery'
        AND stale = false
        AND model <> ALL($2::text[])`
const PREVIOUS_MODEL_COLUMNS = `
  id, provider, model, vendor, display_name,
  context_window_tokens, enabled, source, discovered_at, last_seen_at, stale,
  image_input, created_at, updated_at
`
const PREVIOUS_PUT_LOCK_ROW = `SELECT ${PREVIOUS_MODEL_COLUMNS} FROM llm_allowed_models WHERE id = $1 FOR UPDATE`
const PREVIOUS_PUT_ENABLED = `UPDATE llm_allowed_models
          SET enabled = $1, updated_at = NOW()
        WHERE id = $2`

function previousImageSource(path: string): string | null {
  try {
    return execFileSync('git', ['show', `${PREVIOUS_IMAGE_BASE}:control-api/${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

describeRealPostgres('0139/0140 enabled authority and episodes (real PostgreSQL)', () => {
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
    discoveryImageInput: typeof import('../src/services/llmCatalogSync.js').discoveryImageInput
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
      discoveryImageInput: syncMod.discoveryImageInput,
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
      await undoPruneStateMigrations(pool)
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

  describe('the columns migration under a lock_timeout', () => {
    it('gives up after about 2 s behind a reader, leaves nothing applied, and converges on the retry', async () => {
      const name = `control_api_prune_locks_${randomBytes(6).toString('hex')}`
      await adminPool.query(`CREATE DATABASE "${name}"`)
      extraDatabases.push(name)
      const pool = new Pool({ connectionString: databaseUrl(adminUrl!, name), max: 4 })
      pool.on('error', () => {})
      extraPools.push(pool)
      await mod.initDb({ connect: () => pool.connect() })
      await undoPruneStateMigrations(pool)
      expect(await pruneStateColumns(pool)).toEqual([])

      // A reader of the previous image, mid-transaction: AccessShareLock held.
      const reader = await pool.connect()
      let failure: unknown
      let elapsedMs = 0
      try {
        await reader.query('BEGIN')
        await reader.query('SELECT count(*) FROM llm_allowed_models')
        const started = Date.now()
        failure = await mod.initDb({ connect: () => pool.connect() }).then(
          () => null,
          (err: unknown) => err
        )
        elapsedMs = Date.now() - started
      } finally {
        await reader.query('ROLLBACK').catch(() => {})
        reader.release()
      }
      expect(failure).toMatchObject({ code: '55P03' })
      // Bounded by the migration's own 2 s, not by the Job's 10 s default.
      expect(elapsedMs).toBeGreaterThanOrEqual(1_800)
      expect(elapsedMs).toBeLessThan(6_000)
      expect(await pruneStateColumns(pool)).toEqual([])
      expect(await recordedPruneStateVersions(pool)).toEqual([])

      await mod.initDb({ connect: () => pool.connect() })
      expect(await pruneStateColumns(pool)).toEqual(PRUNE_STATE_COLUMNS)
      expect(await recordedPruneStateVersions(pool)).toEqual(MIGRATIONS)
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgname = 'llm_allowed_models_track_episodes' AND NOT tgisinternal`
      )
      expect(rows).toEqual([{ n: 1 }])
    }, 60_000)
  })

  // The episodes migration against a writer of the previous image that lands
  // between its backfill and its trigger. The migration is paused there by the
  // test's own connector, just before the statement that creates the trigger.
  describe('the episodes migration against a concurrent writer of the previous image', () => {
    async function pausedMigration(pool: Pool) {
      let reached!: () => void
      const atTrigger = new Promise<void>(resolve => (reached = resolve))
      let release!: () => void
      const resume = new Promise<void>(resolve => (release = resolve))
      const connect = async () => {
        const client = await pool.connect()
        return new Proxy(client, {
          get(target, prop) {
            if (prop === 'query') {
              return async (text: unknown, values?: unknown) => {
                if (
                  typeof text === 'string' &&
                  text.includes('CREATE OR REPLACE FUNCTION llm_allowed_models_track_episodes')
                ) {
                  reached()
                  await resume
                }
                return (target.query as (...a: unknown[]) => unknown)(text, values)
              }
            }
            const value = Reflect.get(target, prop, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      }
      const migration = mod.initDb({ connect } as never)
      return { migration, atTrigger, release }
    }

    /** Resolve once `pid` waits on a lock, or `settled` resolves first. */
    async function blockedOrDone(pool: Pool, pid: number, settled: Promise<unknown>) {
      let done = false
      void settled.finally(() => (done = true))
      const deadline = Date.now() + 5_000
      while (!done && Date.now() < deadline) {
        const { rows } = await pool.query<{ waiting: boolean }>(
          `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
          [pid]
        )
        if (rows[0]?.waiting) return 'blocked'
        await new Promise(r => setTimeout(r, 20))
      }
      return done ? 'done' : 'neither'
    }

    async function prepared() {
      const name = `control_api_prune_episodes_${randomBytes(6).toString('hex')}`
      await adminPool.query(`CREATE DATABASE "${name}"`)
      extraDatabases.push(name)
      const pool = new Pool({ connectionString: databaseUrl(adminUrl!, name), max: 6 })
      pool.on('error', () => {})
      extraPools.push(pool)
      await mod.initDb({ connect: () => pool.connect() })
      await autoEnable(false, pool)
      await sync(FULL_CATALOG, pool)
      // An operator's enable: its audit names `enabled`, so the backfill
      // neither classifies nor locks this row.
      const operatorRow = await stateOf(pool, pick(0))
      await mod.withTransaction(
        db => mod.updateAllowedModel(operatorRow.id, { enabled: true }, 'test-admin', db),
        pool
      )
      // Stale before the episodes migration: its backfill gives it stale_since
      // and an episode, so it locks this row.
      await sync(withoutModel(FULL_CATALOG, pick(2)), pool)
      await undoEpisodesMigration(pool)
      return { pool, unlocked: pick(0), backfilled: pick(1), stale: pick(2) }
    }

    /** The previous image's sync marking `model` stale (every other model listed). */
    function markStale(pool: Pool, model: string) {
      const listed = discovered(FULL_CATALOG)
        .map(m => m.model_id)
        .filter(m => m !== model)
      return pool.connect().then(async client => {
        const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const write = client.query(PREVIOUS_SYNC_MARK_STALE, [PROVIDER, listed])
        write.finally(() => client.release()).catch(() => {})
        return { pid, write }
      })
    }

    it('a PUT of the previous image that already holds its row FOR UPDATE does not deadlock', async () => {
      const ctx = await prepared()
      const { id } = await stateOf(ctx.pool, ctx.stale)
      const writer = await ctx.pool.connect()
      let migrated: Promise<unknown> = Promise.resolve(null)
      try {
        const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        // The previous PUT: row lock first, its UPDATE after.
        await writer.query('BEGIN')
        await writer.query(PREVIOUS_PUT_LOCK_ROW, [id])
        migrated = mod.initDb({ connect: () => ctx.pool.connect() }).then(
          () => null,
          (err: unknown) => err
        )
        expect(await otherSessionWaits(ctx.pool, writerPid, migrated)).toBe(true)
        const finished = (async () => {
          await writer.query(PREVIOUS_PUT_ENABLED, [false, id])
          await writer.query('COMMIT')
        })().then(
          () => null,
          (err: unknown) => err
        )
        expect(await finished).toBeNull()
        expect(await migrated).toBeNull()
      } finally {
        await writer.query('ROLLBACK').catch(() => {})
        writer.release()
        await migrated
      }
      const row = await stateOf(ctx.pool, ctx.stale)
      expect(row).toMatchObject({ enabled: false, stale: true, stale_episode: 1 })
      expect(row.stale_since).toBeInstanceOf(Date)
    }, 60_000)

    /** True once a session other than `pid` waits on a lock, false if `settled` resolves first. */
    async function otherSessionWaits(pool: Pool, pid: number, settled: Promise<unknown>) {
      let done = false
      void settled.finally(() => (done = true))
      const deadline = Date.now() + 5_000
      while (!done && Date.now() < deadline) {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> $1 AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'`,
          [pid]
        )
        if (rows[0]!.n > 0) return true
        await new Promise(r => setTimeout(r, 20))
      }
      return false
    }

    it.each([
      ['a row the backfill does not lock waits for the trigger', 'unlocked'],
      ['a row the backfill locked does not deadlock', 'backfilled'],
    ] as const)(
      '%s',
      async (_label, which) => {
        const ctx = await prepared()
        const model = ctx[which]
        const { migration, atTrigger, release } = await pausedMigration(ctx.pool)
        const migrated = migration.then(
          () => null,
          (err: unknown) => err
        )
        await atTrigger
        const writer = await markStale(ctx.pool, model)
        const written = writer.write.then(
          () => null,
          (err: unknown) => err
        )
        // The writer is held back by the migration's table lock before the
        // trigger exists; it must not commit a stale row the trigger never saw.
        expect(await blockedOrDone(ctx.pool, writer.pid, written)).toBe('blocked')
        release()
        expect(await migrated).toBeNull()
        expect(await written).toBeNull()
        const row = await stateOf(ctx.pool, model)
        expect(row.stale).toBe(true)
        expect(row.stale_since).toBeInstanceOf(Date)
        expect(row.stale_episode).toBe(1)
      },
      60_000
    )
  })

  describe('the image before this change, after the migrations', () => {
    it('runs its statements verbatim from the merge base', ctx => {
      const sync = previousImageSource('src/services/llmCatalogSync.ts')
      const allowed = previousImageSource('src/services/llmAllowedModels.ts')
      // A clone without that commit (a shallow CI checkout) cannot check the copy.
      if (sync === null || allowed === null) {
        ctx.skip()
        return
      }
      expect(sync).toContain(PREVIOUS_SYNC_INSERT)
      expect(sync).toContain(PREVIOUS_SYNC_MARK_STALE)
      expect(sync).not.toContain('enabled_managed_by')
      // The PUT builds `SET ${sets.join(', ')}` from `<column> = $<n>` and then
      // appends `updated_at = NOW()`; for an `enabled`-only body that is the
      // statement above.
      expect(allowed).toContain(
        "`UPDATE llm_allowed_models\n          SET ${sets.join(', ')}\n        WHERE id = $${idx}"
      )
      expect(allowed).toContain('sets.push(`updated_at = NOW()`)')
      expect(allowed).toContain('const MODEL_COLUMNS = `' + PREVIOUS_MODEL_COLUMNS + '`')
      expect(allowed).toContain(
        '`SELECT ${MODEL_COLUMNS} FROM llm_allowed_models WHERE id = $1 FOR UPDATE`'
      )
      expect(allowed).not.toContain('enabled_managed_by')
    })

    it('gets the defaults: operator rows, no token, episodes opened by the trigger', async () => {
      const [ga, deprecated] = [pick(0), pick(1)]
      // The parameters the previous sync passes, from the same producers.
      const entry = (model: string) => ELIGIBLE.find(m => m.model_id === model)!
      const insert = (model: string, status: string | null) =>
        corePool.query(PREVIOUS_SYNC_INSERT, [
          PROVIDER,
          model,
          null,
          entry(model).display_name ?? null,
          JSON.stringify(
            mod.discoveryImageInput(
              entry(model).image_input_state,
              LIVE_MODELS_DEV_CAPTURED_AT,
              86_400_000
            )
          ),
          true,
          status,
        ])
      await insert(ga, null)
      await insert(deprecated, 'deprecated')
      const fresh = await stateOf(corePool, ga)
      expect(fresh).toMatchObject({
        enabled: true,
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
        stale_since: null,
        stale_episode: 0,
        deprecated_episode: 0,
        attention_ack: null,
      })
      expect(await stateOf(corePool, deprecated)).toMatchObject({
        enabled_managed_by: 'operator',
        deprecated_episode: 1,
      })

      await corePool.query(PREVIOUS_SYNC_MARK_STALE, [PROVIDER, [deprecated]])
      const stale = await stateOf(corePool, ga)
      expect(stale).toMatchObject({ stale: true, stale_episode: 1, enabled_managed_by: 'operator' })
      expect(stale.stale_since).toBeInstanceOf(Date)

      await corePool.query(PREVIOUS_PUT_ENABLED, [false, fresh.id])
      expect(await stateOf(corePool, ga)).toMatchObject({
        enabled: false,
        enabled_managed_by: 'operator',
        auto_disabled_at: null,
        stale_episode: 1,
      })
    })
  })
})
