import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { verifyOAuthStateSignature } from '../src/oauth/state.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { MockGateway } from './mockGateway.js'

/**
 * U5 — internal endpoint that mints a fresh authorize-URL for an OAuth
 * mcp-server, on click. rpc-proxy is the sole authorized caller
 * (requireInternalService('rpc-proxy')); the `userId` is forwarded over that
 * mutually-authenticated seam (rpc-proxy derives it from the session auth.sub).
 * The `oauthClientId` + grantScope come from the McpServer CR, never the body.
 *
 * Membership gate by flavor:
 *   - `user`    → the user must reach at least one Context whose
 *     `spec.mcpServers` allowlist names the server — directly (user_contexts)
 *     or through an assigned agent's Host (user_agents → Host.contextRef);
 *     `spec.contextRef` is irrelevant and the body `contextId` is ignored.
 *   - `context` → covered by routes.internal.mcpOauth.contextGate.test.ts.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

// The route carries the repo's custom `rateLimitMiddleware`, whose real store
// (`checkAndIncrement`) hits Postgres and would otherwise count across the many
// same-`userId` requests in this suite. Mock it to always allow (mirrors the
// sibling routes.mcpOauth.test.ts); the "429 when denied" case below drives a
// one-shot deny to prove the limiter is actually mounted.
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

const MCP_NS = config.mcpServersNamespace

// The configured external-rest-api service token (shared control-api test value).
// Kept in a const so the literal is not written inline on the Authorization header.
const EXTERNAL_REST_TOKEN = 'dev-external-rest-api-token'

function seedOauthServer(
  gateway: MockGateway,
  opts: { name: string; grantScope?: 'user' | 'context'; contextRef?: string } = { name: 'gdrive' }
): void {
  void gateway.createResource(
    'mcpservers',
    {
      metadata: { name: opts.name },
      spec: {
        contextRef: opts.contextRef ?? 'ctx-9',
        image: 'example/gdrive-mcp:1',
        transport: { type: 'streamableHttp', url: 'https://gdrive.example.com/mcp' },
        auth: { type: 'oauth' },
        oauth: {
          id: 'google-drive',
          provider: 'google',
          clientIdRef: { name: 'google-creds', key: 'client-id' },
          clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          scopes: ['https://www.googleapis.com/auth/drive.readonly'],
          ...(opts.grantScope ? { grantScope: opts.grantScope } : {}),
        },
      },
    },
    MCP_NS
  )
  // client_id must be resolvable for the authorize URL to be built.
  gateway.seedSecret('google-creds', MCP_NS, {
    data: {
      'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
      'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
    },
  })
}

function post(app: ReturnType<typeof createApp>) {
  return request(app).post('/api/v1/internal/mcp-oauth/authorize-url')
}

describe('POST /api/v1/internal/mcp-oauth/authorize-url (U5)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('401 without any service token', async () => {
    seedOauthServer(gateway)
    const res = await post(app).send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(401)
  })

  it('401 for an authenticated NON-rpc-proxy service (external-rest-api)', async () => {
    seedOauthServer(gateway)
    const res = await post(app)
      .set('Authorization', `Bearer ${EXTERNAL_REST_TOKEN}`)
      .set('x-service-token', 'external-rest-api')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(401)
  })

  it('mints an authorize-URL whose signed state binds the forwarded userId + the SERVER oauthClientId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    // user-7 is a member of ctx-9, whose allowlist enables gdrive.
    await seedAllowlistedContext(gateway, 'ctx-9', ['gdrive'])
    membership(mockPoolQuery, { contexts: { 'user-7': ['ctx-9'] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      // A bogus oauthClientId in the body MUST be ignored — it is derived from
      // the server. userId is the value forwarded from the session.
      .send({ mcpServerName: 'gdrive', userId: 'user-7', oauthClientId: 'attacker-client' })

    if (res.status !== 200) {
      throw new Error(`got ${res.status}: ${JSON.stringify(res.body)}\n${res.text}`)
    }
    const authorizeUrl: string = res.body.authorizeUrl
    expect(authorizeUrl).toContain('https://accounts.google.com/')

    const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
    const verified = verifyOAuthStateSignature(config.oauthStateHmacSecret, state)
    expect(verified.kind).toBe('ok')
    if (verified.kind === 'ok') {
      expect(verified.claims.subjectKind).toBe('mcp')
      if (verified.claims.subjectKind === 'mcp') {
        expect(verified.claims.mcpServerName).toBe('gdrive')
      }
      // userId comes from the seam-forwarded body value…
      expect(verified.claims.userId).toBe('user-7')
      // …but oauthClientId is the server's, NOT the attacker body value.
      expect(verified.claims.oauthClientId).toBe('google-drive')
    }
  })

  it('400 invalid_request when userId is absent (nothing to bind the state to)', async () => {
    seedOauthServer(gateway)
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('404 server_not_found for an unknown server', async () => {
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'ghost', userId: 'user-1' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('server_not_found')
  })

  it('400 not_oauth_server for a non-oauth server', async () => {
    void gateway.createResource(
      'mcpservers',
      { metadata: { name: 'plain' }, spec: { auth: { type: 'none' } } },
      MCP_NS
    )
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'plain', userId: 'user-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('not_oauth_server')
  })

  // ── user flavor: membership by allowlist ────────────────────────────────
  //
  // These replace the earlier "member of spec.contextRef" expectations: a
  // `user`-scope grant is keyed by (user, server) and serves every Context that
  // enables the server, so the gate is "the user reaches at least one Context
  // whose allowlist names the server", directly or through an assigned agent.
  // The server's own `spec.contextRef` no longer decides anything for this
  // flavor.

  // Reproduces the reported 403: the server's contextRef is a Context the user
  // is NOT in, but a Context the user IS in allowlists the server.
  it('user flavor: member of an allowlisting Context (not the server contextRef) mints OK', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-owner' })
    await seedAllowlistedContext(gateway, 'ctx-owner', ['gdrive'])
    await seedAllowlistedContext(gateway, 'ctx-business', ['gdrive'])
    membership(mockPoolQuery, { contexts: { 'user-7': ['ctx-business', 'ctx-unrelated'] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(200)
    expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
  })

  it('user flavor: the requesting user is not a member but another user is → 403, NO authorizeUrl', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-owner' })
    await seedAllowlistedContext(gateway, 'ctx-business', ['gdrive'])
    membership(mockPoolQuery, { contexts: { 'someone-else': ['ctx-business'] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
    expect(res.body.authorizeUrl).toBeUndefined()
  })

  // The server's own Context dropped it; the user still reaches a Context that
  // allowlists it through an assigned agent, which is where the connectors
  // panel offers it.
  it('user flavor: reached only through an assigned agent whose Context allowlists it mints OK', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-owner' })
    await seedAllowlistedContext(gateway, 'ctx-owner', [])
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, {
      contexts: { 'user-7': ['ctx-owner'] },
      agents: { 'user-7': ['host-c'] },
    })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(200)
    expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
  })

  it('user flavor: the body contextId is ignored (neither required nor cross-checked)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-owner' })
    await seedAllowlistedContext(gateway, 'ctx-business', ['gdrive'])
    membership(mockPoolQuery, { contexts: { 'user-7': ['ctx-business'] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-7', contextId: 'ctx-anything' })
    expect(res.status).toBe(200)
  })

  it('user flavor: no Context of the user allowlists the server → 403, NO authorizeUrl', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    await seedAllowlistedContext(gateway, 'ctx-other', ['some-other-server'])
    membership(mockPoolQuery, { contexts: { 'user-8': ['ctx-other'] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-8' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
    expect(res.body.authorizeUrl).toBeUndefined()
  })

  it('user flavor: a user with no Contexts at all → 403', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    await seedAllowlistedContext(gateway, 'ctx-9', ['gdrive'])
    membership(mockPoolQuery, { contexts: { 'user-8': [] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-8' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
  })

  // An allowlist only counts through membership: a Context that enables the
  // server but that the user does not belong to grants nothing — including the
  // server's own contextRef Context.
  it('user flavor: an allowlisting Context the user is NOT a member of does not count → 403', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    await seedAllowlistedContext(gateway, 'ctx-9', ['gdrive'])
    await seedAllowlistedContext(gateway, 'ctx-business', ['gdrive'])
    await seedAllowlistedContext(gateway, 'ctx-other', [])
    membership(mockPoolQuery, { contexts: { 'user-8': ['ctx-other'] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-8' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
    expect(res.body.authorizeUrl).toBeUndefined()
  })

  // A K8s read failure in the per-user gate is a backend failure, not a
  // membership verdict: it must neither mint nor read as a 403.
  it('user flavor: 500 without authorizeUrl when listing Contexts fails', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-owner' })
    await seedAllowlistedContext(gateway, 'ctx-business', ['gdrive'])
    membership(mockPoolQuery, { contexts: { 'user-7': ['ctx-business'] } })
    const realList = gateway.listResource.bind(gateway)
    vi.spyOn(gateway, 'listResource').mockImplementation((plural, ns) =>
      plural === 'contexts'
        ? Promise.reject(Object.assign(new Error('apiserver unavailable'), { statusCode: 503 }))
        : realList(plural, ns)
    )
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(500)
    expect(res.body.authorizeUrl).toBeUndefined()
  })

  it('user flavor: 500 without authorizeUrl when an assigned agent Host read fails and no direct Context enables the server', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-owner' })
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, { agents: { 'user-7': ['host-c'] } })
    const realGet = gateway.getResource.bind(gateway)
    vi.spyOn(gateway, 'getResource').mockImplementation((plural, name, ns) =>
      plural === 'hosts'
        ? Promise.reject(Object.assign(new Error('apiserver unavailable'), { statusCode: 503 }))
        : realGet(plural, name, ns)
    )
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(500)
    expect(res.body.authorizeUrl).toBeUndefined()
  })

  it('503 integration_not_configured when the client_id Secret is absent', async () => {
    // Server exists but no google-creds Secret seeded.
    void gateway.createResource(
      'mcpservers',
      {
        metadata: { name: 'gdrive' },
        spec: {
          contextRef: 'ctx-9',
          auth: { type: 'oauth' },
          oauth: {
            id: 'google-drive',
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          },
        },
      },
      MCP_NS
    )
    // Member of ctx-9, which enables gdrive, so we reach the Secret read (past
    // the membership gate).
    await seedAllowlistedContext(gateway, 'ctx-9', ['gdrive'])
    membership(mockPoolQuery, { contexts: { 'user-1': ['ctx-9'] } })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('integration_not_configured')
  })

  // The route is rate-limited (bucket keyed by the forwarded userId). When the
  // bucket is exhausted the middleware short-circuits with 429 BEFORE the
  // handler runs — no server read, no state mint.
  it('429 Too Many Requests when the rate limit is exceeded', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    vi.mocked(checkAndIncrement).mockResolvedValueOnce({
      allowed: false,
      backendAvailable: true,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 61,
    })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('Too Many Requests')
    // Denied before the handler — no membership lookup ran.
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})
