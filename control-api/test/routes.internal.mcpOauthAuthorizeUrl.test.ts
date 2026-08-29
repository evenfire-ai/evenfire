import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { verifyOAuthStateSignature } from '../src/oauth/state.js'
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
    // Membership check runs for EVERY scope: user-7 is a member of the server's
    // Context (default contextRef ctx-9).
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

  // Security fix: the per-user flavor ALSO runs the membership gate now — a
  // user-scope server still lives in a Context, and connect shares the invoke
  // scope. A MEMBER mints fine.
  it('user flavor: a MEMBER of the server Context mints OK', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
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
    // Member of ctx-9 so we reach the Secret read (past the membership gate).
    mockPoolQuery.mockResolvedValue({ rows: [{ context_id: 'ctx-9' }], rowCount: 1 })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('integration_not_configured')
  })
})
