/**
 * Lifecycle of a `context` (shared) OAuth grant once the McpServer no longer
 * names an owning Context: the Context comes from the consent request, is
 * validated against the user's session (membership or an assigned agent's
 * Host, plus the Context's allowlist), travels in the signed state, is
 * re-validated by the callback before the code exchange, and keys the shared
 * row by the Context's name. The broker serves it to Hosts of that Context
 * only, and both connector rails read presence per (Context, server).
 *
 * Everything runs through the real app against a real Postgres: consent mint,
 * provider callback, disconnect, broker and the rails' resolvers, with
 * Contexts and memberships written by the admin routes and production writers.
 * The provider token endpoint (`globalThis.fetch`, the baked lane's transport)
 * is the only stub; it can hold its answer to place events in the gap between
 * the access re-check and the grant insert.
 *
 * Host CRs are written straight to the gateway (`seedAgentHost`, moves with
 * `updateResource`): the admin Host routes validate LLM model references this
 * suite does not provision, and nothing here depends on that validation.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.contextGrant.scenarios.realPostgres.integration.test.ts
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
import { signOAuthState } from '../src/oauth/state.js'
import { createAdminRouter } from '../src/routes/admin/index.js'
import {
  resolveConnectorsForAgents,
  resolveInvocableMcpServersForContexts,
} from '../src/services/access/mcpInvocable.js'
import { getUserAgents } from '../src/services/directory/agentAccess.js'
import { getUserContexts, setUserContexts } from '../src/services/directory/contextAccess.js'
import { seedActiveMember, seedAgentHost, seedControlAdmin } from './fixtures/contextAllowlist.js'
import { mintHccControlToken } from './fixtures/hccControlToken.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

const testDb = vi.hoisted(() => ({ pool: undefined as import('pg').Pool | undefined }))

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  const current = () => {
    if (!testDb.pool) throw new Error('test pool not initialised')
    return testDb.pool
  }
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => current().query(text, values),
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
const HOSTS_NS = config.hostsNamespace
const SERVER = 'shared-drive'
const CLIENT = 'shared-drive-client'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

interface GrantRow {
  recipe_name: string
  context_id: string
  bootstrapped_by_user_id: string
  access_token_encrypted: string
  updated_at: Date
}

describeRealPostgres('context-scope grant lifecycle (real Postgres)', () => {
  const database = `control_api_ctx_grant_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let operator: string
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let adminApp: express.Express
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  // Provider token endpoint. `hold` parks each exchange until released, in
  // arrival order, so a test can act inside the exchange gap.
  const idp = {
    calls: 0,
    hold: false,
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
    idp.parked = []
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input) !== TOKEN_ENDPOINT) throw new Error(`unexpected fetch ${String(input)}`)
      idp.calls += 1
      const n = idp.calls
      if (idp.hold) await new Promise<void>(resolve => idp.parked.push(resolve))
      return Response.json({ access_token: `AT-${n}`, expires_in: 3600 })
    })

    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name: SERVER },
        spec: {
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
        },
      },
      NS
    )
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
    fetchSpy.mockRestore()
  })

  // ── producers ──────────────────────────────────────────────────────────────

  async function adminCreateContext(name: string, servers: string[]): Promise<void> {
    const res = await request(adminApp)
      .post('/api/v1/admin/contexts')
      .send({ metadata: { name }, spec: { contextId: name, mcpServers: servers } })
    if (res.status !== 201) throw new Error(`context create ${res.status} ${res.text}`)
  }

  async function adminSetAllowlist(name: string, servers: string[]): Promise<void> {
    const current = (await gateway.getResource('contexts', name, config.contextsNamespace)) as {
      metadata: { resourceVersion?: string }
      spec: Record<string, unknown>
    }
    const res = await request(adminApp)
      .put(`/api/v1/admin/contexts/${name}`)
      .send({
        metadata: { resourceVersion: current.metadata.resourceVersion },
        spec: { ...current.spec, mcpServers: servers },
      })
    if (res.status !== 200) throw new Error(`context update ${res.status} ${res.text}`)
  }

  async function adminPut(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await request(adminApp).put(`/api/v1${path}`).send(body)
    if (res.status !== 200) throw new Error(`PUT ${path} ${res.status} ${res.text}`)
  }

  async function moveHost(host: string, contextRef: string): Promise<void> {
    const cr = (await gateway.getResource('hosts', host, HOSTS_NS)) as {
      metadata: { resourceVersion?: string }
      spec: Record<string, unknown>
    }
    await gateway.updateResource(
      'hosts',
      host,
      {
        metadata: { resourceVersion: cr.metadata.resourceVersion },
        spec: { ...cr.spec, contextRef },
      },
      HOSTS_NS
    )
  }

  async function disableHost(host: string): Promise<void> {
    const cr = (await gateway.getResource('hosts', host, HOSTS_NS)) as {
      metadata: { resourceVersion?: string }
      spec: Record<string, unknown>
    }
    await gateway.updateResource(
      'hosts',
      host,
      {
        metadata: { resourceVersion: cr.metadata.resourceVersion },
        spec: { ...cr.spec, enabled: false },
      },
      HOSTS_NS
    )
  }

  // ── flows ──────────────────────────────────────────────────────────────────

  const mint = (userId: string, contextId?: string) =>
    request(app)
      .post('/api/v1/internal/mcp-oauth/authorize-url')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: SERVER, userId, ...(contextId !== undefined ? { contextId } : {}) })

  async function mintState(userId: string, contextId: string): Promise<string> {
    const res = await mint(userId, contextId)
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

  async function rows(): Promise<GrantRow[]> {
    const res = await dbPool.query(
      `SELECT recipe_name, context_id, bootstrapped_by_user_id::text AS bootstrapped_by_user_id,
              access_token_encrypted, updated_at
         FROM oauth_grants
        WHERE grant_kind = 'shared'
     ORDER BY context_id`
    )
    return res.rows as GrantRow[]
  }

  async function connectorStatus(userId: string, agent: string): Promise<string | undefined> {
    const { agentNames } = await getUserAgents(userId)
    const agents = await resolveConnectorsForAgents(
      gateway as never,
      {
        mcpServersNamespace: NS,
        contextsNamespace: config.contextsNamespace,
        hostsNamespace: HOSTS_NS,
        agentNames,
        userId,
      } as never,
      db
    )
    return agents.find(a => a.name === agent)?.connectors.find(c => c.name === SERVER)?.status
  }

  async function rail1(userId: string): Promise<string[]> {
    const { contextIds } = await getUserContexts(userId)
    const servers = await (
      resolveInvocableMcpServersForContexts as (
        ...args: unknown[]
      ) => Promise<Array<{ name: string }>>
    )(gateway, NS, contextIds, userId, db, config.contextsNamespace)
    return servers.map(s => s.name)
  }

  async function untilParked(n: number): Promise<void> {
    for (let i = 0; i < 400 && idp.parked.length < n; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    if (idp.parked.length < n) throw new Error(`only ${idp.parked.length} exchanges parked`)
  }

  // ── scenarios ──────────────────────────────────────────────────────────────

  it('a member consents for one Context; only Hosts of that Context get the token', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    await connect(u1, 'c1')

    const r = await rows()
    expect(r.map(x => [x.recipe_name, x.context_id, x.bootstrapped_by_user_id])).toEqual([
      [SERVER, 'c1', u1],
    ])
    expect(await expectServed('h1')).toBe('AT-1')
    await expectNotServed('h2')
  })

  it('disconnecting one Context leaves the grant of the same server in another Context untouched', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1', 'c2'] })
    await connect(u1, 'c1')
    await connect(u1, 'c2')
    const before = (await rows()).find(r => r.context_id === 'c2')

    const res = await disconnect(u1, 'c1')
    expect(res.status).toBe(204)

    const after = await rows()
    expect(after.map(r => r.context_id)).toEqual(['c2'])
    expect(after[0].access_token_encrypted).toBe(before?.access_token_encrypted)
    expect(after[0].updated_at.getTime()).toBe(before?.updated_at.getTime())
    await expectNotServed('h1')
    expect(await expectServed('h2')).toBe('AT-2')
  })

  it('connectors panel: a grant in one Context marks only the agents of that Context authorized', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'], agents: ['h1', 'h2'] })
    expect(await connectorStatus(u1, 'h1')).toBe('requires_setup')
    expect(await connectorStatus(u1, 'h2')).toBe('requires_setup')

    await connect(u1, 'c1')

    expect(await connectorStatus(u1, 'h1')).toBe('authorized')
    expect(await connectorStatus(u1, 'h2')).toBe('requires_setup')
  })

  it('invocable list: the server appears only when one of the user Contexts both enables it and holds its grant', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1', 'c2'] })
    // A grant in c2, then c2 stops enabling the server outside the admin API:
    // the orphan row must not make the server invocable through c1.
    await connect(u1, 'c2')
    const c2 = (await gateway.getResource('contexts', 'c2', config.contextsNamespace)) as {
      metadata: { resourceVersion?: string }
      spec: Record<string, unknown>
    }
    await gateway.updateResource(
      'contexts',
      'c2',
      {
        metadata: { resourceVersion: c2.metadata.resourceVersion },
        spec: { ...c2.spec, mcpServers: [] },
      },
      config.contextsNamespace
    )
    expect(await rail1(u1)).not.toContain(SERVER)

    await connect(u1, 'c1')
    expect(await rail1(u1)).toContain(SERVER)
  })

  it('consent completes and keeps serving after the consenting user leaves the Context mid-exchange', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    const state = await mintState(u1, 'c1')
    idp.hold = true
    const pending = callback(state)
    await untilParked(1)

    await setUserContexts(u1, [], operator)
    idp.parked.shift()?.()

    expect((await pending).status).toBe(200)
    expect(await expectServed('h1')).toBe('AT-1')
  })

  it('a state signed without a Context is refused before the exchange and changes no grant', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1', 'c2'] })
    await connect(u1, 'c2')
    const snapshot = await rows()
    const callsBefore = idp.calls
    const legacyState = signOAuthState(config.oauthStateHmacSecret, {
      subjectKind: 'mcp',
      mcpServerName: SERVER,
      userId: u1,
      oauthClientId: CLIENT,
      grantKind: 'user',
      background: false,
    })

    const res = await callback(legacyState)

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'oauth_state_outdated' })
    expect(idp.calls).toBe(callsBefore)
    expect(await rows()).toEqual(snapshot)
  })

  it('the Context stops enabling the server between mint and callback: 403, no exchange, no grant', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    const state = await mintState(u1, 'c1')
    await adminSetAllowlist('c1', [])

    const res = await callback(state)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'context_membership_denied' })
    expect(idp.calls).toBe(0)
    expect(await rows()).toEqual([])
  })

  it('the user loses the Context between mint and callback: 403, no exchange, no grant', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    const state = await mintState(u1, 'c1')
    await adminPut(`/admin/users/${u1}/contexts`, { contextIds: [] })

    const res = await callback(state)

    expect(res.status).toBe(403)
    expect(idp.calls).toBe(0)
    expect(await rows()).toEqual([])
  })

  describe('a user who reaches the Context only through an agent, and the agent moves', () => {
    it('assigned from the Host (agent users): 403 once the Host leaves the Context', async () => {
      const u2 = await seedActiveMember(db, {})
      await adminPut('/admin/agents/h1/users', { userIds: [u2] })
      const state = await mintState(u2, 'c1')
      await moveHost('h1', 'c2')

      const res = await callback(state)

      expect(res.status).toBe(403)
      expect(idp.calls).toBe(0)
      expect(await rows()).toEqual([])
    })

    it('assigned from the Host (agent users): 403 once the Host is disabled', async () => {
      const u2 = await seedActiveMember(db, {})
      await adminPut('/admin/agents/h1/users', { userIds: [u2] })
      const state = await mintState(u2, 'c1')
      await disableHost('h1')

      const res = await callback(state)

      expect(res.status).toBe(403)
      expect(idp.calls).toBe(0)
    })

    // The user-agent assignment of the profile admin also adds the agent's
    // Context to user_contexts (agents first, then contexts re-read and merged).
    // That membership outlives the Host move, so the consent still completes.
    it('assigned from the user profile (agents + derived Context): still 200 after the Host moves', async () => {
      const u2 = await seedActiveMember(db, {})
      await adminPut(`/admin/users/${u2}/agents`, {
        agentNames: ['h1'],
        expectedCurrentAgentNames: [],
      })
      await adminPut(`/admin/users/${u2}/contexts`, { contextIds: ['c1'] })
      const state = await mintState(u2, 'c1')
      await moveHost('h1', 'c2')

      const res = await callback(state)

      expect(res.status).toBe(200)
      expect((await rows()).map(r => r.context_id)).toEqual(['c1'])
    })
  })

  it.each([
    ['first', 0],
    ['second', 1],
  ])(
    'two members consent concurrently: one row, bootstrapped by the exchange released %s',
    async (_label, firstReleased) => {
      const u1 = await seedActiveMember(db, { contexts: ['c1'] })
      const u2 = await seedActiveMember(db, { agents: ['h1'] })
      const states = [await mintState(u1, 'c1'), await mintState(u2, 'c1')]
      const users = [u1, u2]
      idp.hold = true
      const first = callback(states[0])
      await untilParked(1)
      const second = callback(states[1])
      await untilParked(2)

      const order = firstReleased === 0 ? [0, 1] : [1, 0]
      const pending = [first, second]
      idp.parked[order[0]]()
      expect((await pending[order[0]]).status).toBe(200)
      idp.parked[order[1]]()
      expect((await pending[order[1]]).status).toBe(200)

      const r = await rows()
      expect(r).toHaveLength(1)
      expect(r[0].bootstrapped_by_user_id).toBe(users[order[0]])
    }
  )

  it('a disconnect that lands during another member exchange is followed by that consent', async () => {
    const u1 = await seedActiveMember(db, { contexts: ['c1'] })
    const u2 = await seedActiveMember(db, { contexts: ['c1'] })
    await connect(u2, 'c1')
    const state = await mintState(u1, 'c1')
    idp.hold = true
    const pending = callback(state)
    await untilParked(1)

    expect((await disconnect(u2, 'c1')).status).toBe(204)
    expect(await rows()).toEqual([])
    idp.parked.shift()?.()

    expect((await pending).status).toBe(200)
    const r = await rows()
    expect(r.map(x => [x.context_id, x.bootstrapped_by_user_id])).toEqual([['c1', u1]])
    expect(await expectServed('h1')).toBe('AT-2')
  })

  it('a Context whose spec.contextId differs from its name is keyed, served and shown by its name', async () => {
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'cx' }, spec: { contextId: 'x-c2', mcpServers: [SERVER] } },
      config.contextsNamespace
    )
    await seedAgentHost(gateway, 'hx', 'cx')
    const u1 = await seedActiveMember(db, { agents: ['hx'] })
    // The profile admin stores the Context's name for the membership.
    await adminPut(`/admin/users/${u1}/contexts`, { contextIds: ['cx'] })

    await connect(u1, 'cx')

    expect((await rows()).map(r => r.context_id)).toEqual(['cx'])
    expect(await expectServed('hx')).toBe('AT-1')
    expect(await connectorStatus(u1, 'hx')).toBe('authorized')
  })
})
