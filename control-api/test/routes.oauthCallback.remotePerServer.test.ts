import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import { claimDeleteDynamicClientForResource } from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { signOAuthState } from '../src/oauth/state.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import {
  discoverPilot,
  installRemoteServer,
  seedContext,
  withRfc9207,
} from './fixtures/perServerInstall.js'
import {
  ATLASSIAN_V2_PILOT,
  PILOTS,
  dcrPilot,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * The per-server remote callback and authorize-url through the real app (`createApp`):
 * the public route `GET /api/v1/oauth-callback/remote/:serverName/:installNonce?`, its
 * segment validation, what it reports back (the desktop deep link and the
 * not-configured body name the integration `remote`, as the shared callback does), and
 * the redirect URI the mint puts in the authorize URL.
 *
 * T1: servers are installed by the real admin install route over the same
 * `dynamic_clients` harness the app's pool is pointed at; discovery by the real client.
 * The AS token endpoint is the only network edge, answered by a recording transport.
 */

const dbHolder = vi.hoisted(() => ({
  db: undefined as undefined | { query: (text: string, values?: unknown[]) => Promise<unknown> },
  context: 'ctx-a',
}))

vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => {
        // Membership is the only non-OAuth read on these paths.
        if (text.includes('FROM user_contexts')) {
          return Promise.resolve({ rows: [{ context_id: dbHolder.context }], rowCount: 1 })
        }
        if (!dbHolder.db) throw new Error('test db not initialised')
        return dbHolder.db.query(text, values)
      },
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
vi.mock('../src/http/pinnedFetch.js', async importActual => {
  const actual = await importActual<typeof import('../src/http/pinnedFetch.js')>()
  return {
    ...actual,
    // Only calls that would reach the real network (the callback route injects no
    // transport) are answered here; callers that bring their own keep it.
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

const NS = config.mcpServersNamespace
const ORIGIN = 'https://control.example.com'
const CONTEXT = 'ctx-a'
const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const NONCE = '0f8fad5b-d9cb-469f-a165-70867728950e'

let atlassian: DiscoveryResult
let notion: DiscoveryResult
let notionWithIss: DiscoveryResult
let sharedDcr: DiscoveryResult

beforeAll(async () => {
  atlassian = await discoverPilot(ATLASSIAN_V2_PILOT)
  notion = await discoverPilot(PILOTS.notion)
  notionWithIss = await discoverPilot(withRfc9207(PILOTS.notion))
  sharedDcr = await discoverPilot(withRfc9207(dcrPilot('public')))
})

let gateway: MockGateway
let app: ReturnType<typeof createApp>
let db: ReturnType<typeof makeInMemoryDynamicClientsDb>['db']
let savedBaseUrl: string

beforeEach(async () => {
  savedBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = ORIGIN
  gateway = new MockGateway(NS)
  await seedContext(gateway, NS, CONTEXT)
  db = makeInMemoryDynamicClientsDb().db
  dbHolder.db = db
  app = createApp(gateway as never)
  tokenEndpoint.posts.length = 0
})

afterEach(() => {
  config.oauthCallbackBaseUrl = savedBaseUrl
  dbHolder.db = undefined
})

async function install(
  name: string,
  mode: 'dcr' | 'pre-registered',
  discovery: DiscoveryResult,
  baseUrl: string
): Promise<string> {
  const res = await installRemoteServer({
    gateway,
    db,
    discovery,
    body: {
      serverName: name,
      contextRef: CONTEXT,
      baseUrl,
      mode,
      ...(mode === 'pre-registered'
        ? { clientId: `client-${name}`, clientSecret: `secret-${name}` }
        : {}),
    },
  })
  if (res.status !== 201) throw new Error(`install failed: ${JSON.stringify(res.body)}`)
  return String(res.body.redirectUri)
}

async function oauthOf(name: string): Promise<Record<string, unknown>> {
  const cr = (await gateway.getResource('mcpservers', name, NS)) as {
    spec: { oauth: Record<string, unknown> }
  }
  return cr.spec.oauth
}

async function stateFor(name: string): Promise<string> {
  return signOAuthState(config.oauthStateHmacSecret, {
    subjectKind: 'mcp',
    mcpServerName: name,
    userId: 'user-9',
    oauthClientId: String((await oauthOf(name)).id),
    grantKind: 'user',
    background: false,
  } as Parameters<typeof signOAuthState>[1])
}

function deepLinkOf(html: string): URL {
  const match = /url=([^"]+)"/.exec(html)
  if (!match) throw new Error('no deep link in the success page')
  return new URL(match[1].replace(/&amp;/g, '&'))
}

function mint(name: string) {
  return request(app)
    .post('/api/v1/internal/mcp-oauth/authorize-url')
    .set('Authorization', 'Bearer dev-rpc-proxy-token')
    .set('x-service-token', 'rpc-proxy')
    .send({ mcpServerName: name, userId: 'user-9' })
}

function redirectUriOfMint(res: { body: { authorizeUrl?: string } }): string | null {
  return new URL(String(res.body.authorizeUrl)).searchParams.get('redirect_uri')
}

describe('GET /api/v1/oauth-callback/remote/:serverName/:installNonce?', () => {
  it.each([
    ['an uppercase server name', '/remote/Atlassian'],
    ['an underscore in the name', '/remote/atl_assian'],
    ['a name longer than an RFC 1123 label', `/remote/${'a'.repeat(64)}`],
    ['a trailing hyphen', '/remote/atlassian-'],
    ['an encoded traversal', '/remote/..%2Fadmin'],
    ['a dotted (subdomain) name', '/remote/atlassian.v2'],
    ['a double-encoded slash', '/remote/a%252Fb'],
    ['an uppercase nonce', `/remote/atlassian/${NONCE.toUpperCase()}`],
    ['a nonce that is not a UUID', '/remote/atlassian/not-a-uuid'],
  ])('%s → 404 before any CR is read', async (_label, path) => {
    const read = vi.spyOn(gateway, 'getResource')
    const res = await request(app)
      .get(`/api/v1/oauth-callback${path}`)
      .query({ code: 'CODE', state: 'STATE' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not Found' })
    expect(read).not.toHaveBeenCalled()
  })

  it('I2: /remote/a/<nonceA> with the state of b → 400 binding_mismatch, b never read, no exchange', async () => {
    const a = await install('server-a', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)
    await install('server-b', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)
    const stateOfB = await stateFor('server-b')
    const read = vi.spyOn(gateway, 'getResource')

    const res = await request(app).get(new URL(a).pathname).query({ code: 'CODE', state: stateOfB })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_state', reason: 'binding_mismatch' })
    expect(read).not.toHaveBeenCalledWith('mcpservers', 'server-b', NS)
    expect(tokenEndpoint.posts).toHaveLength(0)
  })

  it('is public: valid segments with no service token reach the handler', async () => {
    const res = await request(app).get(`/api/v1/oauth-callback/remote/atlassian/${NONCE}`)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'missing_code_or_state' })
  })

  it('per-server DCR: success page deep link names clientId=remote and the signed server', async () => {
    const redirectUri = await install('atlassian', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)

    const res = await request(app)
      .get(new URL(redirectUri).pathname)
      .query({ code: 'CODE', state: await stateFor('atlassian') })

    expect(res.status).toBe(200)
    const link = deepLinkOf(res.text)
    expect(link.searchParams.get('clientId')).toBe('remote')
    expect(link.searchParams.get('mcpServerName')).toBe('atlassian')
    expect(link.searchParams.get('source')).toBe('mcp')
    expect(tokenEndpoint.posts).toHaveLength(1)
    expect(new URLSearchParams(tokenEndpoint.posts[0].body).get('redirect_uri')).toBe(redirectUri)
  })

  it('shared: success page deep link names clientId=remote (unchanged)', async () => {
    await install('shared-dcr', 'dcr', sharedDcr, dcrPilot('public').mcpUrl)

    const res = await request(app)
      .get('/api/v1/oauth-callback/remote')
      .query({
        code: 'CODE',
        state: await stateFor('shared-dcr'),
        iss: String((await oauthOf('shared-dcr')).issForCallback),
      })

    expect(res.status).toBe(200)
    expect(deepLinkOf(res.text).searchParams.get('clientId')).toBe('remote')
  })

  it.each([
    ['per-server', () => notion, (name: string) => `/api/v1/oauth-callback/remote/${name}`],
    ['shared', () => notionWithIss, () => '/api/v1/oauth-callback/remote'],
  ])(
    '%s pre-registered with its client Secret gone → 503 naming the integration "remote"',
    async (_label, discovery, path) => {
      await install('hubspot', 'pre-registered', discovery(), PILOTS.notion.mcpUrl)
      const oauth = await oauthOf('hubspot')
      const secretName = (oauth.clientSecretRef as { name: string }).name
      await gateway.deleteSecret(secretName, NS)

      const res = await request(app)
        .get(path('hubspot'))
        .query({
          code: 'CODE',
          state: await stateFor('hubspot'),
          ...(oauth.issForCallback ? { iss: String(oauth.issForCallback) } : {}),
        })

      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ error: 'integration_not_configured', integration: 'remote' })
      expect(tokenEndpoint.posts).toHaveLength(0)
    }
  )

  it('no configured public origin → 503 callback_base_url_unconfigured, no exchange', async () => {
    const redirectUri = await install('atlassian', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)
    config.oauthCallbackBaseUrl = ''

    const res = await request(app)
      .get(new URL(redirectUri).pathname)
      .query({ code: 'CODE', state: await stateFor('atlassian') })

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'callback_base_url_unconfigured' })
    expect(tokenEndpoint.posts).toHaveLength(0)
  })

  it('a repeated iss reaches the per-server check raw → 400 issuer_mismatch', async () => {
    const redirectUri = await install('atlassian', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)
    const state = await stateFor('atlassian')

    const res = await request(app).get(
      `${new URL(redirectUri).pathname}?code=CODE&state=${encodeURIComponent(state)}` +
        `&iss=${encodeURIComponent(atlassian.issuer)}&iss=${encodeURIComponent(atlassian.issuer)}`
    )

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'issuer_mismatch' })
    expect(tokenEndpoint.posts).toHaveLength(0)
  })

  it('shared keeps reading a repeated iss as absent → 400 issuer_mismatch (unchanged)', async () => {
    await install('shared-dcr', 'dcr', sharedDcr, dcrPilot('public').mcpUrl)
    const iss = String((await oauthOf('shared-dcr')).issForCallback)
    const state = await stateFor('shared-dcr')

    const res = await request(app).get(
      `/api/v1/oauth-callback/remote?code=CODE&state=${encodeURIComponent(state)}` +
        `&iss=${encodeURIComponent(iss)}&iss=${encodeURIComponent(iss)}`
    )

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'issuer_mismatch' })
  })
})

