import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'

// R1-H3 fase 2 (llm-model reductor ↔ grant upsert) — regression test for the
// TOCTOU race the per-MODEL advisory lock closes on the grant seam (mini-spec
// "Fase 2 (grant)" / T3 / T4). This seam is PG-ONLY (no K8s write under the lock),
// so — per adenda A4 — the race is driven by TWO REAL Postgres transactions with a
// commit order the TEST controls, and the advisory lock's blocking semantics give
// the determinism (no production test hook).
//
// The reductor side is a raw transaction that calls the REAL producers exactly as
// `gatedReduce` does — take `advisoryLockModelName`, compute the (empty) impact via
// the REAL `computeModelImpact`, `deleteAllowedModel` — then PAUSES before COMMIT so
// the grant can race into the window. The grant side is the REAL admin route over
// HTTP. Fixtures come from real producers (T1): the allowlist row from
// `createAllowedModel`, the grant from the real POST handler + `upsertGrant`.
//
// Run against the parent commit (9dfd4a27, fase 1 only — the grant upsert takes NO
// model lock), the FIRST case fails BY ASSERTION: the grant reads the model as still
// enabled (the reductor's delete is uncommitted), commits, and then the reductor
// deletes the model — leaving a grant that references a deleted model (a dangling
// reference) and answering 200 instead of 400. Skipped without
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

// A provider/model/credentialSlot triple proven valid by the unit suite
// (`routes.adminPluginWorkloadSdk.test.ts`). The model is both a promptTarget
// (so the enabled-ness gate evaluates it) AND in `allowed_models` (so the reductor
// enumerates it by name).
const PROVIDER = 'zai'
const MODEL = 'glm-4.7'
const CREDENTIAL_SLOT = 'zai-api-key'
const TARGET_REF = 'primary-zai'
const RECIPE_NS = 'sandbox-recipes'
const RECIPE_NAME = 'sdk-recipe'
const GRANTS_PATH = '/api/v1/admin/plugin-workload-sdk/grants'

