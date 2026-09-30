/**
 * Per-server remote callback end to end, against a real Postgres: the `dynamic_clients`
 * row that binds a DCR redirect URI to one installation is SQL state, so the checks
 * that read it are certified on the real store.
 *
 *   - I4, the redirect-URI triad: the `redirect_uris` the install POSTs to the AS, the
 *     `redirect_uri` of the authorize URL, the path Express routes the AS redirect to,
 *     and the `redirect_uri` replayed on the token POST are one and the same string.
 *   - I11, same-name reinstall: a code sent to the previous installation's URI (old
 *     nonce) is refused; so is any URI of a server whose row carries no nonce.
 *   - I16, DCR vs pre-registered comes from the CR: a public CR without secret refs and
 *     without a row is never treated as pre-registered, and a row registered for
 *     another client id is never used.
 *
 * Real producers (T1): discovery by `discoverRemoteOAuth` over probe fixtures; CR,
 * uid, row and nonce by the real install route; the state by the real authorize-url
 * mint; teardown by the uninstall's own store call. The AS registration response and
 * the token endpoint are the only external edges. Context membership is answered on the
 * app pool as the sibling route suites do (it is not what this suite certifies).
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/oauth.perServerCallback.realPostgres.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import {
  claimDeleteDynamicClientForResource,
  upsertDynamicClient,
} from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { discoverPilot, installRemoteServer, seedContext } from './fixtures/perServerInstall.js'
import {
  ATLASSIAN_V2_PILOT,
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  PILOTS,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

const testDb = vi.hoisted(() => ({
  pool: undefined as import('pg').Pool | undefined,
  context: 'ctx-a',
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
        if (text.includes('FROM user_contexts')) {
          return Promise.resolve({ rows: [{ context_id: testDb.context }], rowCount: 1 })
        }
        return current().query(text, values)
      },
      connect: () => current().connect(),
    },
  }
})

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

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

const tokenEndpoint = vi.hoisted(() => ({ posts: [] as { url: string; body: string }[] }))
vi.mock('../src/http/pinnedFetch.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http/pinnedFetch.js')>(
    '../src/http/pinnedFetch.js'
  )
  return {
    ...actual,
    pinnedFetch: (url: string, field: string, options: Parameters<typeof actual.pinnedFetch>[2]) =>
      options?.transport
        ? actual.pinnedFetch(url, field, options)
        : actual.pinnedFetch(url, field, {
            ...options,
            resolveDns: async () => ['93.184.216.34'],
            transport: async input => {
              tokenEndpoint.posts.push({ url: input.url, body: input.body ?? '' })
              return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                bodyText: JSON.stringify({
                  access_token: 'AT',
                  refresh_token: 'RT',
                  expires_in: 3600,
                }),
              }
            },
          }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const NS = config.mcpServersNamespace
const ORIGIN = 'https://control.example.com'
const CONTEXT = 'ctx-a'
const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const DCR_CLIENT_ID = DCR_PUBLIC_REGISTRATION_RESPONSE.client_id

describeRealPostgres('per-server remote callback (real Postgres)', () => {
  const database = `control_api_per_server_cb_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let atlassian: DiscoveryResult
  let notion: DiscoveryResult
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let savedBaseUrl: string

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    testDb.pool = dbPool
    atlassian = await discoverPilot(ATLASSIAN_V2_PILOT)
    notion = await discoverPilot(PILOTS.notion)
  })

  afterAll(async () => {
    testDb.pool = undefined
    await dbPool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      await adminPool.end()
    }
  })

  beforeEach(async () => {
    await dbPool.query('DELETE FROM dynamic_clients')
    await dbPool.query('DELETE FROM oauth_grants')
    savedBaseUrl = config.oauthCallbackBaseUrl
    config.oauthCallbackBaseUrl = ORIGIN
    gateway = new MockGateway(NS)
    await seedContext(gateway, NS, CONTEXT)
    app = createApp(gateway as never)
    tokenEndpoint.posts.length = 0
  })

  afterEach(() => {
    config.oauthCallbackBaseUrl = savedBaseUrl
  })

  async function installAtlassian(name: string) {
    const res = await installRemoteServer({
      gateway,
      db,
      discovery: atlassian,
      body: {
        serverName: name,
        contextRef: CONTEXT,
        baseUrl: ATLASSIAN_V2_PILOT.mcpUrl,
        mode: 'dcr',
      },
    })
    expect(res.status).toBe(201)
    const post = res.dcrCalls.find(c => c.method === 'POST')
    const registered = (JSON.parse(post?.body ?? '{}') as { redirect_uris?: string[] })
      .redirect_uris
    return { registered, reported: String(res.body.redirectUri) }
  }

  /** The authorize URL the real mint returns; its state is what the AS round-trips. */
  async function mint(name: string): Promise<{ redirectUri: string; state: string }> {
    const res = await request(app)
      .post('/api/v1/internal/mcp-oauth/authorize-url')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: name, userId: 'user-9' })
    if (res.status !== 200)
      throw new Error(`mint failed: ${res.status} ${JSON.stringify(res.body)}`)
    const url = new URL(res.body.authorizeUrl)
    return {
      redirectUri: String(url.searchParams.get('redirect_uri')),
      state: String(url.searchParams.get('state')),
    }
  }

  /** The AS redirect: GET the redirect URI's path with the code and the state. */
  function asRedirect(path: string, state: string) {
    return request(app).get(path).query({ code: 'CODE', state })
  }

  it('I4: DCR registration, authorize, routed callback and token POST share one redirect URI', async () => {
    const { registered, reported } = await installAtlassian('atlassian')
    expect(registered).toHaveLength(1)
    const [registeredUri] = registered as string[]

    const minted = await mint('atlassian')
    const routedPath = new URL(minted.redirectUri).pathname
    const res = await asRedirect(routedPath, minted.state)

    expect(res.status).toBe(200)
    expect(res.text).toContain('mcpServerName=atlassian')
    expect(tokenEndpoint.posts).toHaveLength(1)
    const replayed = new URLSearchParams(tokenEndpoint.posts[0].body).get('redirect_uri')
    expect(minted.redirectUri).toBe(registeredUri)
    expect(`${ORIGIN}${routedPath}`).toBe(registeredUri)
    expect(replayed).toBe(registeredUri)
    expect(reported).toBe(registeredUri)
    expect(registeredUri).toMatch(
      new RegExp(`^${ORIGIN}/api/v1/oauth-callback/remote/atlassian/[0-9a-f-]{36}$`)
    )
    const grants = await dbPool.query('SELECT recipe_name FROM oauth_grants')
    expect(grants.rows).toEqual([{ recipe_name: 'atlassian' }])
  })

  it('I4 pre-registered: install report, authorize, routed callback and token POST agree', async () => {
    const install = await installRemoteServer({
      gateway,
      db,
      discovery: notion,
      body: {
        serverName: 'notion',
        contextRef: CONTEXT,
        baseUrl: PILOTS.notion.mcpUrl,
        mode: 'pre-registered',
        clientId: 'client-notion',
        clientSecret: 'secret-notion',
      },
    })
    expect(install.status).toBe(201)
    const registered = String(install.body.redirectUri)

    const minted = await mint('notion')
    const res = await asRedirect(new URL(minted.redirectUri).pathname, minted.state)

    expect(res.status).toBe(200)
    expect(minted.redirectUri).toBe(registered)
    expect(new URLSearchParams(tokenEndpoint.posts[0].body).get('redirect_uri')).toBe(registered)
    expect(registered).toBe(`${ORIGIN}/api/v1/oauth-callback/remote/notion`)
  })

  it('I11: after a same-name reinstall, a code sent to the old nonce is refused', async () => {
    const first = await installAtlassian('atlassian')
    const oldUri = first.reported
    // Uninstall: the CR goes, and the teardown claims the row bound to its uid.
    const oldCr = (await gateway.getResource('mcpservers', 'atlassian', NS)) as {
      metadata: { uid: string }
    }
    await gateway.deleteResource('mcpservers', 'atlassian', NS)
    const { deleted } = await claimDeleteDynamicClientForResource(
      db,
      KEY,
      { serverNamespace: NS, serverName: 'atlassian' },
      oldCr.metadata.uid
    )
    expect(deleted).toBe(true)
    const second = await installAtlassian('atlassian')
    expect(second.reported).not.toBe(oldUri)

    const minted = await mint('atlassian')
    expect(minted.redirectUri).toBe(second.reported)
    const stale = await asRedirect(new URL(oldUri).pathname, minted.state)

    expect(stale.status).toBe(400)
    expect(stale.body).toEqual({ error: 'invalid_state', reason: 'binding_mismatch' })
    expect(tokenEndpoint.posts).toHaveLength(0)

    const fresh = await asRedirect(new URL(second.reported).pathname, minted.state)
    expect(fresh.status).toBe(200)
  })

  it('I11: a row without an install nonce binds no URI (legacy row, never sealed)', async () => {
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name: 'legacy' },
        spec: {
          contextRef: CONTEXT,
          auth: { type: 'oauth' },
          oauth: buildRemoteOAuthSpec(atlassian, {
            clientMode: 'public',
            grantScope: 'user',
            dynamicClientId: DCR_CLIENT_ID,
          }),
        },
      },
      NS
    )
    // The only producer of a nonce-less row: the pre-install-identity upsert.
    await upsertDynamicClient(db, KEY, {
      serverNamespace: NS,
      serverName: 'legacy',
      issuer: atlassian.issuer,
      clientId: DCR_CLIENT_ID,
      clientMode: 'public',
    })
    const row = await dbPool.query(
      `SELECT install_id, cr_uid FROM dynamic_clients WHERE server_name = 'legacy'`
    )
    expect(row.rows).toEqual([{ install_id: null, cr_uid: null }])

    const mintRes = await request(app)
      .post('/api/v1/internal/mcp-oauth/authorize-url')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'legacy', userId: 'user-9' })
    expect(mintRes.status).toBe(503)

    const state = await signedStateFor('legacy')
    for (const path of ['/remote/legacy', `/remote/legacy/${randomUUID()}`]) {
      const res = await asRedirect(`/api/v1/oauth-callback${path}`, state)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_state', reason: 'binding_mismatch' })
    }
    expect(tokenEndpoint.posts).toHaveLength(0)
  })

  it('I16: a public CR without refs and without a row is not pre-registered → binding_mismatch', async () => {
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name: 'gitops' },
        spec: {
          contextRef: CONTEXT,
          auth: { type: 'oauth' },
          oauth: buildRemoteOAuthSpec(atlassian, {
            clientMode: 'public',
            grantScope: 'user',
            dynamicClientId: DCR_CLIENT_ID,
          }),
        },
      },
      NS
    )

    const res = await asRedirect(
      '/api/v1/oauth-callback/remote/gitops',
      await signedStateFor('gitops')
    )

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_state', reason: 'binding_mismatch' })
    expect(tokenEndpoint.posts).toHaveLength(0)
  })

  it('I16: a bound row registered for another client id → binding_mismatch', async () => {
    const { reported } = await installAtlassian('atlassian')
    const minted = await mint('atlassian')
    // A write that bypassed the install (and the CRD's immutability) points the CR at
    // another client; the row still holds the client its nonce was registered for.
    await gateway.mutateResource(
      'mcpservers',
      'atlassian',
      current => ({
        spec: {
          ...(current.spec as Record<string, unknown>),
          oauth: {
            ...(current.spec as { oauth: Record<string, unknown> }).oauth,
            id: 'another-client',
          },
        },
      }),
      NS
    )

    const res = await asRedirect(new URL(reported).pathname, await signedStateFor('atlassian'))

    expect(minted.redirectUri).toBe(reported)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_state', reason: 'binding_mismatch' })
    expect(tokenEndpoint.posts).toHaveLength(0)
  })

  /**
   * A state for a server the mint refuses (no usable registration). Signed by the same
   * signer the mint uses, with the CR's current client id — what a state minted just
   * before the row went away would carry.
   */
  async function signedStateFor(name: string): Promise<string> {
    const { signOAuthState } = await import('../src/oauth/state.js')
    const cr = (await gateway.getResource('mcpservers', name, NS)) as {
      spec: { oauth: { id: string } }
    }
    return signOAuthState(config.oauthStateHmacSecret, {
      subjectKind: 'mcp',
      mcpServerName: name,
      userId: 'user-9',
      oauthClientId: cr.spec.oauth.id,
      grantKind: 'user',
      background: false,
    } as Parameters<typeof signOAuthState>[1])
  }
})
