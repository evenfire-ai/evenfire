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
      .set('Authorization', 'Bearer dev-external-rest-api-token')
      .set('x-service-token', 'external-rest-api')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(401)
  })

  it('mints an authorize-URL whose signed state binds the forwarded userId + the SERVER oauthClientId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
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

  it('context server: accepts a matching body contextId and mints the URL', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-2', contextId: 'ctx-A' })
    expect(res.status).toBe(200)
    expect(res.body.authorizeUrl).toContain('https://accounts.google.com/')
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
    const res = await post(app)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('integration_not_configured')
  })
})