const grantBody = {
  recipeNamespace: RECIPE_NS,
  recipeName: RECIPE_NAME,
  capabilityFamily: 'promptBridge',
  provider: PROVIDER,
  allowedModels: [MODEL],
  promptTargets: [
    { targetRef: TARGET_REF, provider: PROVIDER, model: MODEL, credentialSlot: CREDENTIAL_SLOT },
  ],
  defaultTargetRef: TARGET_REF,
  allowedCallers: ['api'],
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('llm-model reductor ↔ grant upsert serialization (R1-H3 fase 2)', () => {
  const database = `control_api_grant_model_race_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  // A dedicated pool so the raw reductor transaction holds ONE connection (and its
  // session-scoped advisory lock) independent of the app's module pool. Advisory
  // locks are database-global, so a lock taken here blocks the app's grant upsert.
  let racePool: Pool
  // Loaded dynamically AFTER the env points the module pool at the test DB.
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    config: typeof import('../src/config.js').config
    pool: import('../src/db.js').DbClient
    createAllowedModel: typeof import('../src/services/llmAllowedModels.js').createAllowedModel
    deleteAllowedModel: typeof import('../src/services/llmAllowedModels.js').deleteAllowedModel
    advisoryLockModelName: typeof import('../src/db.js').advisoryLockModelName
    computeModelImpact: typeof import('../src/services/llmModelImpact.js').computeModelImpact
    modelImpactHasReferences: typeof import('../src/services/llmModelImpact.js').modelImpactHasReferences
    modelImpactSourcesFromGatewayTx: typeof import('../src/services/llmModelImpact.js').modelImpactSourcesFromGatewayTx
    listGrants: typeof import('../src/services/pluginWorkloadSdkDb.js').listGrants
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }
  let hostNamespaces: string[]

  type DbClientCast = import('../src/db.js').DbClient

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)

    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await migratePool.end()

    racePool = new Pool({ connectionString })
    racePool.on('error', () => {})

    const appMod = await import('../src/app.js')
    const configMod = await import('../src/config.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const impactMod = await import('../src/services/llmModelImpact.js')
    const sdkDbMod = await import('../src/services/pluginWorkloadSdkDb.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      config: configMod.config,
      pool: dbMod.pool,
      createAllowedModel: allowlistMod.createAllowedModel,
      deleteAllowedModel: allowlistMod.deleteAllowedModel,
      advisoryLockModelName: dbMod.advisoryLockModelName,
      computeModelImpact: impactMod.computeModelImpact,
      modelImpactHasReferences: impactMod.modelImpactHasReferences,
      modelImpactSourcesFromGatewayTx: impactMod.modelImpactSourcesFromGatewayTx,
      listGrants: sdkDbMod.listGrants,
      MockGateway,
    }
    // Same single source of truth for "where Hosts live" the reductor route uses.
    hostNamespaces = Array.from(new Set([mod.config.hostsNamespace, mod.config.namespace]))
  }, 60_000)

  afterAll(async () => {
    if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
    else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
    await racePool?.end().catch(() => {})
    await corePool?.end().catch(() => {})
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
    await adminPool.end()
  })

  beforeEach(async () => {
    mockVerifyAdminToken.mockReset().mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset().mockResolvedValue(false)
    mockFindAdminById.mockReset().mockResolvedValue(ACTIVE_ADMIN)
    await mod.pool.query('DELETE FROM plugin_workload_sdk_grants')
    await mod.pool.query('DELETE FROM llm_allowed_models')
  })

  afterEach(async () => {
    await mod.pool.query('DELETE FROM plugin_workload_sdk_grants')
    await mod.pool.query('DELETE FROM llm_allowed_models')
  })

  async function seedEnabledModel(): Promise<string> {
    const row = await mod.createAllowedModel(
      { provider: PROVIDER, model: MODEL, enabled: true },
      'test-actor'
    )
    return row.id
  }

  async function grantRowCount(): Promise<number> {
    const rows = await mod.listGrants({ recipeNamespace: RECIPE_NS, recipeName: RECIPE_NAME })
    return rows.length
  }

  async function modelRow(id: string): Promise<{ enabled: boolean } | undefined> {
    const res = await mod.pool.query('SELECT enabled FROM llm_allowed_models WHERE id = $1', [id])
    return res.rows[0] as { enabled: boolean } | undefined
  }

  // Wait until the grant row is COMMITTED (parent ordering — the grant slipped in),
  // or the budget elapses (child ordering — the grant is BLOCKED on the model lock).
  async function waitForGrantOrBudget(budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if ((await grantRowCount()) > 0) return
      await new Promise(r => setTimeout(r, 25))
    }
  }

  it('reductor commits first → grant is rejected under the model lock (no dangling grant)', async () => {
    const id = await seedEnabledModel()
    const gateway = new mod.MockGateway()
    const app = mod.createApp(gateway)

    // REDUCTOR as a raw transaction (adenda A4). Faithfully mirrors gatedReduce
    // via the real producers, then PAUSES before COMMIT holding the model lock.
    const rClient = await racePool.connect()
    let grantDone!: Promise<request.Response>
    try {
      await rClient.query('BEGIN')
      await mod.advisoryLockModelName(rClient as unknown as DbClientCast, MODEL)
      const impact = await mod.computeModelImpact(
        PROVIDER,
        MODEL,
        mod.modelImpactSourcesFromGatewayTx(
          gateway,
          hostNamespaces,
          rClient as unknown as DbClientCast
        )
      )
      // The grant has not committed yet → the reductor sees NO reference.
      expect(mod.modelImpactHasReferences(impact)).toBe(false)
      await mod.deleteAllowedModel(id, 'test-reductor', rClient as unknown as DbClientCast)
      // The DELETE is now staged but UNCOMMITTED, and the reductor holds the lock.

      // Fire the grant upsert over the REAL route while the reductor holds the lock.
      grantDone = Promise.resolve(
        request(app).post(GRANTS_PATH).set('Cookie', COOKIE).send(grantBody)
      )

      // Parent: the grant takes no lock → it reads the (uncommitted-deleted) model as
      // enabled and COMMITS → the row appears, we stop waiting. Child: the grant
      // BLOCKS on the model lock → no row → we wait the full budget.
      await waitForGrantOrBudget(1_500)

      await rClient.query('COMMIT') // reductor wins: model deleted, lock released
    } finally {
      rClient.release()
    }

    const grantRes = await grantDone

    // Observable final state (T4). Child (fixed): the grant lost — it re-read the
    // model under the lock, found it deleted, and 400'd; nothing dangling. Parent
    // (fase 1 only): the grant was created against a now-deleted model — a dangling
    // reference — and answered 200; these assertions FAIL there.
    expect(grantRes.status).toBe(400)
    expect(grantRes.body.error).toBe('model_not_allowed')
    expect(await modelRow(id)).toBeUndefined() // reductor's delete stands
    expect(await grantRowCount()).toBe(0) // no grant references the deleted model
  }, 30_000)

  it('grant commits first → reductor sees it and 409s (no dangling reference)', async () => {
    const id = await seedEnabledModel()
    const gateway = new mod.MockGateway()
    const app = mod.createApp(gateway)

    const grantRes = await request(app).post(GRANTS_PATH).set('Cookie', COOKIE).send(grantBody)
    expect(grantRes.status).toBe(200)

    const reductorRes = await request(app)
      .delete(`/api/v1/admin/llm-models/${id}`)
      .set('Cookie', COOKIE)

    expect(reductorRes.status).toBe(409)
    expect(reductorRes.body.error).toBe('model_in_use')
    expect(
      (reductorRes.body.impact.grantsAffected as Array<{ recipeName: string }>).map(
        g => g.recipeName
      )
    ).toContain(RECIPE_NAME)
    expect((await modelRow(id))?.enabled).toBe(true) // model untouched
    expect(await grantRowCount()).toBe(1) // grant intact
  }, 30_000)
})