describe('POST /api/v1/internal/mcp-oauth/authorize-url — remote redirect URI', () => {
  it('per-server DCR: the authorize redirect_uri is the URI the install registered', async () => {
    const registered = await install('atlassian', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)

    const res = await mint('atlassian')

    expect(res.status).toBe(200)
    expect(redirectUriOfMint(res)).toBe(registered)
    expect(registered).toMatch(/\/api\/v1\/oauth-callback\/remote\/atlassian\/[0-9a-f-]{36}$/)
  })

  it('per-server pre-registered: /remote/<name>, the URI the install reported', async () => {
    const registered = await install('hubspot', 'pre-registered', notion, PILOTS.notion.mcpUrl)

    const res = await mint('hubspot')

    expect(res.status).toBe(200)
    expect(redirectUriOfMint(res)).toBe(`${ORIGIN}/api/v1/oauth-callback/remote/hubspot`)
    expect(redirectUriOfMint(res)).toBe(registered)
  })

  it('shared: the stable /remote URI (unchanged)', async () => {
    const registered = await install('shared-dcr', 'dcr', sharedDcr, dcrPilot('public').mcpUrl)

    const res = await mint('shared-dcr')

    expect(res.status).toBe(200)
    expect(redirectUriOfMint(res)).toBe(`${ORIGIN}/api/v1/oauth-callback/remote`)
    expect(redirectUriOfMint(res)).toBe(registered)
  })

  it('shared without a configured origin keeps falling back to the request Host', async () => {
    await install('shared-dcr', 'dcr', sharedDcr, dcrPilot('public').mcpUrl)
    config.oauthCallbackBaseUrl = ''

    const res = await mint('shared-dcr').set('Host', 'cp.internal.test')

    expect(res.status).toBe(200)
    expect(redirectUriOfMint(res)).toBe('http://cp.internal.test/api/v1/oauth-callback/remote')
  })

  it.each([
    ['unset', ''],
    ['not a bare origin', `${ORIGIN}/base/`],
  ])('per-server with the callback base URL %s → 503, no URL minted', async (_l, baseUrl) => {
    await install('atlassian', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)
    config.oauthCallbackBaseUrl = baseUrl

    const res = await mint('atlassian')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'callback_base_url_unconfigured' })
  })

  it('per-server DCR whose row is gone → 503 integration_not_configured, no URL minted', async () => {
    await install('atlassian', 'dcr', atlassian, ATLASSIAN_V2_PILOT.mcpUrl)
    const cr = (await gateway.getResource('mcpservers', 'atlassian', NS)) as {
      metadata: { uid: string }
    }
    const { deleted } = await claimDeleteDynamicClientForResource(
      db,
      KEY,
      { serverNamespace: NS, serverName: 'atlassian' },
      cr.metadata.uid
    )
    expect(deleted).toBe(true)

    const res = await mint('atlassian')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      error: 'integration_not_configured',
      integration: String((await oauthOf('atlassian')).id),
      hint: 'reinstall the remote MCP server atlassian to register its OAuth client again',
    })
    expect(res.body.authorizeUrl).toBeUndefined()
  })

  // A CR can only carry a non-label name when written outside the install; its callback
  // route would never match, so there is nothing to mint.
  it('per-server server whose name is not an RFC 1123 label → 400 invalid_request', async () => {
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name: 'atlassian.v2' },
        spec: {
          contextRef: CONTEXT,
          auth: { type: 'oauth' },
          oauth: buildRemoteOAuthSpec(atlassian, {
            clientMode: 'public',
            grantScope: 'user',
            dynamicClientId: 'dyn-public-6f1c2a',
          }),
        },
      },
      NS
    )

    const res = await mint('atlassian.v2')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_request' })
  })
})
