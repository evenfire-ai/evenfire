import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { MockGateway } from './mockGateway.js'

/**
 * R3-H4 (§7 row 3, T1/T3/T4) — uninstalling an OAuth McpServer through the REGISTRY
 * route tears its grants down, so a same-name reinstall with the same
 * `oauth_client_id` starts with no user connected.
 *
 * Every layer is its real producer: the registry install creates the CR and the
 * managed client Secret; the state comes from `buildAuthorizeUrl`; the grant is
 * written by the real callback route (`GET /oauth-callback/:id`) sealed with the CR
 * uid. Only the provider's token endpoint is simulated (an external AS). Observed
 * through two real readers:
 *   - `listUserGrantsForServer`, the store reader behind the admin per-server grants
 *     listing, deliberately NOT fenced by the live uid (it must list rows to manage
 *     them) — the residue a registry uninstall used to leave shows up here as a
 *     still-connected user;
 *   - the grant-existence sweep, fenced by the live uid.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<u>:<p>@<host>:5432/<db> npm test -- \
 *     test/routes.registryUninstall.realPostgres.integration.test.ts
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/services/registryClient.js', () => ({
  searchEntries: vi.fn(),
  getEntry: vi.fn(),
  getEntryVersion: vi.fn(),
  getCredentialSchema: vi.fn(),
  getCategories: vi.fn(),
  reportInstall: vi.fn(),
  downloadBundle: vi.fn(),
  getDigest: vi.fn(),
  uploadArtifacts: vi.fn(),
  updateVersionMetadata: vi.fn(),
  deleteVersion: vi.fn(),
  publishEntry: vi.fn(),
  resolvePublishScope: vi.fn(),
  applyPublishScope: vi.fn((name: string | undefined) => name),
}))

const dbHolder = vi.hoisted(() => ({
  target: null as null | { query: (text: string, values?: unknown[]) => Promise<unknown> },
}))
vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: async (text: string, values?: unknown[]) => {
        if (!dbHolder.target) throw new Error('test database not ready')
        return dbHolder.target.query(text, values)
      },
    },
  }
})

const { config } = await import('../src/config.js')
const { initDb } = await import('../src/db.js')
const { buildAuthorizeUrl } = await import('../src/oauth/authorizeUrlHelper.js')
const { resolveServerOAuthSubject } = await import('../src/oauth/mcpServerOAuthSpec.js')
const { listUserGrantsForServer } = await import('../src/oauth/store.js')
const { createAdminRegistryRouter } = await import('../src/routes/admin/registry.js')
const { createOAuthCallbackRouter } = await import('../src/routes/external/oauthCallback.js')
const { resolveBatchGrantExistence } = await import('../src/routes/mcpOauth.js')
const { getCredentialSchema, getDigest, getEntryVersion, reportInstall } =
  await import('../src/services/registryClient.js')

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const NS = 'mcp-server'
const SERVER = 'my-gmail'
// users.id is a UUID: the callback's consent admission (PR #1004) reads the
// membership tables, which reject a non-UUID subject.
const USER = '00000000-0000-4000-8000-000000000009'

/** Baked-OAuth catalog entry, same shape as the registry OAuth install tests. */
const GMAIL_ENTRY = {
  id: '1',
  name: 'gmail-mcp',
  version: '1.0.0',
  entry_type: 'mcp-server',
  description: 'Gmail MCP server',
  author: 'clerum',
  origin: 'official',
  category: 'productivity',
  tags: ['gmail'],
  trust_level: 'high',
  quality_tier: 'verified',
  status: 'published',
  server_mode: 'local',
  transport: 'streamableHttp',
  recipe_type: null,
  mcp_server_meta: {
    imageRef: 'clerum/gmail-mcp:1.0.0',
    port: 3000,
    oauth: { provider: 'google', scopes: [] },
  },
  recipe_meta: null,
  artifact_refs: null,
  downloads: 0,
  installs: 0,
  created_at: '2026-03-01T00:00:00Z',
}

