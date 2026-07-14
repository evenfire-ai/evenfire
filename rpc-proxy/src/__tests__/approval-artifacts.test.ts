import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../config.js'
import { createRpcRouter } from '../routes/rpc.js'

// ── Hoisted mocks ───────────────────────────────────────────────────
const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  listAllowedServersForUser: vi.fn(),
  resolveServerConnectionForUser: vi.fn(),
  resolveHostConnectionForUser: vi.fn(),
  validateRpcRequest: vi.fn(),
  forwardRpcToServer: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  forwardHostActivity: vi.fn(),
  forwardHostStatus: vi.fn(),
  forwardHostHealth: vi.fn(),
  forwardTaskResultFromHost: vi.fn(),
  forwardCancelToHost: vi.fn(),
  // Re-exported by mcpProxyService for the host-status stream's
  // consecutive-401 detection. The createRpcRouter under test transitively
  // wires that route, so vi.mock must mirror this export or the router
  // fails to load with "no UpstreamHostError export defined".
  UpstreamHostError: class UpstreamHostError extends Error {
    constructor(
      public readonly status: number,
      public readonly bodySnippet: string
    ) {
      super(`Upstream host returned ${status}: ${bodySnippet}`)
      this.name = 'UpstreamHostError'
    }
  },
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

// ── Helpers ─────────────────────────────────────────────────────────
const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:approval:write', 'host:activity:read', 'host:task:read'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-123',
  },
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  // Generic error handler to avoid unhandled rejections in tests
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
    }
  )
  return app
}

/** Create a minimal fetch Response mock. */
function mockFetchResponse(
  status: number,
  body: string,
  headers?: Record<string, string>
): Response {
  const headersObj = new Headers(headers)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersObj,
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(Buffer.from(body).buffer as ArrayBuffer),
  } as unknown as Response
}

// ── Setup / Teardown ────────────────────────────────────────────────
const originalFetch = globalThis.fetch
const originalArtifactDownloadMaxBytes = config.artifactDownloadMaxBytes

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReset()
  Object.values(serviceMock).forEach(m => {
    // Skip non-mock entries (e.g. UpstreamHostError class re-exported for
    // module-load parity — has no mockReset method).
    if (typeof (m as { mockReset?: unknown }).mockReset === 'function') {
      ;(m as { mockReset: () => void }).mockReset()
    }
  })

  // Default: auth passes, host resolves
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  config.artifactDownloadMaxBytes = originalArtifactDownloadMaxBytes
})

// =====================================================================
// Approval Routes
// =====================================================================
describe('POST /rpc/hosts/:hostRef/approvals/approve', () => {
  it('translates toolCallId to requestId in upstream body', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-42', alwaysApprove: true })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.requestId).toBe('tc-42')
    expect(parsed).not.toHaveProperty('toolCallId')
  })

  it('sets userId to auth.sub', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.userId).toBe(VALID_CLAIMS.sub)
  })

  it('forwards alwaysApprove from request body', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1', alwaysApprove: true })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.alwaysApprove).toBe(true)
  })

  it('defaults alwaysApprove to false when not provided', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.alwaysApprove).toBe(false)
  })

  it('calls upstream /v1/runtime/approvals/approve', async () => {
    let capturedUrl: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(200)

    expect(capturedUrl).toBe(
      'http://chatllm.mcp-host.svc.cluster.local:8080/v1/runtime/approvals/approve'
    )
  })

  it('returns 403 when host is not accessible', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(403)
  })

  it('rejects without host:approval:write scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:activity:read'], // missing host:approval:write
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(403)
  })

  it('accepts requestId directly (backwards compat)', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ requestId: 'req-99' })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.requestId).toBe('req-99')
  })
})

describe('POST /rpc/hosts/:hostRef/approvals/deny', () => {
  it('translates toolCallId to requestId in upstream body', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-deny-7' })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.requestId).toBe('tc-deny-7')
    expect(parsed).not.toHaveProperty('toolCallId')
  })

  it('sets userId to auth.sub', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed.userId).toBe(VALID_CLAIMS.sub)
  })

  it('does NOT include alwaysApprove in deny body', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1', alwaysApprove: true })
      .expect(200)

    const parsed = JSON.parse(capturedBody!)
    expect(parsed).not.toHaveProperty('alwaysApprove')
  })

  it('calls upstream /v1/runtime/approvals/deny', async () => {
    let capturedUrl: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url
      return mockFetchResponse(200, JSON.stringify({ ok: true }))
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(200)

    expect(capturedUrl).toBe(
      'http://chatllm.mcp-host.svc.cluster.local:8080/v1/runtime/approvals/deny'
    )
  })

  it('returns 403 when host is not accessible', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(403)
  })

  it('rejects without host:approval:write scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:activity:read'],
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1' })
      .expect(403)
  })
})

