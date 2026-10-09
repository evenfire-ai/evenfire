import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { verifyOAuthStateSignature } from '../src/oauth/state.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { MockGateway } from './mockGateway.js'

/**
 * U5 — internal endpoint that mints a fresh authorize-URL for an OAuth
 * mcp-server, on click. rpc-proxy is the sole authorized caller
 * (requireInternalService('rpc-proxy')); the `userId` is forwarded over that
 * mutually-authenticated seam (rpc-proxy derives it from the session auth.sub).
 * The `oauthClientId` + Context come from the McpServer CR, never the body.
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

/**
 * A Context CR in the mcp-servers namespace whose `spec.mcpServers` allowlist
 * exposes `servers` to its agents. Per-user consent is admitted by this
 * exposure (PR #1004), so a user-scope mint needs one listing the server.
 */
function seedContext(gateway: MockGateway, contextId: string, servers: string[]): void {
  void gateway.createResource(
    'contexts',
    { metadata: { name: contextId }, spec: { contextId, mcpServers: servers } },
    MCP_NS
  )
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
    // Admission runs for EVERY scope: user-7 is a member of ctx-9, which lists
    // the server.
    seedContext(gateway, 'ctx-9', ['gdrive'])
    mockPoolQuery.mockResolvedValue({ rows: [{ context_id: 'ctx-9' }], rowCount: 1 })
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

  it('context server: rejects a cross-context body contextId with 400 context_mismatch', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-2', contextId: 'ctx-B' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('context_mismatch')
  })

  it('context server: accepts a matching body contextId from a MEMBER and mints the URL', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    // The owner Context resource the server's contextRef names must exist.
    seedContext(gateway, 'ctx-A', ['gdrive'])
    // Membership check (getUserContexts → user_contexts): user-2 is a member of ctx-A.
    mockPoolQuery.mockResolvedValue({ rows: [{ context_id: 'ctx-A' }], rowCount: 1 })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-2', contextId: 'ctx-A' })
    expect(res.status).toBe(200)
    expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
  })

  // T5 (DEC-U5-1): a NON-member of a context-identity server's Context must be
  // rejected at the MINT boundary — fail early, never sent to the provider.
  it('context server: a NON-member is rejected 403 at mint, with NO authorizeUrl', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    seedContext(gateway, 'ctx-A', ['gdrive'])
    // getUserContexts returns contexts that do NOT include ctx-A.
    mockPoolQuery.mockResolvedValue({
      rows: [{ context_id: 'ctx-other' }, { context_id: 'ctx-else' }],
      rowCount: 2,
    })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-nomember' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
    // Observable: no authorize URL was minted.
    expect(res.body.authorizeUrl).toBeUndefined()
  })

  // Security fix: the per-user flavor ALSO runs the admission gate — connect
  // shares the invoke scope. A member of a Context that exposes the server
  // mints fine.
  it('user flavor: a member of a Context listing the server mints OK', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    seedContext(gateway, 'ctx-9', ['gdrive'])
    mockPoolQuery.mockResolvedValue({ rows: [{ context_id: 'ctx-9' }], rowCount: 1 })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(200)
    expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
    // The membership lookup DID run (universal gate).
    const membershipQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM user_contexts')
    )
    expect(membershipQuery).toBeDefined()
    expect(membershipQuery?.[1]).toEqual(['user-7'])
  })

  // #989: a user granted the agent at creation has user_agents (or team_agents)
  // rows but no user_contexts row. Agent access is authoritative, so they are a
  // member of that agent's Context and can mint the authorize URL.
  describe('agent-granted membership (#989)', () => {
    function routeDb(opts: { userAgents?: string[]; teams?: string[]; teamAgents?: string[] }) {
      mockPoolQuery.mockImplementation((sql: unknown) => {
        const text = typeof sql === 'string' ? sql : ''
        const rows = (values: Array<Record<string, string>>) =>
          Promise.resolve({ rows: values, rowCount: values.length })
        if (text.includes('FROM user_agents')) {
          return rows((opts.userAgents ?? []).map(agent_name => ({ agent_name })))
        }
        if (text.includes('FROM team_members')) {
          return rows((opts.teams ?? []).map(id => ({ id, name: id, role: 'member' })))
        }
        if (text.includes('FROM team_agents')) {
          return rows((opts.teamAgents ?? []).map(agent_name => ({ agent_name })))
        }
        return rows([])
      })
    }

    function seedHost(name: string, contextRef: string) {
      void gateway.createResource(
        'hosts',
        { metadata: { name }, spec: { contextRef } },
        config.hostsNamespace
      )
    }

    it('a user granted the agent directly mints the URL without a user_contexts row', async () => {
      seedOauthServer(gateway, {
        name: 'gdrive',
        grantScope: 'user',
        contextRef: 'jose-agent-60946',
      })
      seedHost('jose-agent', 'jose-agent-60946')
      seedContext(gateway, 'jose-agent-60946', ['gdrive'])
      routeDb({ userAgents: ['jose-agent'] })
      const res = await post(app)
        .set('Authorization', 'Bearer dev-rpc-proxy-token')
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'gdrive', userId: 'user-7' })
      expect(res.status).toBe(200)
      expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
    })

    it('a user whose team is granted the agent mints the URL for a context-scope server', async () => {
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'team-ctx' })
      seedHost('team-agent', 'team-ctx')
      seedContext(gateway, 'team-ctx', ['gdrive'])
      routeDb({ teams: ['team-1'], teamAgents: ['team-agent'] })
      const res = await post(app)
        .set('Authorization', 'Bearer dev-rpc-proxy-token')
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'gdrive', userId: 'user-7' })
      expect(res.status).toBe(200)
    })

    it('a user granted only a DIFFERENT agent is still rejected 403', async () => {
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
      seedHost('jose-agent', 'jose-agent-60946')
      seedHost('owner-agent', 'ctx-9')
      routeDb({ userAgents: ['jose-agent'] })
      const res = await post(app)
        .set('Authorization', 'Bearer dev-rpc-proxy-token')
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'gdrive', userId: 'user-8' })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('context_membership_denied')
    })
  })

  // PR #1004: per-user consent is admitted by agent EXPOSURE — any Context the
  // user reaches through an agent (or legacy user_contexts) that lists the
  // server — never by membership of the server's owner Context.
  describe('per-user consent follows agent exposure (PR #1004)', () => {
    function routeDb(opts: { userAgents?: string[]; teams?: string[]; teamAgents?: string[] }) {
      mockPoolQuery.mockImplementation((sql: unknown) => {
        const text = typeof sql === 'string' ? sql : ''
        const rows = (values: Array<Record<string, string>>) =>
          Promise.resolve({ rows: values, rowCount: values.length })
        if (text.includes('FROM user_agents')) {
          return rows((opts.userAgents ?? []).map(agent_name => ({ agent_name })))
        }
        if (text.includes('FROM team_members')) {
          return rows((opts.teams ?? []).map(id => ({ id, name: id, role: 'member' })))
        }
        if (text.includes('FROM team_agents')) {
          return rows((opts.teamAgents ?? []).map(agent_name => ({ agent_name })))
        }
        return rows([])
      })
    }

    function seedHost(name: string, contextRef: string) {
      void gateway.createResource(
        'hosts',
        { metadata: { name }, spec: { contextRef } },
        config.hostsNamespace
      )
    }

    function seedNamedContext(name: string, contextId: string, servers: string[]) {
      void gateway.createResource(
        'contexts',
        { metadata: { name }, spec: { contextId, mcpServers: servers } },
        MCP_NS
      )
    }

    function mint(userId: string) {
      return post(app)
        .set('Authorization', 'Bearer dev-rpc-proxy-token')
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'gdrive', userId })
    }

    beforeEach(() => {
      // The server is installed into an owner Context the consenting users are
      // not members of; only agent B's Context may expose it.
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-owner' })
      seedContext(gateway, 'ctx-owner', ['gdrive'])
      seedHost('owner-agent', 'ctx-owner')
    })

    it('a user granted only agent B, whose Context lists the server, mints the URL', async () => {
      seedHost('agent-b', 'ctx-b')
      seedContext(gateway, 'ctx-b', ['gdrive'])
      routeDb({ userAgents: ['agent-b'] })
      const res = await mint('user-b')
      expect(res.status).toBe(200)
      expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
    })

    it('a user whose active team is granted agent B mints the URL', async () => {
      seedHost('agent-b', 'ctx-b')
      seedContext(gateway, 'ctx-b', ['gdrive'])
      routeDb({ teams: ['team-1'], teamAgents: ['agent-b'] })
      const res = await mint('user-t')
      expect(res.status).toBe(200)
    })

    it('an outsider whose agents do not expose the server is rejected 403', async () => {
      seedHost('agent-c', 'ctx-c')
      seedContext(gateway, 'ctx-c', ['notion'])
      routeDb({ userAgents: ['agent-c'] })
      const res = await mint('user-c')
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('context_membership_denied')
      expect(res.body.authorizeUrl).toBeUndefined()
    })

    it('a private install is rejected until agent B is assigned the connector, then mints', async () => {
      seedHost('agent-b', 'ctx-b')
      seedContext(gateway, 'ctx-b', [])
      routeDb({ userAgents: ['agent-b'] })
      expect((await mint('user-b')).status).toBe(403)

      await gateway.mutateResource(
        'contexts',
        'ctx-b',
        current => ({ spec: { ...(current.spec as object), mcpServers: ['gdrive'] } }),
        MCP_NS
      )
      expect((await mint('user-b')).status).toBe(200)
    })

    // R2 Context identity: a Host `contextRef` names the Context RESOURCE
    // (`metadata.name`, as host-context-controller reads it), never another
    // resource's wire `spec.contextId`.
    it("Host A only: a Context B whose contextId collides with A's resource name is NOT used (403)", async () => {
      seedHost('agent-a', 'ctx-a')
      seedNamedContext('ctx-a', 'ctx-wire-a', ['other-server'])
      seedNamedContext('ctx-b', 'ctx-a', ['gdrive'])
      routeDb({ userAgents: ['agent-a'] })
      const res = await mint('user-a')
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('context_membership_denied')
      expect(res.body.authorizeUrl).toBeUndefined()
    })

    it('Host A only: the collision is denied regardless of Context listing order (403)', async () => {
      seedHost('agent-a', 'ctx-a')
      seedNamedContext('ctx-b', 'ctx-a', ['gdrive'])
      seedNamedContext('ctx-a', 'ctx-wire-a', ['other-server'])
      routeDb({ userAgents: ['agent-a'] })
      expect((await mint('user-a')).status).toBe(403)
    })

    it('Host A only: Context resource ctx-a with wire id ctx-wire-a exposing the server mints (200)', async () => {
      seedHost('agent-a', 'ctx-a')
      seedNamedContext('ctx-a', 'ctx-wire-a', ['gdrive'])
      routeDb({ userAgents: ['agent-a'] })
      const res = await mint('user-a')
      expect(res.status).toBe(200)
      expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
    })

    it('a shared server allowlisted by agent B but owned elsewhere is rejected 403', async () => {
      void gateway.deleteResource('mcpservers', 'gdrive', MCP_NS)
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-owner' })
      seedHost('agent-b', 'ctx-b')
      seedContext(gateway, 'ctx-b', ['gdrive'])
      routeDb({ userAgents: ['agent-b'] })
      const res = await mint('user-b')
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('context_membership_denied')
    })
  })

  // Security fix (the asymmetry hole): a `user`-scope server whose Context the
  // user is NOT in must be rejected — no consent for another Context's
  // integration, no cross-context enumeration oracle.
  it('user flavor: a NON-member is rejected 403 at mint, with NO authorizeUrl', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    // user-8 is a member of other Contexts, but NOT ctx-9.
    mockPoolQuery.mockResolvedValue({ rows: [{ context_id: 'ctx-other' }], rowCount: 1 })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-8' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
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
    // Member of ctx-9, which lists the server, so we reach the Secret read
    // (past the admission gate).
    seedContext(gateway, 'ctx-9', ['gdrive'])
    mockPoolQuery.mockResolvedValue({ rows: [{ context_id: 'ctx-9' }], rowCount: 1 })
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
