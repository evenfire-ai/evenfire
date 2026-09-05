import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { rootLogger } from '../src/observability/logger.js'
import { MockGateway } from './mockGateway.js'

/**
 * R1-M1 — the revocation audit log must name the acting principal and record
 * whether a row was actually deleted. At the parent sha the
 * `mcp_oauth_grant_revoked` log carries neither `userId` nor `deleted`, and is
 * emitted even on a 0-row no-op with no way to tell. This test spies the
 * per-request child logger (`rootLogger.child`, the source of `req.log`) and
 * asserts the audit payload.
 */

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'
const MCP_NS = config.mcpServersNamespace
const URL = '/api/v1/internal/mcp-oauth/grant'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

// The route carries the repo's custom `rateLimitMiddleware`; mock its store to
// always allow so the audit assertions here never race a real bucket.
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

// Capture every `req.log.info(...)` call. `req.log` is `rootLogger.child(...)`,
// created per request AT RUNTIME — so a runtime spy on `rootLogger.child`
// intercepts it without disturbing the import-time module children.
const infoSpy = vi.fn()
const fakeChild = {
  info: infoSpy,
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child() {
    return fakeChild
  },
}

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

function mockDb(opts: { memberContexts: string[]; deleteRowCount: number }): void {
  mockPoolQuery.mockImplementation((sql: unknown) => {
    const text = typeof sql === 'string' ? sql : ''
    if (text.includes('FROM user_contexts')) {
      return Promise.resolve({
        rows: opts.memberContexts.map(context_id => ({ context_id })),
        rowCount: opts.memberContexts.length,
      })
    }
    if (text.includes('DELETE FROM oauth_grants')) {
      return Promise.resolve({ rows: [], rowCount: opts.deleteRowCount })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
}

function revokeAuditPayload(): Record<string, unknown> | undefined {
  const call = infoSpy.mock.calls.find(
    ([obj]) =>
      obj &&
      typeof obj === 'object' &&
      (obj as { event?: unknown }).event === 'mcp_oauth_grant_revoked'
  )
  return call?.[0] as Record<string, unknown> | undefined
}

function del(app: ReturnType<typeof createApp>) {
  return request(app)
    .delete(URL)
    .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
    .set('x-service-token', 'rpc-proxy')
}

describe('DELETE /internal/mcp-oauth/grant — revocation audit (R1-M1)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let childSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    infoSpy.mockReset()
    childSpy = vi.spyOn(rootLogger, 'child').mockReturnValue(fakeChild as never)
  })

  afterEach(() => {
    childSpy.mockRestore()
  })

  it('logs userId + contextRef + deleted:false on a 0-row (idempotent) revoke', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    mockDb({ memberContexts: ['ctx-9'], deleteRowCount: 0 })

    const res = await del(app).send({ mcpServerName: 'gdrive', userId: 'user-7' })
    expect(res.status).toBe(204)

    const payload = revokeAuditPayload()
    expect(payload).toBeDefined()
    expect(payload).toMatchObject({
      event: 'mcp_oauth_grant_revoked',
      userId: 'user-7',
      contextRef: 'ctx-9',
      deleted: false,
    })
  })

  it('records deleted:true when a row was actually removed', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user', contextRef: 'ctx-9' })
    mockDb({ memberContexts: ['ctx-9'], deleteRowCount: 1 })

    await del(app).send({ mcpServerName: 'gdrive', userId: 'user-7' })

    expect(revokeAuditPayload()).toMatchObject({ userId: 'user-7', deleted: true })
  })
})
