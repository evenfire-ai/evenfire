import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
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
