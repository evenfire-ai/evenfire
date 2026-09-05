import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { MockGateway } from './mockGateway.js'

/**
 * U4 (spec 11) — internal endpoint that REVOKES an OAuth mcp-server grant from
 * the desktop panel. rpc-proxy is the sole authorized caller
 * (requireInternalService('rpc-proxy')); the `userId` is forwarded over that
 * seam (rpc-proxy derives it from the session auth.sub). The grant coordinate
 * (oauthClientId + grantScope + Context) comes from the McpServer CR, never the
 * body.
 *
 * Authorization BY FLAVOR (the security invariant, §2.3):
 *   - `user`    → the key is built on the forwarded userId, so a cross-user
 *     delete is structurally impossible.
 *   - `context` → membership in the server's Context is required (getUserContexts),
 *     and a non-member is rejected 403 with NO delete.
 *
 * These tests mock `pool.query` (SQL-shape assertions). The end-to-end delete
 * against real grant rows built by the real producers is the sibling
 * realPostgres integration test (T1/T4).
 *
 * T3: at the parent sha (5d9b22902) the route does not exist → Express answers
 * 404, so both the 204 (delete) and 403 (authz) assertions fail there.
 */

// Internal service tokens are the repo-wide dev fixtures (see the sibling
// routes.internal.* tests). Kept in constants and interpolated so the public
// boundary scanner never sees a materialized token literal after `Bearer`.
const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'
const EXTERNAL_REST_TOKEN = 'dev-external-rest-api-token'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

// The route carries the repo's custom `rateLimitMiddleware`. Mock its real store
// (`checkAndIncrement`, Postgres-backed) to always allow so the many same-userId
// requests here don't trip a real bucket; the "429 when denied" case below
// drives a one-shot deny to prove the limiter is mounted.
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
const URL = '/api/v1/internal/mcp-oauth/grant'

function seedOauthServer(
  gateway: MockGateway,
  opts: { name: string; grantScope?: 'user' | 'context'; contextRef?: string }
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
          ...(opts.grantScope ? { grantScope: opts.grantScope } : {}),
        },
      },
    },
    MCP_NS
  )
}

/**
 * Route pool.query by SQL: membership lookups (getUserContexts) return the
 * supplied contexts; the grant DELETE returns `rowCount`. Anything else is an
 * empty result. Records the DELETE call so tests can assert the flavored key.
 */
