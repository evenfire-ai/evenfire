import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'

// R1-H3 fase 1 (host↔model) — regression test for the TOCTOU race the advisory
// lock closes (mini-spec §7 / T3 / T4). It drives the race through the REAL route
// handlers over HTTP against a REAL Postgres, so the SAME file, run against the
// parent commit (bb51c5eb, no lock), fails BY ASSERTION: without serialization the
// reductor enumerates an empty impact (the host is parked before its CR lands),
// deletes the model, and the host CR is then created referencing a deleted model —
// a dangling reference, and the reductor answers 204 instead of 409.
//
// Determinism WITHOUT a production test hook (adenda A4): a `MockGateway` subclass
// defers `createResource`/`listResource` for Hosts on a barrier the test controls,
// parking one writer WHILE it holds (child) / would hold (parent) the lock, then
// firing the other. Fixtures come from the REAL producers (T1): the allowlist row
// from `createAllowedModel`, the Host CR from the same `gateway.createResource` the
// impact enumeration later LISTs. Skipped without CONTROL_API_REAL_PG_ADMIN_URL.

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

const PROVIDER = 'claude'
const MODEL = 'meta-llama/Llama-3.1-8B' // a name with a slash — never a valid lock/key separator

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void } {
  let resolve!: (v: T | PromiseLike<T>) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('llm-model reductor ↔ host referencer serialization (R1-H3 fase 1)', () => {
  const database = `control_api_host_model_race_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  // Loaded dynamically AFTER the env points the module pool at the test DB.
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    config: typeof import('../src/config.js').config
    pool: import('../src/db.js').DbClient
    createAllowedModel: typeof import('../src/services/llmAllowedModels.js').createAllowedModel
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }
  let BarrierGatewayClass: new (ns?: string) => BarrierGatewayShape

  interface BarrierGatewayShape {
    blockHostCreate: boolean
    blockHostList: boolean
    hostCreateEntered: ReturnType<typeof deferred>
    releaseHostCreate: ReturnType<typeof deferred>
    hostListEntered: ReturnType<typeof deferred>
    releaseHostList: ReturnType<typeof deferred>
    listResource: (plural: string, ns?: string) => Promise<unknown[]>
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)

    // Point the process at the fresh DB BEFORE importing db/config/app so the
    // module pool (and everything the app wires) connects there.
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

    const dbMod = await import('../src/db.js')
    // The module core pool holds idle connections; when afterAll terminates
    // backends before DROP DATABASE, those idle clients surface a 57P01 error.
    // Absorb it so teardown is clean (the pool is being torn down anyway).
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await migratePool.end()

    const appMod = await import('../src/app.js')
    const configMod = await import('../src/config.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      config: configMod.config,
      pool: dbMod.pool,
      createAllowedModel: allowlistMod.createAllowedModel,
      MockGateway,
    }

    // A gateway that can park Host create / Host list on a barrier the test drives.
    class BarrierGateway extends MockGateway {
      blockHostCreate = false
      blockHostList = false
      hostCreateEntered = deferred()
      releaseHostCreate = deferred()
      hostListEntered = deferred()
      releaseHostList = deferred()

      override async createResource(
        plural: Parameters<InstanceType<typeof MockGateway>['createResource']>[0],
        body: Parameters<InstanceType<typeof MockGateway>['createResource']>[1],
        namespace?: string
      ): Promise<unknown> {
        if (plural === 'hosts' && this.blockHostCreate) {
          this.hostCreateEntered.resolve()
          await this.releaseHostCreate.promise
        }
        return super.createResource(plural, body, namespace)
      }

      override async listResource(
        plural: Parameters<InstanceType<typeof MockGateway>['listResource']>[0],
        namespace?: string
      ): Promise<unknown[]> {
        if (plural === 'hosts' && this.blockHostList) {
          this.hostListEntered.resolve()
          await this.releaseHostList.promise
        }
        return super.listResource(plural, namespace)
      }
    }
    BarrierGatewayClass = BarrierGateway as never
  }, 60_000)

  afterAll(async () => {
    if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
    else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
    // Drain the module pool's connections first so DROP DATABASE has no live users.
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
    // Clean slate per test: no rows, no hosts leaking between orderings.
    await mod.pool.query('DELETE FROM llm_allowed_models')
  })

  afterEach(async () => {
    await mod.pool.query('DELETE FROM llm_allowed_models')
  })

  async function seedEnabledModel(): Promise<string> {
    const row = await mod.createAllowedModel(
      { provider: PROVIDER, model: MODEL, enabled: true },
      'test-actor'
    )
    return row.id
  }

  const hostBody = (name: string) => ({
    metadata: { name },
    spec: { model: { provider: PROVIDER, name: MODEL } },
  })

  async function modelRow(id: string): Promise<{ enabled: boolean } | undefined> {
    const res = await mod.pool.query('SELECT enabled FROM llm_allowed_models WHERE id = $1', [id])
    return res.rows[0] as { enabled: boolean } | undefined
  }

  it('host commits first → reductor sees the CR under the lock and 409s (no dangling reference)', async () => {
    const id = await seedEnabledModel()
    const gateway = new BarrierGatewayClass()
    const app = mod.createApp(gateway)

    // 1. Park the host-create INSIDE createResource — it holds the model lock.
    gateway.blockHostCreate = true
    const hostDone = (async () =>
      request(app).post('/api/v1/admin/hosts').set('Cookie', COOKIE).send(hostBody('race-host')))()
    await gateway.hostCreateEntered.promise

    // 2. Fire the non-forced DELETE reductor; give it time to block on the lock
    //    (child) or to read+delete an empty impact (parent) before we release.
    const reductorDone = (async () =>
      request(app).delete(`/api/v1/admin/llm-models/${id}`).set('Cookie', COOKIE))()
    await new Promise(r => setTimeout(r, 400))

    // 3. Let the host CR land + commit, releasing the lock.
    gateway.releaseHostCreate.resolve()
    const [hostRes, reductorRes] = await Promise.all([hostDone, reductorDone])

    // Observable final state (T4): the host was created, the reductor was refused
    // with the impact naming the host, and the model row still exists ENABLED — no
    // Host CR points at a removed pair.
    expect(hostRes.status).toBe(201)
    expect(reductorRes.status).toBe(409)
    expect(reductorRes.body.error).toBe('model_in_use')
    expect(
      (reductorRes.body.impact.hostsAffected as Array<{ name: string }>).map(h => h.name)
    ).toContain('race-host')
    expect((await modelRow(id))?.enabled).toBe(true)
    const hosts = await gateway.listResource('hosts', mod.config.hostsNamespace)
    expect(hosts).toHaveLength(1)
  }, 30_000)

  it('reductor commits first → host revalidates under the lock and 422s (no dangling reference)', async () => {
    const id = await seedEnabledModel()
    const gateway = new BarrierGatewayClass()
    const app = mod.createApp(gateway)

    // 1. Park the reductor INSIDE its impact Host LIST — it holds the model lock.
    gateway.blockHostList = true
    const reductorDone = (async () =>
      request(app).delete(`/api/v1/admin/llm-models/${id}`).set('Cookie', COOKIE))()
    await gateway.hostListEntered.promise

    // 2. Fire the host-create; give it time to block on the lock (child) before we
    //    release the reductor's LIST.
    const hostDone = (async () =>
      request(app)
        .post('/api/v1/admin/hosts')
        .set('Cookie', COOKIE)
        .send(hostBody('race-host-2')))()
    await new Promise(r => setTimeout(r, 400))

    // 3. Let the reductor finish its (empty) impact, delete, and commit — releasing
    //    the lock so the host revalidates against the now-deleted model.
    gateway.releaseHostList.resolve()
    const [reductorRes, hostRes] = await Promise.all([reductorDone, hostDone])

    expect(reductorRes.status).toBe(204)
    expect(hostRes.status).toBe(422)
    expect(await modelRow(id)).toBeUndefined()
    const hosts = await gateway.listResource('hosts', mod.config.hostsNamespace)
    expect(hosts).toHaveLength(0)
  }, 30_000)
})
