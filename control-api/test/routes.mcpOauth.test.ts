import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { issueMcpHostControlJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

const MCP_NS = config.mcpServersNamespace
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

function seedOauthServer(
  gateway: MockGateway,
  opts: { name: string; grantScope?: 'user' | 'context'; contextRef?: string }
): void {
  void gateway.createResource(
    'mcpservers',
    {
      metadata: { name: opts.name },
      spec: {
        // contextRef is CRD-required + singular — the AUTHORITATIVE Context.
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
}

// Control JWT derived from the REAL minter (T1) — no hand-forged token.
function controlToken(scopes: Array<'oauth:user-token'> = ['oauth:user-token']): string {
  return issueMcpHostControlJwt('mcp-host', 'standalone', ['mcp-host/standalone'], { scopes }).token
}

function nonExpiredUserGrantRow(userId: string, expiresAt: Date) {
  return {
    owner_kind: 'mcpserver',
    recipe_namespace: MCP_NS,
    recipe_name: 'gdrive',
    user_id: userId,
    context_id: null,
    bootstrapped_by_user_id: null,
    oauth_client_id: 'google-drive',
    grant_kind: 'user',
    provider: 'google',
    access_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'GDRIVE-ACCESS'),
    refresh_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'GDRIVE-REFRESH'),
    access_token_expires_at: expiresAt,
    updated_at: new Date(),
    background: false,
  }
}

describe('routes/mcp-oauth — POST /mcp-oauth/user-token (U1)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    // These specs assert the broker's live behavior, so run them with the
    // kill-switch ON. The flag defaults OFF (fail-closed); the OFF→404 spec
    // below flips it back to exercise the disabled path.
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  it('401 without a control JWT', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(401)
  })

  it('403 with a valid control JWT that lacks the oauth:user-token scope', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken([])}`)
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('insufficient_scope')
  })

  it('200 {token,expiresAt} for a per-user grant, keyed by (mcpserver owner, userId)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const future = new Date(Date.now() + 3600_000)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [nonExpiredUserGrantRow('user-1', future)],
      rowCount: 1,
    })

    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'gdrive', userId: 'user-1', contextId: 'ctx-9' })

    expect(res.status).toBe(200)
    expect(res.body.token).toBe('GDRIVE-ACCESS')
    expect(res.body.expiresAt).toBe(future.toISOString())

    // Grant lookup scoped to the mcpserver owner + asserted userId, oauthClientId
    // derived from the server (never the body).
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM oauth_grants') &&
        sql.includes("grant_kind = 'user'")
    )
    expect(grantQuery?.[1]).toEqual(['mcpserver', MCP_NS, 'gdrive', 'user-1', 'google-drive'])
  })

  it('404 no_grant when no row exists', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'gdrive', userId: 'nobody' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('no_grant')
  })

  it('404 server_not_found for an unknown server', async () => {
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
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
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'plain', userId: 'user-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('not_oauth_server')
  })

  it('context flavor: key uses the AUTHORITATIVE spec.contextRef, not the body; user_id NULL', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    const future = new Date(Date.now() + 3600_000)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          ...nonExpiredUserGrantRow('', future),
          grant_kind: 'shared',
          user_id: null,
          context_id: 'ctx-A',
          bootstrapped_by_user_id: 'user-1',
        },
      ],
      rowCount: 1,
    })

    // Body omits contextId entirely — the server's contextRef is authoritative.
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'gdrive', userId: 'user-2' })

    expect(res.status).toBe(200)
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM oauth_grants') &&
        sql.includes("grant_kind = 'shared'")
    )
    // owner, ns, name, contextId(=contextRef), clientId — userId NOT a coordinate.
    expect(grantQuery?.[1]).toEqual(['mcpserver', MCP_NS, 'gdrive', 'ctx-A', 'google-drive'])
  })

  // Guardian (T5): a caller with the scope must NOT be able to fetch another
  // Context's shared token by asserting a foreign contextId in the body. The
  // server's spec.contextRef is 'ctx-A'; a request naming 'ctx-B' is rejected
  // BEFORE any grant lookup — the ctx-B token is never observable (T4).
  it('rejects a cross-context body contextId with 400 context_mismatch and never queries the foreign grant', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })

    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'gdrive', userId: 'user-2', contextId: 'ctx-B' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('context_mismatch')
    expect(res.body.token).toBeUndefined()
    // No grant lookup ran at all — the foreign coordinate never reached the DB.
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
    )
    expect(grantQuery).toBeUndefined()
  })

  // Happy-negative for the context branch (U1 dispatch, U6 activation): when NO
  // shared grant exists for the server's authoritative contextRef, the broker
  // returns 404 no_grant — the same fail-closed outcome the user branch gives,
  // driven through the REAL shared getOAuthGrant SQL (mockPoolQuery → 0 rows).
  it('context flavor: 404 no_grant when no shared grant exists for spec.contextRef', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    // Default mock already resolves { rows: [], rowCount: 0 } → getOAuthGrant null.
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'gdrive', userId: 'user-2' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('no_grant')
    expect(res.body.token).toBeUndefined()
    // The lookup that ran was the SHARED coordinate keyed by contextRef, no userId.
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM oauth_grants') &&
        sql.includes("grant_kind = 'shared'")
    )
    expect(grantQuery?.[1]).toEqual(['mcpserver', MCP_NS, 'gdrive', 'ctx-A', 'google-drive'])
  })

  // Fail-closed: a context-flavor server that is missing its CRD-required
  // spec.contextRef must NOT resolve to any grant. The broker rejects with 400
  // server_missing_context BEFORE any DB lookup (mini-spec 05 §2 — the shared
  // key coordinate is unresolvable, so there is nothing safe to query).
  it('context flavor: 400 server_missing_context when spec.contextRef is absent, no grant lookup', async () => {
    void gateway.createResource(
      'mcpservers',
      {
        metadata: { name: 'no-ctx' },
        spec: {
          // contextRef deliberately omitted.
          auth: { type: 'oauth' },
          oauth: {
            id: 'google-drive',
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
            grantScope: 'context',
          },
        },
      },
      MCP_NS
    )
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'no-ctx', userId: 'user-2' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('server_missing_context')
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
    )
    expect(grantQuery).toBeUndefined()
  })

  it('accepts a body contextId that matches spec.contextRef', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    const future = new Date(Date.now() + 3600_000)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          ...nonExpiredUserGrantRow('', future),
          grant_kind: 'shared',
          user_id: null,
          context_id: 'ctx-A',
          bootstrapped_by_user_id: 'user-1',
        },
      ],
      rowCount: 1,
    })
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'gdrive', userId: 'user-2', contextId: 'ctx-A' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBe('GDRIVE-ACCESS')
  })

  it('400 invalid_request for a malformed (non-k8s) server name, before any getResource', async () => {
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${controlToken()}`)
      .send({ mcpServerName: 'Foo/Bar', userId: 'user-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  // Finding R1-H1: the broker is gated behind a kill-switch that defaults OFF,
  // so it cannot serve provider tokens in production until the U4 mcp-host
  // runtime lands. When disabled, a fully well-formed AND authorized request —
  // valid control JWT, correct scope, seeded server, a grant row that would
  // otherwise resolve to a 200 token — must observe 404 not_found (the endpoint
  // looks absent), and grant resolution must never run (no oauth_grants query).
  describe('kill-switch (mcpOauthBrokerEnabled)', () => {
    it('OFF (default): a well-formed authorized request returns 404 not_found and never resolves a grant', async () => {
      config.mcpOauthBrokerEnabled = false
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
      // A grant that WOULD resolve to a 200 token if the endpoint served — so
      // the 404 can only come from the gate, not from a missing grant.
      const future = new Date(Date.now() + 3600_000)
      mockPoolQuery.mockResolvedValueOnce({
        rows: [nonExpiredUserGrantRow('user-1', future)],
        rowCount: 1,
      })

      const res = await request(app)
        .post('/api/v1/mcp-oauth/user-token')
        .set('Authorization', `Bearer ${controlToken()}`)
        .send({ mcpServerName: 'gdrive', userId: 'user-1', contextId: 'ctx-9' })

      // Load-bearing (T4): assert the observable HTTP response, not an internal
      // call count. This assertion fails against the pre-gate parent (which
      // always serves → 200 with the seeded grant).
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('not_found')
      expect(res.body.token).toBeUndefined()
      // Never reached grant resolution — no oauth_grants lookup ran.
      const grantQuery = mockPoolQuery.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
      )
      expect(grantQuery).toBeUndefined()
    })

    it('ON: the same request resolves normally (behavior unchanged)', async () => {
      config.mcpOauthBrokerEnabled = true
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
      const future = new Date(Date.now() + 3600_000)
      mockPoolQuery.mockResolvedValueOnce({
        rows: [nonExpiredUserGrantRow('user-1', future)],
        rowCount: 1,
      })

      const res = await request(app)
        .post('/api/v1/mcp-oauth/user-token')
        .set('Authorization', `Bearer ${controlToken()}`)
        .send({ mcpServerName: 'gdrive', userId: 'user-1', contextId: 'ctx-9' })

      expect(res.status).toBe(200)
      expect(res.body.token).toBe('GDRIVE-ACCESS')
      expect(res.body.expiresAt).toBe(future.toISOString())
    })
  })
})