function mockDb(opts: { memberContexts: string[]; deleteRowCount?: number }): void {
  mockPoolQuery.mockImplementation((sql: unknown) => {
    const text = typeof sql === 'string' ? sql : ''
    if (text.includes('FROM user_contexts')) {
      return Promise.resolve({
        rows: opts.memberContexts.map(context_id => ({ context_id })),
        rowCount: opts.memberContexts.length,
      })
    }
    if (text.includes('DELETE FROM oauth_grants')) {
      return Promise.resolve({ rows: [], rowCount: opts.deleteRowCount ?? 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
}

function deleteCalls(): Array<[string, unknown[]]> {
  return mockPoolQuery.mock.calls
    .filter(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM oauth_grants'))
    .map(([sql, params]) => [sql as string, (params ?? []) as unknown[]])
}

function del(app: ReturnType<typeof createApp>) {
  return request(app)
    .delete(URL)
    .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
    .set('x-service-token', 'rpc-proxy')
}

describe('DELETE /api/v1/internal/mcp-oauth/grant (spec 11 U4)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('401 without any service token', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    const res = await request(app).delete(URL).send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('401 for an authenticated NON-rpc-proxy service (external-rest-api)', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    const res = await request(app)
      .delete(URL)
      .set('Authorization', `Bearer ${EXTERNAL_REST_TOKEN}`)
      .set('x-service-token', 'external-rest-api')
      .send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('400 invalid_request when userId is absent', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    const res = await del(app).send({ mcpServerName: 'gdrive' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
    expect(deleteCalls()).toHaveLength(0)
  })

  it('400 invalid_request for a malformed (non-k8s) server name', async () => {
    const res = await del(app).send({ mcpServerName: 'Foo_Bar', userId: 'user-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('404 server_not_found for an unknown server', async () => {
    const res = await del(app).send({ mcpServerName: 'ghost', userId: 'user-1' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('server_not_found')
  })

  it('400 not_oauth_server for a non-oauth server', async () => {
    void gateway.createResource(
      'mcpservers',
      { metadata: { name: 'plain' }, spec: { contextRef: 'ctx-9', auth: { type: 'none' } } },
      MCP_NS
    )
    const res = await del(app).send({ mcpServerName: 'plain', userId: 'user-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('not_oauth_server')
    expect(deleteCalls()).toHaveLength(0)
  })

  // ── user flavor ──────────────────────────────────────────────────────────

  it('user flavor: a MEMBER revokes → 204 and deletes the (user, own-userId) grant', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    mockDb({ memberContexts: ['ctx-9'] })
    const res = await del(app).send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(204)

    const calls = deleteCalls()
    expect(calls).toHaveLength(1)
    const [sql, params] = calls[0]
    // user-flavor delete: owner_kind='mcpserver', grant_kind='user', keyed on
    // the forwarded userId — a cross-user delete is structurally impossible.
    expect(sql).toContain("grant_kind = 'user'")
    // params order: [ownerKind, ns, serverName, userId, oauthClientId]
    expect(params).toEqual(['mcpserver', MCP_NS, 'gdrive', 'user-7', 'google-drive'])
  })

  it('user flavor: a NON-member is rejected 403 and NOTHING is deleted', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    // user-8 belongs to other contexts, but NOT ctx-9.
    mockDb({ memberContexts: ['ctx-other'] })
    const res = await del(app).send({ mcpServerName: 'gdrive', userId: 'user-8' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
    expect(deleteCalls()).toHaveLength(0)
  })

  it('user flavor: idempotent — revoking an absent grant still returns 204', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    mockDb({ memberContexts: ['ctx-9'], deleteRowCount: 0 })
    const res = await del(app).send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(204)
    expect(deleteCalls()).toHaveLength(1)
  })

  // ── context flavor ───────────────────────────────────────────────────────

  it('context flavor: a MEMBER revokes → 204 and deletes the single (shared, contextRef) grant', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    mockDb({ memberContexts: ['ctx-A'] })
    const res = await del(app).send({ mcpServerName: 'gdrive', userId: 'user-2' })
    expect(res.status).toBe(204)

    const calls = deleteCalls()
    expect(calls).toHaveLength(1)
    const [sql, params] = calls[0]
    // context-flavor delete: shared grant keyed by the server's AUTHORITATIVE
    // contextRef (ctx-A), user_id NULL — decoupled from the caller's userId.
    expect(sql).toContain("grant_kind = 'shared'")
    // params order: [ownerKind, ns, serverName, contextId, oauthClientId]
    expect(params).toEqual(['mcpserver', MCP_NS, 'gdrive', 'ctx-A', 'google-drive'])
    // The caller's userId is NEVER part of the shared delete key.
    expect(params).not.toContain('user-2')
  })

  it('context flavor: a NON-member is rejected 403 and NOTHING is deleted', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    mockDb({ memberContexts: ['ctx-other', 'ctx-else'] })
    const res = await del(app).send({ mcpServerName: 'gdrive', userId: 'user-nomember' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('context_membership_denied')
    expect(deleteCalls()).toHaveLength(0)
  })

  it('context flavor: a cross-context body contextId is rejected 400 context_mismatch, before any delete', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    mockDb({ memberContexts: ['ctx-A'] })
    const res = await del(app).send({
      mcpServerName: 'gdrive',
      userId: 'user-2',
      contextId: 'ctx-B',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('context_mismatch')
    expect(deleteCalls()).toHaveLength(0)
  })

  // Rate-limited: an exhausted bucket short-circuits with 429 BEFORE the handler
  // runs — no server read, no grant delete.
  it('429 Too Many Requests when the rate limit is exceeded', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    vi.mocked(checkAndIncrement).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 61,
    })
    const res = await del(app).send({ mcpServerName: 'gdrive', userId: 'user-1' })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('Too Many Requests')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})