// =====================================================================
// Artifact Routes
// =====================================================================
describe('GET /rpc/hosts/:hostRef/artifacts', () => {
  it('forwards to mcp-host /v1/runtime/artifacts and returns JSON', async () => {
    const artifacts = [
      { filename: 'report.pdf', size: 12345, createdAt: '2026-03-27T10:00:00Z' },
      { filename: 'data.xlsx', size: 8765, createdAt: '2026-03-27T10:01:00Z' },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(200, JSON.stringify(artifacts)))

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(JSON.parse(res.text)).toEqual(artifacts)
  })

  it('calls the correct upstream URL', async () => {
    let capturedUrl: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url
      return mockFetchResponse(200, '[]')
    })

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(capturedUrl).toBe('http://chatllm.mcp-host.svc.cluster.local:8080/v1/runtime/artifacts')
  })

  it('passes host headers to upstream', async () => {
    let capturedHeaders: Record<string, string> | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return mockFetchResponse(200, '[]')
    })

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(capturedHeaders).toMatchObject(HOST_CONNECTION.headers)
  })

  it('returns 403 when host is not accessible', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('rejects invalid hostRef before resolving host access', async () => {
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chat_llm/artifacts')
      .set('authorization', 'Bearer token')
      .expect(400)

    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('rejects without host:task:read scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:activity:read'], // missing host:task:read
    })

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('propagates upstream error status', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(500, JSON.stringify({ error: 'internal' })))

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer token')
      .expect(500)

    expect(JSON.parse(res.text)).toEqual({ error: 'internal' })
  })
})

// =====================================================================
// Cancel Route
// =====================================================================
describe('POST /rpc/hosts/:hostRef/tasks/:taskId/cancel', () => {
  it('forwards to mcp-host and returns 204 on success', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    serviceMock.forwardCancelToHost.mockResolvedValue({
      status: 204,
      body: '',
      contentType: null,
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/tasks/abc/cancel')
      .set('authorization', 'Bearer token')
      .expect(204)

    expect(serviceMock.forwardCancelToHost).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'chatllm' }),
      'abc',
      VALID_CLAIMS.sub
    )
  })

  it('forwards auth.sub when no userId is present in the request body', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    serviceMock.forwardCancelToHost.mockResolvedValue({
      status: 204,
      body: '',
      contentType: null,
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/tasks/abc/cancel')
      .set('authorization', 'Bearer token')
      .expect(204)

    const [, , userId] = serviceMock.forwardCancelToHost.mock.calls[0]
    expect(userId).toBe(VALID_CLAIMS.sub)
  })

  it('ignores explicit userId from request body', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    serviceMock.forwardCancelToHost.mockResolvedValue({
      status: 204,
      body: '',
      contentType: null,
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/tasks/abc/cancel')
      .set('authorization', 'Bearer token')
      .send({ userId: 'alice' })
      .expect(204)

    const [, , userId] = serviceMock.forwardCancelToHost.mock.calls[0]
    expect(userId).toBe(VALID_CLAIMS.sub)
  })

  it('returns 401 without auth', async () => {
    const app = makeApp()
    await request(app).post('/rpc/hosts/chatllm/tasks/abc/cancel').expect(401)
  })

  it('returns 404 when host is not accessible', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/chatllm/tasks/abc/cancel')
      .set('authorization', 'Bearer token')
      .expect(404)
  })

  it('returns 502 when upstream fetch rejects', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    serviceMock.forwardCancelToHost.mockRejectedValue(new Error('ECONNREFUSED'))

    const app = makeApp()
    const res = await request(app)
      .post('/rpc/hosts/chatllm/tasks/abc/cancel')
      .set('authorization', 'Bearer token')

    expect(res.status).toBe(502)
  })

  it('returns 504 when upstream fetch aborts (timeout)', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    serviceMock.forwardCancelToHost.mockRejectedValue(abortErr)

    const app = makeApp()
    const res = await request(app)
      .post('/rpc/hosts/chatllm/tasks/abc/cancel')
      .set('authorization', 'Bearer token')

    expect(res.status).toBe(504)
  })

  it('propagates upstream 5xx status', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    serviceMock.forwardCancelToHost.mockResolvedValue({
      status: 500,
      body: '{"error":"upstream"}',
      contentType: 'application/json',
    })

    const app = makeApp()
    const res = await request(app)
      .post('/rpc/hosts/chatllm/tasks/abc/cancel')
      .set('authorization', 'Bearer token')

    expect(res.status).toBe(500)
  })
})