// Hot-revocation poll-sweep endpoint (mini-spec 13 §4.1). Gate + validation +
// fail-open behaviors are asserted here at the HTTP layer; the AUTHORITATIVE
// T1 derivation of `exists` from the real store producers lives in
// routes.mcpOauth.grantsExists.realPostgres.integration.test.ts.
describe('routes/mcp-oauth — POST /mcp-oauth/grants/exists (mini-spec 13)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    // Default: SELECT 1 finds no row → oauthGrantExists = false (no grant).
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  const post = (token: string | null, body: unknown) => {
    const req = request(app).post('/api/v1/mcp-oauth/grants/exists')
    if (token) req.set('Authorization', `Bearer ${token}`)
    return req.send(body as object)
  }

  it('401 without a control JWT (same gate as user-token)', async () => {
    const res = await post(null, { queries: [{ mcpServerName: 'gdrive', userId: 'u1' }] })
    expect(res.status).toBe(401)
  })

  // Case (d): the SAME scope as user-token (oauth:user-token) — no new scope.
  it('403 insufficient_scope with a valid control JWT that lacks oauth:user-token', async () => {
    const res = await post(controlToken([]), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('insufficient_scope')
  })

  it('400 invalid_request when queries is not an array', async () => {
    const res = await post(controlToken(), { queries: 'nope' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('400 batch_too_large when queries exceeds the cap', async () => {
    const queries = Array.from({ length: 1001 }, (_, i) => ({
      mcpServerName: `srv-${i}`,
      userId: 'u1',
    }))
    const res = await post(controlToken(), { queries })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('batch_too_large')
  })

  // Fail-open (§4.2): an unknown server (getResource 404) and a non-oauth server
  // are ambiguous/transient — never a spurious `exists:false` that would evict.
  it('200: unknown and non-oauth servers fail OPEN (exists:true), keyed by name', async () => {
    void gateway.createResource(
      'mcpservers',
      { metadata: { name: 'plain' }, spec: { auth: { type: 'none' } } },
      MCP_NS
    )
    const res = await post(controlToken(), {
      queries: [
        { mcpServerName: 'ghost', userId: 'u1' },
        { mcpServerName: 'plain', userId: 'u1' },
      ],
    })
    expect(res.status).toBe(200)
    // Each result echoes the query's coordinates (correlation by tuple).
    expect(res.body.results).toEqual([
      { mcpServerName: 'ghost', userId: 'u1', exists: true },
      { mcpServerName: 'plain', userId: 'u1', exists: true },
    ])
    // Fail-open cases never touch the grants table.
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
    )
    expect(grantQuery).toBeUndefined()
  })

  // A definitive `exists:false` only when oauthGrantExists says so (SELECT 1
  // returns 0 rows), and the lookup is keyed by (mcpserver owner, userId).
  it('200: a per-user server with no grant reports exists:false (definitive), keyed by userId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'nobody' }],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive', userId: 'nobody', exists: false }])
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM oauth_grants') &&
        sql.includes("grant_kind = 'user'")
    )
    expect(grantQuery?.[1]).toEqual(['mcpserver', MCP_NS, 'gdrive', 'nobody', 'google-drive'])
  })

  it('200: reports exists:true when the SELECT 1 finds a row', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 })
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive', userId: 'u1', exists: true }])
  })

  // FIX A core: two per-user partitions of the SAME server (different userId)
  // must be distinguishable in ONE batch response — correlation by (server,
  // userId) tuple, not by array position. alice has a grant, bob does not.
  it('200: distinguishes two userIds on the same server within one batch', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    // First SELECT 1 (alice) finds a row; the default empty result covers bob.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 })
    const res = await post(controlToken(), {
      queries: [
        { mcpServerName: 'gdrive', userId: 'alice' },
        { mcpServerName: 'gdrive', userId: 'bob' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { mcpServerName: 'gdrive', userId: 'alice', exists: true },
      { mcpServerName: 'gdrive', userId: 'bob', exists: false },
    ])
  })

  // Context flavor: keyed by the server's AUTHORITATIVE spec.contextRef, NEVER
  // the body contextId (no body-trust). The SELECT 1 coordinate proves it; the
  // lying body contextId is only echoed back, never used to key.
  it('200: context server keys the lookup by spec.contextRef, ignoring a lying body contextId', async () => {
    seedOauthServer(gateway, { name: 'team', grantScope: 'context', contextRef: 'ctx-real' })
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'team', userId: 'u1', contextId: 'ctx-foreign' }],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { mcpServerName: 'team', userId: 'u1', contextId: 'ctx-foreign', exists: false },
    ])
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM oauth_grants') &&
        sql.includes("grant_kind = 'shared'")
    )
    // contextId coordinate is the authoritative ctx-real, NOT the body ctx-foreign.
    expect(grantQuery?.[1]).toEqual(['mcpserver', MCP_NS, 'team', 'ctx-real', 'google-drive'])
  })

  // FIX A: a malformed entry must NOT be dropped (that breaks positional/tuple
  // correlation) — it yields a fail-open placeholder in its OWN slot, echoing
  // whatever coordinates it carried. results stays 1:1 with queries.
  it('200: keeps results 1:1 with queries, fail-open placeholder for malformed entries', async () => {
    const queries = [
      { mcpServerName: 'Foo/Bar', userId: 'u1' }, // invalid k8s name → placeholder, name echoed as-is
      { mcpServerName: 'ghost', userId: 'u2' }, // unknown server → fail-open true
      { userId: 'u3' }, // no mcpServerName → placeholder, name echoes ''
    ]
    const res = await post(controlToken(), { queries })
    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(queries.length)
    expect(res.body.results).toEqual([
      { mcpServerName: 'Foo/Bar', userId: 'u1', exists: true },
      { mcpServerName: 'ghost', userId: 'u2', exists: true },
      { mcpServerName: '', userId: 'u3', exists: true },
    ])
  })

  // FIX B: the endpoint mirrors user-token's rate limiter (same mcp_oauth_broker
  // bucket, keyed by caller). When the bucket is exhausted the middleware short-
  // circuits with 429 BEFORE the handler runs (no grant lookup).
  it('429 Too Many Requests when the shared broker rate limit is exceeded', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    vi.mocked(checkAndIncrement).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 61,
    })
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('Too Many Requests')
    // Denied before the handler — no grants lookup ran.
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
    )
    expect(grantQuery).toBeUndefined()
  })

  // Kill-switch parity with user-token: OFF (default) → the endpoint looks absent.
  it('404 not_found when the broker kill-switch is OFF', async () => {
    config.mcpOauthBrokerEnabled = false
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })
})