describeRealPostgres('registry uninstall tears OAuth grants down (real Postgres)', () => {
  const database = `control_api_registry_uninstall_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  let prevCallbackBase = ''
  let prevMcpNs = ''
  let prevContextsNs = ''

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    dbHolder.target = db
  })

  afterAll(async () => {
    try {
      dbHolder.target = null
      await endPoolAndWaitForClients(dbPool)
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

  beforeEach(() => {
    vi.mocked(getDigest).mockResolvedValue({ digest: null })
    vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
    vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
    vi.mocked(getEntryVersion).mockResolvedValue(GMAIL_ENTRY as never)
    prevCallbackBase = config.oauthCallbackBaseUrl
    prevMcpNs = config.mcpServersNamespace
    prevContextsNs = config.contextsNamespace
    config.oauthCallbackBaseUrl = 'https://control.example.com'
    config.mcpServersNamespace = NS
    config.contextsNamespace = NS
    // The provider's token endpoint (an external AS) is the only simulated party.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'AT',
              refresh_token: 'RT',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )
  })

  afterEach(() => {
    config.oauthCallbackBaseUrl = prevCallbackBase
    config.mcpServersNamespace = prevMcpNs
    config.contextsNamespace = prevContextsNs
    vi.unstubAllGlobals()
  })

  function makeApp(gw: MockGateway) {
    const app = express()
    app.use(express.json())
    app.use(createAdminRegistryRouter(gw as unknown as K8sGateway))
    app.use(createOAuthCallbackRouter(gw as unknown as K8sGateway))
    return app
  }

  const install = (app: express.Express) =>
    request(app)
      .post('/admin/registry/install')
      .send({
        serverName: SERVER,
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          grantScope: 'user',
          secret: { mode: 'managed', clientId: 'cid-value', clientSecret: 'csec-value' },
        },
      })

  /** Mint the state with the real authorize-URL builder, then hit the real callback. */
  async function consent(app: express.Express, gw: MockGateway): Promise<request.Response> {
    const minted = await buildAuthorizeUrl(
      {
        subjectKind: 'mcp',
        mcpServerName: SERVER,
        oauthClientId: SERVER,
        userId: USER,
        grantKind: 'user',
        redirectUri: `https://control.example.com/api/v1/oauth-callback/${SERVER}`,
      },
      {
        recipeReader: { read: async () => null },
        mcpServerReader: {
          read: async name => {
            const resolved = resolveServerOAuthSubject(
              (await gw.getResource('mcpservers', name, NS)) as Parameters<
                typeof resolveServerOAuthSubject
              >[0],
              'consent'
            )
            return resolved ? { namespace: NS, ...resolved } : null
          },
        },
        secretReader: {
          read: async (name, ns) => {
            const raw = (await gw.getSecret(name, ns)) as { data?: Record<string, string> }
            return Object.fromEntries(
              Object.entries(raw.data ?? {}).map(([k, v]) => [
                k,
                Buffer.from(v, 'base64').toString('utf8'),
              ])
            )
          },
        },
        stateSecret: config.oauthStateHmacSecret,
      }
    )
    if (minted.kind !== 'ok') throw new Error(`authorize url not minted: ${minted.kind}`)
    const state = new URL(minted.authorizeUrl).searchParams.get('state')!
    return request(app).get(`/oauth-callback/${SERVER}`).query({ code: 'AUTH_CODE', state })
  }

  const sweep = (gw: MockGateway) =>
    resolveBatchGrantExistence(
      { db, gateway: gw as unknown as K8sGateway, mcpServersNamespace: NS },
      [{ mcpServerName: SERVER, userId: USER }]
    )

  it('a same-name reinstall starts with no connected user after a registry uninstall', async () => {
    const gw = new MockGateway(NS)
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    const app = makeApp(gw)
    // The consenting user is a member of the install Context, which the install
    // allowlists the server into — the exposure the callback admits by (PR #1004).
    await db.query(`INSERT INTO users (id, email) VALUES ($1, 'user-9@example.com')`, [USER])
    await db.query(
      `INSERT INTO user_contexts (user_id, context_id) VALUES ($1, 'default-context')`,
      [USER]
    )

    expect((await install(app)).status).toBe(201)
    expect((await consent(app, gw)).status).toBe(200)
    // Precondition: the consent produced a connected user, visible to both readers.
    expect(await listUserGrantsForServer(db, { namespace: NS, name: SERVER })).toHaveLength(1)
    expect(await sweep(gw)).toEqual([{ mcpServerName: SERVER, userId: USER, exists: true }])

    const uninstall = await request(app).delete(`/admin/registry/uninstall/${SERVER}`)
    expect(uninstall.status).toBe(200)
    expect((await install(app)).status).toBe(201)

    // The reinstall has the same oauth_client_id; no user may appear connected to it.
    expect(await listUserGrantsForServer(db, { namespace: NS, name: SERVER })).toEqual([])
    expect(await sweep(gw)).toEqual([{ mcpServerName: SERVER, userId: USER, exists: false }])
  })
})
