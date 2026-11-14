// Regenerate after an intended contract change (needs a real Postgres):
// `CONTROL_API_REAL_PG_ADMIN_URL=postgres://… UPDATE_WIRE_GOLDENS=1 npx vitest run test/contracts.llmAttention.wire.realPostgres.integration.test.ts`,
// then review the JSON diff of both files it writes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * SQL, and the Hosts are created through the real admin Host route. The only
 * stand-ins are the admin session and the Kubernetes API (MockGateway, fake
 * ConfigMap). `generatedAt` is the one value pinned after the fact, because it
 * is the request instant.
 *
 * The same run then writes a second file, `llmAttention.reviewed.wire.json`,
 * for the fields the first state never carries: a WorkflowRecipe is created
 * through the real admin recipe route naming the dropped model `agent-a` uses,
 * so that item gains `recipesAffected` and the recipe's key in `consumerKeys`;
 * the deprecated item is acknowledged through the real ack route with the
 * episode and keys the feed returned; and the feed is read with
 * `includeAcknowledged=1`, the only read that returns it, as
 * `acknowledged: true`. It is a separate file, captured after the first, so
 * the first keeps describing a feed nobody has reviewed yet.
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
const REVIEWED_FILE = new URL('llmAttention.reviewed.wire.json', DIR)
const PINNED_GENERATED_AT = '2026-11-01T00:00:00.000Z'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const PROVIDER = 'claude' as const
const HOST_NAMESPACE = 'mcp-host'
const RECIPE_NAME = 'recipe-a'

type AttentionWireItem = {
  kind: string
  provider: string
  model: string
  hostsAffected: Array<{ roles: string[] }>
  episode: number
  consumerKeys: string[]
  recipesAffected?: Array<{ namespace: string; name: string }>
  acknowledged?: true
}
type AttentionWireBody = { items: AttentionWireItem[]; generatedAt: string }

function writeOrCompare(file: URL, actual: unknown): void {
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
  }
  // An assertion, not a read error, when the golden was never generated.
  expect(existsSync(file), `${file.pathname} is committed`).toBe(true)
  const committed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  expect(actual).toEqual(committed)
}

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
  // describe.skip still runs this factory, so it must not build a URL without the env.
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
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
    const [deprecatedId, staleReferencedId, staleImplicitId] = eligible
    // The to-be-deprecated model's catalog name equals its id, so the wire carries
    // an item whose displayName === model. It goes in this run because the sync
    // freezes display_name on enabled rows: renaming it in the second run would
    // not reach the wire.
    await sync(patched(base, rawIdOf(base, deprecatedId), { name: deprecatedId }))

    // Second run: the catalog deprecates one model and drops two. The sync keeps
    // all three enabled (it only informs).
    await sync(
      without(patched(base, rawIdOf(base, deprecatedId), { status: 'deprecated' }), [
        rawIdOf(base, staleReferencedId),
        rawIdOf(base, staleImplicitId),
      ])
    )
    // Only models somebody uses reach the feed. `agent-a` names one dropped
    // model and, having no `allowedModels`, offers every enabled model of the
    // provider: the other dropped model is an item only through that implicit
    // offer (role `implicit`). `agent-b` names the deprecated model, which needs
    // an explicit consumer to be an item.
    const gateway = new MockGateway(HOST_NAMESPACE)
    const app = createApp(gateway as never)
    const hosts = [
      {
        metadata: { name: 'agent-a' },
        spec: { model: { provider: PROVIDER, name: staleReferencedId } },
      },
      {
        metadata: { name: 'agent-b' },
        spec: {
          model: { provider: PROVIDER, name: deprecatedId },
          allowedModels: [{ provider: PROVIDER, model: deprecatedId }],
        },
      },
    ]
    for (const host of hosts) {
      await request(app).post('/api/v1/admin/hosts').set('Cookie', COOKIE).send(host).expect(201)
    }

    const res = await request(app).get('/api/v1/admin/attention').set('Cookie', COOKIE).expect(200)
    const body = res.body as AttentionWireBody
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)
    // Both kinds with an explicit consumer, plus one item carried only by the
    // implicit offer; the retired stale_discovery_enabled kind never appears.
    expect(body.items.map(i => `${i.kind}:${i.model}`).sort()).toEqual(
      [
        `deprecated_model_enabled:${deprecatedId}`,
        `stale_model_referenced:${staleReferencedId}`,
        `stale_model_referenced:${staleImplicitId}`,
      ].sort()
    )
    expect(
      body.items.find(i => i.model === staleImplicitId)?.hostsAffected.flatMap(h => h.roles)
    ).toEqual(['implicit'])

    writeOrCompare(FILE, { ...body, generatedAt: PINNED_GENERATED_AT })

    // Reviewed state. The recipe names the model `agent-a` already names, so
    // its item carries a Host and a recipe consumer at once.
    const { config } = await import('../src/config.js')
    await request(app)
      .post('/api/v1/admin/recipes')
      .set('Cookie', COOKIE)
      .send({
        metadata: { name: RECIPE_NAME },
        spec: {
          triggers: { onDemand: { allowedActors: ['user'] } },
          agent: { provider: PROVIDER, model: staleReferencedId },
          steps: [{ id: 's1', instruction: 'go' }],
        },
      })
      .expect(r => expect(r.status, JSON.stringify(r.body)).toBe(201))
    const withRecipe = (
      await request(app).get('/api/v1/admin/attention').set('Cookie', COOKIE).expect(200)
    ).body as AttentionWireBody
    const deprecatedItem = withRecipe.items.find(i => i.model === deprecatedId)
    expect(deprecatedItem?.kind).toBe('deprecated_model_enabled')
    await request(app)
      .post('/api/v1/admin/attention/ack')
      .set('Cookie', COOKIE)
      .send({
        provider: deprecatedItem!.provider,
        model: deprecatedItem!.model,
        kind: deprecatedItem!.kind,
        episode: deprecatedItem!.episode,
        consumerKeys: deprecatedItem!.consumerKeys,
      })
      .expect(200)
    // The default read now omits the acknowledged item.
    const unreviewed = (
      await request(app).get('/api/v1/admin/attention').set('Cookie', COOKIE).expect(200)
    ).body as AttentionWireBody
    expect(unreviewed.items.map(i => i.model)).not.toContain(deprecatedId)

    const reviewed = (
      await request(app)
        .get('/api/v1/admin/attention?includeAcknowledged=1')
        .set('Cookie', COOKIE)
        .expect(200)
    ).body as AttentionWireBody
    const recipeRef = { namespace: config.sandboxNamespace, name: RECIPE_NAME }
    expect(reviewed.items.map(i => `${i.kind}:${i.model}`).sort()).toEqual(
      body.items.map(i => `${i.kind}:${i.model}`).sort()
    )
    const recipeItem = reviewed.items.find(i => i.model === staleReferencedId)
    expect(recipeItem?.recipesAffected).toEqual([recipeRef])
    expect(recipeItem?.consumerKeys).toContain(`recipe:${recipeRef.namespace}/${recipeRef.name}`)
    expect(recipeItem?.consumerKeys).toContain(`host:${HOST_NAMESPACE}/agent-a`)
    expect(recipeItem?.acknowledged).toBeUndefined()
    expect(reviewed.items.filter(i => i.acknowledged === true).map(i => i.model)).toEqual([
      deprecatedId,
    ])

    writeOrCompare(REVIEWED_FILE, { ...reviewed, generatedAt: PINNED_GENERATED_AT })
  }, 60_000)
})
