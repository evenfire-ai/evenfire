/**
 * Purge of `context` (shared) OAuth grants when a Context stops enabling the
 * server or stops existing: the hooks of the admin Context routes (PUT keeps
 * only the persisted allowlist, DELETE and POST keep nothing) and the periodic
 * sweep, interleaved with consent callbacks, refreshes, disconnects and writers
 * outside control-api.
 *
 * Everything runs through the real app against a real Postgres: consent mint,
 * provider callback, broker, disconnect, the admin Context and McpServer routes
 * and the sweep itself (`runSharedGrantSweep`, called directly so a test can
 * place events between its clock read, its Context list and its deletes).
 * The provider token endpoint (`globalThis.fetch`) is the only network stub; it
 * can park its answer to place events inside the code exchange or a refresh.
 * Writers outside control-api (WRC, kubectl) are the gateway itself, without
 * the routes. Host CRs are seeded straight into the gateway, as in the sibling
 * `oauth.contextGrant.scenarios` suite: the admin Host routes validate model
 * references this suite does not provision.
 *
 * What a purge changes is observed where a user sees it: a removed-then-re-
 * enabled server is not served again without a new consent (no resurrection),
 * the broker answer, the connectors panel. Rows are the complement.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.contextGrant.purge.scenarios.realPostgres.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../src/oauth/mcpServerOAuthSpec.js'
import { type OAuthGrantKey, refreshOAuthGrantTokens } from '../src/oauth/store.js'
import { createAdminRouter } from '../src/routes/admin/index.js'
import { resolveConnectorsForAgents } from '../src/services/access/mcpInvocable.js'
import { getUserAgents } from '../src/services/directory/agentAccess.js'
import {
  type SharedGrantSweepDeps,
  runSharedGrantSweep,
  sharedGrantSweepLogger,
} from '../src/services/oauthSharedGrantSweepCron.js'
import { seedActiveMember, seedAgentHost, seedControlAdmin } from './fixtures/contextAllowlist.js'
import { mintHccControlToken } from './fixtures/hccControlToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

// `failPurges` makes the next N purge statements (the DELETEs keyed by an
// allowlist) throw before they reach Postgres, the way a dropped connection
// would: the hook's failure path, without touching the code under test.
const testDb = vi.hoisted(() => ({
  pool: undefined as import('pg').Pool | undefined,
  failPurges: 0,
}))

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  const current = () => {
    if (!testDb.pool) throw new Error('test pool not initialised')
    return testDb.pool
  }
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => {
        if (testDb.failPurges > 0 && /DELETE FROM oauth_grants[\s\S]*= ANY\(/.test(text)) {
          testDb.failPurges -= 1
          return Promise.reject(new Error('injected purge failure'))
        }
        return current().query(text, values)
      },
      connect: () => current().connect(),
    },
    withTransaction: (work: Parameters<typeof actual.withTransaction>[0]) =>
      actual.withTransaction(work, current()),
  }
})

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const NS = config.mcpServersNamespace
const CTX_NS = config.contextsNamespace
const HOSTS_NS = config.hostsNamespace
const SERVER = 'shared-drive'
const CLIENT = 'shared-drive-client'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

const SERVER_SPEC = {
  enabled: true,
  image: 'example/shared-drive:1',
  transport: { type: 'streamableHttp', url: 'https://shared.example.com/mcp' },
  auth: { type: 'oauth' },
  oauth: {
    id: CLIENT,
    provider: 'google',
    clientIdRef: { name: 'google-creds', key: 'client-id' },
    clientSecretRef: { name: 'google-creds', key: 'client-secret' },
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    grantScope: 'context',
  },
}

interface GrantRow {
  recipe_name: string
  context_id: string
  bootstrapped_by_user_id: string
  cr_uid: string | null
  updated_at: Date
}

async function settlesWithin(promise: Promise<unknown>, ms = 3000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  const settled = await Promise.race([promise.then(() => true as const), timeout])
  clearTimeout(timer)
  return settled
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => (resolve = r))
  return { promise, resolve }
}

describeRealPostgres('context-scope grant purge (real Postgres)', () => {
  const database = `control_api_ctx_purge_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let operator: string
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let adminApp: express.Express
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  // Provider token endpoint. `hold` parks each POST (code exchange or refresh)
  // until released, in arrival order.
  const idp = {
    calls: 0,
    hold: false,
    expiresIn: 3600,
    parked: [] as Array<() => void>,
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    testDb.pool = dbPool
    config.mcpOauthBrokerEnabled = true
    operator = await seedControlAdmin(db)
  })

  afterAll(async () => {
    try {
      config.mcpOauthBrokerEnabled = originalBrokerEnabled
      testDb.pool = undefined
      if (dbPool) await endPoolAndWaitForClients(dbPool)
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
    await dbPool.query('DELETE FROM oauth_grants')
    testDb.failPurges = 0
    gateway = new MockGateway(NS)
    app = createApp(gateway as never)
    adminApp = express()
    adminApp.use(express.json())
    adminApp.use((req, _res, next) => {
      ;(req as unknown as { adminAuth: { sub: string; role: string } }).adminAuth = {
        sub: operator,
        role: 'admin',
      }
      next()
    })
    adminApp.use('/api/v1', createAdminRouter(gateway as never))
    adminApp.use(clerumErrorHandler)

    idp.calls = 0
    idp.hold = false
    idp.expiresIn = 3600
    idp.parked = []
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input) !== TOKEN_ENDPOINT) throw new Error(`unexpected fetch ${String(input)}`)
      idp.calls += 1
      const n = idp.calls
      if (idp.hold) await new Promise<void>(resolve => idp.parked.push(resolve))
      return Response.json({
        access_token: `AT-${n}`,
        refresh_token: `RT-${n}`,
        expires_in: idp.expiresIn,
      })
    })

    await installServer()
    gateway.seedSecret('google-creds', NS, {
      data: {
        'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
        'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
      },
    })
    await adminCreateContext('c1', [SERVER])
    await adminCreateContext('c2', [SERVER])
    await seedAgentHost(gateway, 'h1', 'c1')
    await seedAgentHost(gateway, 'h2', 'c2')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    fetchSpy.mockRestore()
  })

  // ── producers ──────────────────────────────────────────────────────────────

  async function installServer(): Promise<string> {
    await gateway.createResource(
      'mcpservers',
      { metadata: { name: SERVER }, spec: structuredClone(SERVER_SPEC) },
      NS
    )
    const cr = (await gateway.getResource('mcpservers', SERVER, NS)) as {
      metadata: { uid: string }
    }
    return cr.metadata.uid
  }

  async function adminUninstall(): Promise<void> {
    const res = await request(adminApp).delete(`/api/v1/admin/mcpservers/${SERVER}`)
    if (res.status !== 200) throw new Error(`uninstall ${res.status} ${res.text}`)
  }

  function adminCreateContextRequest(name: string, servers: string[]) {
    return request(adminApp)
      .post('/api/v1/admin/contexts')
      .send({ metadata: { name }, spec: { contextId: name, mcpServers: servers } })
      .then(res => res)
  }

  async function adminCreateContext(name: string, servers: string[]): Promise<void> {
    const res = await adminCreateContextRequest(name, servers)
    if (res.status !== 201) throw new Error(`context create ${res.status} ${res.text}`)
  }

  async function contextCr(name: string) {
    return (await gateway.getResource('contexts', name, CTX_NS)) as {
      metadata: { resourceVersion?: string }
      spec: Record<string, unknown>
    }
  }

  /** The admin PUT the control-ui sends: the current spec with a new allowlist and its RV. */
  async function adminSetAllowlistRequest(name: string, servers: string[]) {
    const current = await contextCr(name)
    return request(adminApp)
      .put(`/api/v1/admin/contexts/${name}`)
      .send({
        metadata: { resourceVersion: current.metadata.resourceVersion },
        spec: { ...current.spec, mcpServers: servers },
      })
      .then(res => res)
  }

  async function adminSetAllowlist(name: string, servers: string[]): Promise<void> {
    const res = await adminSetAllowlistRequest(name, servers)
    if (res.status !== 200) throw new Error(`context update ${res.status} ${res.text}`)
  }

  const adminDeleteContext = (name: string) =>
    request(adminApp)
      .delete(`/api/v1/admin/contexts/${name}`)
      .then(res => res)

  async function adminPut(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await request(adminApp).put(`/api/v1${path}`).send(body)
    if (res.status !== 200) throw new Error(`PUT ${path} ${res.status} ${res.text}`)
  }

  /** A writer outside control-api (WRC replace, kubectl edit): no route, no hook. */
  async function externalSetAllowlist(name: string, servers: string[]): Promise<void> {
    const current = await contextCr(name)
    await gateway.updateResource(
      'contexts',
      name,
      {
        metadata: { resourceVersion: current.metadata.resourceVersion },
        spec: { ...current.spec, mcpServers: servers },
      },
      CTX_NS
    )
  }

  const externalDeleteContext = (name: string) => gateway.deleteResource('contexts', name, CTX_NS)

  async function externalCreateContext(
    name: string,
    servers: string[],
    contextId: string = name
  ): Promise<void> {
    await gateway.createResource(
      'contexts',
      { metadata: { name }, spec: { contextId, mcpServers: servers } },
      CTX_NS
    )
  }

  /**
   * Park the next admin write of a Context right after the apiserver accepted
   * it: the route has persisted the allowlist and has not run anything after.
   */
  function holdNextContextWriteAfterPersist(): { reached: Promise<void>; release: () => void } {
    const reached = deferred()
    const gate = deferred()
    const real = gateway.updateResource.bind(gateway)
    let armed = true
    vi.spyOn(gateway, 'updateResource').mockImplementation(async (...args) => {
      const out = await real(...args)
      if (armed && args[0] === 'contexts') {
        armed = false
        reached.resolve()
        await gate.promise
      }
      return out
    })
    return { reached: reached.promise, release: gate.resolve }
  }

  // ── flows ──────────────────────────────────────────────────────────────────

  async function mintState(userId: string, contextId: string): Promise<string> {
    const res = await request(app)
      .post('/api/v1/internal/mcp-oauth/authorize-url')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: SERVER, userId, contextId })
    if (res.status !== 200) throw new Error(`mint ${res.status} ${res.text}`)
    return new URL(res.body.authorizeUrl as string).searchParams.get('state') ?? ''
  }

  /** Starts the callback request immediately (supertest is lazy until awaited). */
  const callback = (state: string, code = `CODE-${randomUUID()}`) =>
    request(app)
      .get(`/api/v1/oauth-callback/${CLIENT}`)
      .query({ code, state })
      .then(res => res)

  async function connect(userId: string, contextId: string): Promise<void> {
    const res = await callback(await mintState(userId, contextId))
    if (res.status !== 200) throw new Error(`callback ${res.status} ${res.text}`)
  }

  /** Consent that stops inside the code exchange, after the access re-check. */
  async function parkedConsent(userId: string, contextId: string) {
    const state = await mintState(userId, contextId)
    idp.hold = true
    const pending = callback(state)
    await untilParked(1)
    // Wrapped: an async function returning the bare promise would await it.
    return { pending }
  }

  const disconnect = (userId: string, contextId: string) =>
    request(app)
      .delete('/api/v1/internal/mcp-oauth/grant')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: SERVER, userId, contextId })
      .then(res => res)

  async function broker(host: string) {
    const token = await mintHccControlToken(app, gateway, host)
    return request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${token}`)
      .send({ mcpServerName: SERVER })
      .then(res => res)
  }

  async function expectServed(host: string): Promise<string> {
    const res = await broker(host)
    expect(res.status, res.text).toBe(200)
    return res.body.token as string
  }

  async function expectNotServed(host: string): Promise<void> {
    const res = await broker(host)
    expect(res.status, res.text).toBe(404)
  }

  /** Re-enable the server in `contextName` and check its Hosts get nothing without a new consent. */
  async function expectNoResurrection(contextName: string, host: string): Promise<void> {
    await adminSetAllowlist(contextName, [SERVER])
    await expectNotServed(host)
  }

  async function rows(): Promise<GrantRow[]> {
    const res = await dbPool.query(
      `SELECT recipe_name, context_id, bootstrapped_by_user_id::text AS bootstrapped_by_user_id,
              cr_uid, updated_at
         FROM oauth_grants
        WHERE grant_kind = 'shared'
     ORDER BY context_id`
    )
    return res.rows as GrantRow[]
  }

  const rowContexts = async () => (await rows()).map(r => r.context_id)

  async function connectorStatus(userId: string, agent: string): Promise<string | undefined> {
    const { agentNames } = await getUserAgents(userId)
    const agents = await resolveConnectorsForAgents(
      gateway as never,
      {
        mcpServersNamespace: NS,
        contextsNamespace: CTX_NS,
        hostsNamespace: HOSTS_NS,
        agentNames,
        userId,
      } as never,
      db
    )
    return agents.find(a => a.name === agent)?.connectors.find(c => c.name === SERVER)?.status
  }

  async function untilParked(n: number): Promise<void> {
    for (let i = 0; i < 400 && idp.parked.length < n; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    if (idp.parked.length < n) throw new Error(`only ${idp.parked.length} provider POSTs parked`)
  }

  function sweepDeps(
    listGateway: SharedGrantSweepDeps['gateway'] = gateway as never
  ): SharedGrantSweepDeps {
    return { gateway: listGateway, db, contextsNamespace: CTX_NS, mcpServersNamespace: NS }
  }

  const sweep = () => runSharedGrantSweep(sweepDeps())

  /**
   * A sweep parked right after it listed the Contexts: its clock and its
   * snapshot are taken, its deletes have not run.
   */
  function sweepParkedAfterList(): {
    listed: Promise<void>
    release: () => void
    done: Promise<unknown>
  } {
    const listed = deferred()
    const gate = deferred()
    const listGateway = {
      listResource: async (plural: string, namespace?: string) => {
        const items = await gateway.listResource(plural as never, namespace)
        listed.resolve()
        await gate.promise
        return items
      },
    }
    const done = runSharedGrantSweep(sweepDeps(listGateway as never))
    return { listed: listed.promise, release: gate.resolve, done }
  }

  /** True once a backend of this database is waiting on a row lock inside a purge DELETE. */
  async function purgeBlockedOnRowLock(): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      const res = await adminPool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'
            AND query LIKE '%DELETE FROM oauth_grants%'`,
        [database]
      )
      if ((res.rowCount ?? 0) > 0) return true
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return false
  }

  async function sharedKey(contextId: string): Promise<OAuthGrantKey> {
    const cr = await gateway.getResource('mcpservers', SERVER, NS)
    const resolved = resolveServerOAuth(cr as never)
    const key = resolved
      ? buildMcpServerGrantKey(resolved, {
          mcpServerName: SERVER,
          mcpServersNamespace: NS,
          contextId,
        })
      : null
    if (!key) throw new Error('no shared key')
    return key
  }

  // ── PUT hook × consent in flight ───────────────────────────────────────────

  describe('the Context stops enabling the server while a consent is in the exchange', () => {
    it('the insert lands before the hook: the PUT purges it and re-enabling serves nothing', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      const { pending } = await parkedConsent(u1, 'c1')

      const write = holdNextContextWriteAfterPersist()
      const put = adminSetAllowlistRequest('c1', [])
      await write.reached
      idp.parked.shift()?.()
      expect((await pending).status).toBe(200)
      expect(await rowContexts()).toEqual(['c1'])

      write.release()
      expect((await put).status).toBe(200)

      expect(await rowContexts()).toEqual([])
      await expectNoResurrection('c1', 'h1')
    })

    it('the insert lands after the hook: an orphan the broker refuses, gone after the next sweep', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      const { pending } = await parkedConsent(u1, 'c1')
      await adminSetAllowlist('c1', [])
      idp.parked.shift()?.()
      expect((await pending).status).toBe(200)
      expect(await rowContexts()).toEqual(['c1'])
      await expectNotServed('h1')
      const warn = vi.spyOn(sharedGrantSweepLogger, 'warn')

      await sweep()

      expect(await rowContexts()).toEqual([])
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServerName: SERVER,
          contextName: 'c1',
          bootstrappedBy: u1,
          source: 'sweep',
        }),
        expect.any(String)
      )
      await expectNoResurrection('c1', 'h1')
    })
  })

  it('characterization: re-enabled before any sweep, the late insert is served (accepted residual)', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    const { pending } = await parkedConsent(u1, 'c1')
    await adminSetAllowlist('c1', [])
    idp.parked.shift()?.()
    expect((await pending).status).toBe(200)

    await adminSetAllowlist('c1', [SERVER])

    expect(await expectServed('h1')).toBe('AT-1')
  })

  // ── uninstall / reinstall ──────────────────────────────────────────────────

  it('uninstall inside the exchange: the late row keeps the old uid, is not served, and the sweep removes it', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    const oldUid = (
      (await gateway.getResource('mcpservers', SERVER, NS)) as { metadata: { uid: string } }
    ).metadata.uid
    const { pending } = await parkedConsent(u1, 'c1')

    await adminUninstall()
    idp.parked.shift()?.()
    expect((await pending).status).toBe(200)
    expect((await rows()).map(r => [r.context_id, r.cr_uid])).toEqual([['c1', oldUid]])
    expect((await broker('h1')).status).not.toBe(200)

    await sweep()

    expect(await rows()).toEqual([])
  })

  describe('uninstall and reinstall between the mint and the callback', () => {
    it('not re-enabled: the callback is refused before the exchange', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      const state = await mintState(u1, 'c1')
      await adminUninstall()
      await installServer()

      const res = await callback(state)

      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'context_membership_denied' })
      expect(idp.calls).toBe(0)
      expect(await rows()).toEqual([])
    })

    it('re-enabled by an admin: the consent completes and is sealed to the new installation', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      const state = await mintState(u1, 'c1')
      await adminUninstall()
      const newUid = await installServer()
      await adminSetAllowlist('c1', [SERVER])

      const res = await callback(state)

      expect(res.status).toBe(200)
      expect((await rows()).map(r => [r.context_id, r.cr_uid])).toEqual([['c1', newUid]])
      expect(await expectServed('h1')).toBe('AT-1')
    })
  })

  // ── concurrent writers around the PUT hook ─────────────────────────────────

  it('characterization: a later PUT re-enables and a member consents before the first PUT hook; that consent is lost', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'], agents: ['h1'] })
    const write = holdNextContextWriteAfterPersist()
    const removing = adminSetAllowlistRequest('c1', [])
    await write.reached

    await adminSetAllowlist('c1', [SERVER])
    await connect(u1, 'c1')
    expect(await connectorStatus(u1, 'h1')).toBe('authorized')

    write.release()
    expect((await removing).status).toBe(200)

    expect((await contextCr('c1')).spec.mcpServers).toEqual([SERVER])
    expect(await connectorStatus(u1, 'h1')).toBe('requires_setup')
    expect(await rows()).toEqual([])
  })

  it('a refresh holds the row lock: the PUT waits for it, then purges the refreshed row', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    // Expires inside the broker's refresh buffer: the next broker read refreshes.
    idp.expiresIn = 30
    await connect(u1, 'c1')

    idp.hold = true
    const refreshing = broker('h1')
    await untilParked(1)
    let putSettled = false
    const put = adminSetAllowlistRequest('c1', []).then(res => {
      putSettled = true
      return res
    })

    expect(await purgeBlockedOnRowLock()).toBe(true)
    expect(putSettled).toBe(false)
    idp.parked.shift()?.()
    expect((await refreshing).status).toBe(200)
    expect((await put).status).toBe(200)

    expect(await rows()).toEqual([])
    await expectNoResurrection('c1', 'h1')
  })

  // ── DELETE hook and Contexts gone ──────────────────────────────────────────

  it('the Context was deleted outside control-api: the admin DELETE fails, the sweep removes its rows', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    await connect(u1, 'c1')
    await externalDeleteContext('c1')
    // The apiserver answers a delete of a missing object with 404.
    const realDelete = gateway.deleteResource.bind(gateway)
    vi.spyOn(gateway, 'deleteResource').mockImplementation(async (plural, name, ns, pre) => {
      const present = (await gateway.listResource(plural, ns)) as Array<{
        metadata: { name: string }
      }>
      if (plural === 'contexts' && !present.some(item => item.metadata.name === name)) {
        throw Object.assign(new Error(`contexts "${name}" not found`), { code: 404 })
      }
      return realDelete(plural, name, ns, pre)
    })

    const res = await adminDeleteContext('c1')

    expect(res.status).toBe(404)
    expect(await rowContexts()).toEqual(['c1'])
    await sweep()
    expect(await rows()).toEqual([])
    await externalCreateContext('c1', [SERVER])
    await expectNotServed('h1')
  })

  it('DELETE · deleting a Context through control-api removes every shared row of it and only of it', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1', 'c2'] })
    await connect(u1, 'c1')
    await connect(u1, 'c2')

    const res = await adminDeleteContext('c1')

    expect(res.status).toBe(200)
    expect(await rowContexts()).toEqual(['c2'])
    await externalCreateContext('c1', [SERVER])
    await expectNotServed('h1')
    expect(await expectServed('h2')).toBe('AT-2')
  })

  // ── sweep × concurrent writes ──────────────────────────────────────────────

  it('a consent written after the sweep took its clock survives that tick and is served', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    await adminSetAllowlist('c1', [])
    // The application clock is pushed far ahead while the sweep takes its own:
    // a sweep that read it instead of the database's would see every row as old.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'))
    const tick = sweepParkedAfterList()
    expect(await settlesWithin(tick.listed)).toBe(true)
    vi.useRealTimers()

    await adminSetAllowlist('c1', [SERVER])
    await connect(u1, 'c1')
    tick.release()
    await tick.done

    expect(await rowContexts()).toEqual(['c1'])
    expect(await expectServed('h1')).toBe('AT-1')
  })

  it('characterization: re-enabled and re-consented (a no-op) after the sweep listed; the sweep removes the row', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'], agents: ['h1'] })
    await connect(u1, 'c1')
    await externalSetAllowlist('c1', [])
    const tick = sweepParkedAfterList()
    expect(await settlesWithin(tick.listed)).toBe(true)

    await adminSetAllowlist('c1', [SERVER])
    await connect(u1, 'c1')
    expect(await connectorStatus(u1, 'h1')).toBe('authorized')
    tick.release()
    await tick.done

    expect(await rows()).toEqual([])
    expect(await connectorStatus(u1, 'h1')).toBe('requires_setup')
  })

  it('an orphan refreshed after the sweep took its clock survives one tick, unserved, and the next tick removes it', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    await connect(u1, 'c1')
    await externalSetAllowlist('c1', [])
    const tick = sweepParkedAfterList()
    expect(await settlesWithin(tick.listed)).toBe(true)

    const refreshed = await refreshOAuthGrantTokens(
      db,
      deriveOAuthEncryptionKey(config.oauthEncryptionKey),
      { ...(await sharedKey('c1')), provider: 'google', accessToken: 'AT-refreshed' }
    )
    expect(refreshed.updated).toBe(true)
    tick.release()
    await tick.done

    expect(await rowContexts()).toEqual(['c1'])
    await expectNotServed('h1')
    await sweep()
    expect(await rows()).toEqual([])
  })

  describe('the sweep never deletes on a failed or empty Context list', () => {
    it.each([
      [
        'the list throws',
        async () => {
          throw Object.assign(new Error('apiserver unavailable'), { code: 503 })
        },
      ],
      ['the list is empty', async () => []],
    ])('%s: the orphan survives; a healthy tick then removes it', async (_label, list) => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      await connect(u1, 'c1')
      await externalSetAllowlist('c1', [])

      await runSharedGrantSweep(sweepDeps({ listResource: list } as never))

      expect(await rowContexts()).toEqual(['c1'])
      await sweep()
      expect(await rows()).toEqual([])
    })
  })

  it('sweep · a Context being deleted counts as gone: its rows are removed even though it still lists', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1', 'c2'] })
    await connect(u1, 'c1')
    await connect(u1, 'c2')
    gateway.markDeleting('contexts', 'c1', CTX_NS)

    await sweep()

    expect(await rowContexts()).toEqual(['c2'])
    expect(await expectServed('h2')).toBe('AT-2')
  })

  // ── residuals of writers outside control-api, and the member's revoke ──────

  it('characterization: deleted and recreated outside control-api before a sweep, the old row is served; a member can revoke it', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    await connect(u1, 'c1')
    await externalDeleteContext('c1')
    await externalCreateContext('c1', [SERVER])

    expect(await expectServed('h1')).toBe('AT-1')

    expect((await disconnect(u1, 'c1')).status).toBe(204)
    await expectNotServed('h1')
  })

  it('the PUT hook fails: the PUT still answers 200 and a member can revoke the orphan', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    await connect(u1, 'c1')
    testDb.failPurges = 1

    await adminSetAllowlist('c1', [])
    expect(await rowContexts()).toEqual(['c1'])

    expect((await disconnect(u1, 'c1')).status).toBe(204)
    expect(await rows()).toEqual([])
    await expectNoResurrection('c1', 'h1')
  })

  describe('a Context deleted while its hook fails, then recreated with the server', () => {
    it('recreated through control-api: the create purges the previous incarnation and nothing is served', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      await connect(u1, 'c1')
      testDb.failPurges = 1

      expect((await adminDeleteContext('c1')).status).toBe(200)
      expect(await rowContexts()).toEqual(['c1'])
      expect((await adminCreateContextRequest('c1', [SERVER])).status).toBe(201)

      expect(await rows()).toEqual([])
      await expectNotServed('h1')
    })

    it('characterization: deleted and recreated outside control-api, the previous row is served (accepted residual)', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      await connect(u1, 'c1')
      await externalDeleteContext('c1')
      await externalCreateContext('c1', [SERVER])

      expect(await expectServed('h1')).toBe('AT-1')
    })
  })

  it('a Context written outside control-api with an alias: an admin PUT that resends the alias and removes the server is accepted and purges', async () => {
    // The alias is another Context's name: the collision only an external writer can create.
    await externalCreateContext('cb', [SERVER], 'c1')
    await seedAgentHost(gateway, 'hb', 'cb')
    const u1 = await seedActiveMember(db, {})
    await adminPut(`/admin/users/${u1}/contexts`, { contextIds: ['cb'] })
    await connect(u1, 'cb')
    expect(await expectServed('hb')).toBe('AT-1')

    const res = await adminSetAllowlistRequest('cb', [])

    expect(res.status, res.text).toBe(200)
    expect(res.body.spec.contextId).toBe('c1')
    expect(await rowContexts()).toEqual([])
    await expectNoResurrection('cb', 'hb')
  })

  it('characterization: the removing PUT hook fails and the server is re-enabled before any sweep; the old row is served (accepted residual)', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    await connect(u1, 'c1')
    testDb.failPurges = 1

    await adminSetAllowlist('c1', [])
    await adminSetAllowlist('c1', [SERVER])

    expect(await expectServed('h1')).toBe('AT-1')
  })

  // The sweep judges a row by the allowlists it lists, never by the history
  // that produced it: once the server is enabled again, a revived row is
  // indistinguishable from a live consent and no later tick removes it.
  describe('characterization: a revived row survives a later successful sweep (accepted residual)', () => {
    it('re-enabled before any sweep after a late consent', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      const { pending } = await parkedConsent(u1, 'c1')
      await adminSetAllowlist('c1', [])
      idp.parked.shift()?.()
      expect((await pending).status).toBe(200)
      await adminSetAllowlist('c1', [SERVER])

      await sweep()

      expect(await rowContexts()).toEqual(['c1'])
      expect(await expectServed('h1')).toBe('AT-1')
    })

    it('deleted and recreated outside control-api before any sweep', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      await connect(u1, 'c1')
      await externalDeleteContext('c1')
      await externalCreateContext('c1', [SERVER])

      await sweep()

      expect(await rowContexts()).toEqual(['c1'])
      expect(await expectServed('h1')).toBe('AT-1')
    })

    it('the removing PUT hook fails and the server is re-enabled before any sweep', async () => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      await connect(u1, 'c1')
      testDb.failPurges = 1
      await adminSetAllowlist('c1', [])
      await adminSetAllowlist('c1', [SERVER])

      await sweep()

      expect(await rowContexts()).toEqual(['c1'])
      expect(await expectServed('h1')).toBe('AT-1')
    })
  })
})