describe('GET /rpc/hosts/:hostRef/artifacts/:filename/download', () => {
  it("rejects filename containing '..'", async () => {
    // Express normalizes "../" in paths, so use URL-encoded dots to test
    // the validation logic when the param actually contains ".."
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockFetchResponse(200, 'should-not-reach', { 'content-type': 'text/plain' })
      )

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/..report/download')
      .set('authorization', 'Bearer token')
      .expect(400)

    // fetch should NOT have been called — validation rejects before upstream
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("rejects filename containing '/'", async () => {
    // Express normalizes /, so we test with encoded slash
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/sub%2Ffile.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(400)
  })

  it("rejects filename containing '\\\\' before forwarding", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockFetchResponse(200, 'should-not-reach', { 'content-type': 'text/plain' })
      )

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/sub%5Cfile.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(400)

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects filename containing a null byte', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockFetchResponse(200, 'should-not-reach', { 'content-type': 'text/plain' })
      )

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/bad%00name.md/download')
      .set('authorization', 'Bearer token')
      .expect(400)

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('forwards content-type header from upstream', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(200, 'PDF-CONTENT', {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="report.pdf"',
      })
    )

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts/report.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(res.headers['content-type']).toContain('application/pdf')
  })

  it('reconstructs content-disposition from the requested filename', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(200, 'PDF-CONTENT', {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="evil.pdf"',
      })
    )

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts/my report.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(res.headers['content-disposition']).toBe('attachment; filename="my_report.pdf"')
  })

  it('forwards artifact redaction header from upstream', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(200, 'PDF-CONTENT', {
        'content-type': 'application/pdf',
        'x-clerum-redaction': 'applied',
      })
    )

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts/report.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(res.headers['x-clerum-redaction']).toBe('applied')
  })

  it('calls arrayBuffer on upstream response and sends buffer', async () => {
    const arrayBufferSpy = vi.fn().mockResolvedValue(Buffer.from('pdf-data').buffer)
    const headersObj = new Headers({
      'content-type': 'application/pdf',
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: headersObj,
      text: () => Promise.resolve(''),
      arrayBuffer: arrayBufferSpy,
    } as unknown as Response)

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/notes.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(200)

    // Verify the route consumed the arrayBuffer from the upstream response
    expect(arrayBufferSpy).toHaveBeenCalledOnce()
  })

  it('rejects downloads when upstream content-length exceeds the proxy artifact cap', async () => {
    config.artifactDownloadMaxBytes = 4
    const arrayBufferSpy = vi.fn().mockResolvedValue(Buffer.from('12345').buffer)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/octet-stream',
        'content-length': '5',
      }),
      text: () => Promise.resolve(''),
      arrayBuffer: arrayBufferSpy,
    } as unknown as Response)

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts/huge.bin/download')
      .set('authorization', 'Bearer token')
      .expect(413)

    expect(res.body.error).toMatch(/too large/i)
    expect(arrayBufferSpy).not.toHaveBeenCalled()
  })

  it('rejects downloads that exceed the proxy cap even without content-length', async () => {
    config.artifactDownloadMaxBytes = 4
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(Buffer.from('12345').buffer),
    } as unknown as Response)

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts/huge.bin/download')
      .set('authorization', 'Bearer token')
      .expect(413)

    expect(res.body.error).toMatch(/too large/i)
  })

  it('encodes filename in upstream URL', async () => {
    let capturedUrl: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url
      return mockFetchResponse(200, 'ok', { 'content-type': 'text/plain' })
    })

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/my report.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(capturedUrl).toContain('/v1/runtime/artifacts/my%20report.pdf/download')
  })

  it('returns upstream error status when not ok', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(404, JSON.stringify({ error: 'Not found' })))

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/missing.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(404)
  })

  it('rejects invalid hostRef before forwarding downloads', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(200, 'should-not-reach'))

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chat_llm/artifacts/report.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(400)

    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 403 when host is not accessible', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)

    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/chatllm/artifacts/report.pdf/download')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('defaults content-type to application/octet-stream when absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(200, 'raw-bytes', {}))

    const app = makeApp()
    const res = await request(app)
      .get('/rpc/hosts/chatllm/artifacts/data.bin/download')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(res.headers['content-type']).toContain('application/octet-stream')
  })
})
