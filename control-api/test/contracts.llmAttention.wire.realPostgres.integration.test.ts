// Regenerate after an intended contract change (needs a real Postgres):
// `CONTROL_API_REAL_PG_ADMIN_URL=postgres://… UPDATE_WIRE_GOLDENS=1 npx vitest run test/contracts.llmAttention.wire.realPostgres.integration.test.ts`,
// then review the JSON diff.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import request from 'supertest'
import type { LlmProviderId } from '@clerum/llm-providers'
import {
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

/**
 * The `GET /admin/attention` wire contract, consumed by control-ui's tests
 * (control-ui/test/fixtures/llmAttention.ts) instead of a hand-written mirror.
 *
 * Every byte comes from the real producers against real PostgreSQL: the catalog
 * sync writes the rows (from the captured live models.dev fixture — a later run
 * deprecates one model and drops two), the real route reads them with its own
 * SQL, and the Host reference comes from the real gateway producer. The only
 * stand-ins are the admin session and the Kubernetes API (MockGateway, fake
 * ConfigMap). `generatedAt` is the one value pinned after the fact, because it
 * is the request instant.
 *
 * Named `*.realPostgres.integration` so the real-Postgres CI lane runs it; the
 * ordinary matrix skips it without CONTROL_API_REAL_PG_ADMIN_URL.
 */

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

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const DIR = new URL('./fixtures/wire/', import.meta.url)
const FILE = new URL('llmAttention.wire.json', DIR)
const PINNED_GENERATED_AT = '2026-11-01T00:00:00.000Z'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const PROVIDER = 'claude' as const
const HOST_NAMESPACE = 'mcp-host'

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const providerKey = PROVIDER_KEY_MAP[PROVIDER]

function wholeProvider(): RawModelsDevCatalog {
  return trimLiveCatalog({
    [providerKey]: Object.keys(LIVE_MODELS_DEV_CATALOG[providerKey].models).length,
  })
}

/** Raw entry id whose mapped model id is `modelId` (they can differ by normalization). */
function rawIdOf(catalog: RawModelsDevCatalog, modelId: string): string {
  for (const rawId of Object.keys(catalog[providerKey].models)) {
    const [mapped] = mapCatalogToProviders({
      [providerKey]: {
        name: catalog[providerKey].name,
        models: { [rawId]: catalog[providerKey].models[rawId] },
      },
    })[PROVIDER as LlmProviderId]
    if (mapped?.model_id === modelId) return rawId
  }
  throw new Error(`rawIdOf: ${PROVIDER}/${modelId} not in catalog`)
}

function patched(
  catalog: RawModelsDevCatalog,
  rawId: string,
  patch: Partial<RawModelsDevModel>
): RawModelsDevCatalog {
  const models = catalog[providerKey].models
  return {
    ...catalog,
    [providerKey]: {
      ...catalog[providerKey],
      models: { ...models, [rawId]: { ...models[rawId], ...patch } },
    },
  }
}

function without(catalog: RawModelsDevCatalog, rawIds: string[]): RawModelsDevCatalog {
  const models = { ...catalog[providerKey].models }
  for (const id of rawIds) delete models[id]
  return { ...catalog, [providerKey]: { ...catalog[providerKey], models } }
}

describeRealPostgres('attention wire contract (real PostgreSQL)', () => {
  const database = `control_api_attention_wire_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool

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

  it('matches the committed fixture', async () => {
    const { createApp } = await import('../src/app.js')
    const { MockGateway } = await import('./mockGateway.js')
    const { syncDiscoveredModels } = await import('../src/services/llmCatalogSync.js')
    const { LlmAllowedModelsConfigMapWriter } =
      await import('../src/services/llmAllowedModelsConfigMap.js')
    const cluster = new FakeConfigMapApi()
    const sync = (catalog: RawModelsDevCatalog) =>
      syncDiscoveredModels(
        {
          materializer: new LlmAllowedModelsConfigMapWriter(
            cluster as never,
            HOST_NAMESPACE,
            3,
            corePool
          ),
          loadCatalog: loadStub(catalog, 'live', LIVE_MODELS_DEV_CAPTURED_AT),
          minPlausibleLiveTotal: 1,
          autoEnableMaxPerProviderPerRun: 1_000,
          autoEnableMaxPerRun: 10_000,
        },
        corePool as never
      )

    // First run: the provider is ON by default, so eligible models land enabled.
    const base = wholeProvider()
    const eligible = mapCatalogToProviders(base)
      [PROVIDER as LlmProviderId].filter(isAutoEnableEligible)
      .map(m => m.model_id)
      .sort()
    expect(eligible.length).toBeGreaterThanOrEqual(3)
    const [deprecatedId, staleReferencedId, staleUnreferencedId] = eligible
    await sync(base)

    // Second run: the catalog deprecates one model and drops two. The sync keeps
    // all three enabled (it only informs); one of the dropped ones is still the
    // primary model of a Host.
    await sync(
      without(patched(base, rawIdOf(base, deprecatedId), { status: 'deprecated' }), [
        rawIdOf(base, staleReferencedId),
        rawIdOf(base, staleUnreferencedId),
      ])
    )
    const gateway = new MockGateway(HOST_NAMESPACE)
    await gateway.createResource(
      'hosts',
      {
        metadata: { name: 'agent-a' },
        spec: { model: { provider: PROVIDER, name: staleReferencedId } },
      },
      HOST_NAMESPACE
    )

    const res = await request(createApp(gateway as never))
      .get('/api/v1/admin/attention')
      .set('Cookie', COOKIE)
      .expect(200)
    const body = res.body as { items: Array<{ kind: string }>; generatedAt: string }
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)
    // One item of each kind is what the consumer needs; the dropped referenced
    // model also yields its stale-discovery item.
    expect(body.items.map(i => i.kind).sort()).toEqual([
      'deprecated_model_enabled',
      'stale_discovery_enabled',
      'stale_discovery_enabled',
      'stale_model_referenced',
    ])

    const actual = { ...body, generatedAt: PINNED_GENERATED_AT }
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(FILE, `${JSON.stringify(actual, null, 2)}\n`)
    }
    const committed = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
    expect(actual).toEqual(committed)
  }, 60_000)
})
