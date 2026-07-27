import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import express from 'express'
import request from 'supertest'
import {
  createRpcRouter,
  respondControlApiHostAccessRejection,
  respondUpstreamUnavailable,
} from '../routes/rpc.js'

// ── Issue #791 §11.4/§11.5 — extend wake-and-hold to the remaining finite
// Desktop routes, and prove terminal-response (duplicate-write) safety in the
// route-level outer catches. Wake capability rides on the token; the route
// scope guards are UNCHANGED.

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
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
const controlApiMock = vi.hoisted(() => ({
  fetchUserAllowedServersFromControlApi: vi.fn(),
  fetchHostConnectionFromControlApi: vi.fn(),
  requestHostWakeFromControlApi: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)
vi.mock('../services/controlApiRestService.js', () => controlApiMock)

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
  headers: { 'x-clerum-edge-caller': 'rpc-proxy' },
}

function claims(scopes: string[]) {
  return {
    sub: 'user-uuid-123',
    typ: 'user' as const,
    accessScope: 'team' as const,
    teamId: 'team-1',
    scopes,
    hostRefs: ['chatllm'],
    jti: 'j1',
    iat: 1,
    exp: 9999999999,
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
    }
  )
  return app
}

function mockFetchResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(Buffer.from(body).buffer as ArrayBuffer),
  } as unknown as Response
}

function hostDownError(): Error {
  return new TypeError('fetch failed')
}

function drainingResponse(): Response {
  return mockFetchResponse(503, JSON.stringify({ code: 'host_draining', retryAfterMs: 1000 }), {
    'content-type': 'application/json',
  })
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
  controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'active', wakeGeneration: null })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('§11.4 wake coverage — GET /rpc/hosts/:hostRef/models', () => {
  it('a wake-capable token wakes on host-down and forwards after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce(
        mockFetchResponse(200, JSON.stringify({ models: [] }), { 'content-type': 'application/json' })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/models')
      .set('authorization', 'Bearer tok')
      .expect(200)

    expect(res.body).toEqual({ models: [] })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a NON-wake token gets the deterministic legacy result and triggers NO wake', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read']))
    const fetchMock = vi.fn().mockRejectedValue(hostDownError())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/models')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})

describe('§11.4 wake coverage — POST /rpc/hosts/:hostRef/model', () => {
  it('wakes on host-down and forwards after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:model:write', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce(mockFetchResponse(200, JSON.stringify({ effective: 'next-task' })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/model')
      .set('authorization', 'Bearer tok')
      .send({ chatId: 'c1', model: 'claude-haiku-4-5' })
      .expect(200)

    expect(res.body).toEqual({ effective: 'next-task' })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
  })
})

describe('§11.4 wake coverage — context-breakdown honors the draining fence', () => {
  it('a 503 host_draining triggers a wake and re-forwards after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(drainingResponse())
      .mockResolvedValueOnce(
        mockFetchResponse(200, JSON.stringify({ breakdown: {} }), {
          'content-type': 'application/json',
        })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/context-breakdown')
      .set('authorization', 'Bearer tok')
      .expect(200)

    expect(res.body).toEqual({ breakdown: {} })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
  })

  it('a plain upstream 404 is NOT treated as a wake trigger (passes through)', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read', 'host:wake:write']))
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockFetchResponse(404, JSON.stringify({ error: 'session not found' }), {
          'content-type': 'application/json',
        })
      ) as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/missing/context-breakdown')
      .set('authorization', 'Bearer tok')
      .expect(404)

    expect(res.body).toEqual({ error: 'session not found' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})

describe('§11.4 wake coverage — approvals approve', () => {
  it('wakes on host-down and forwards after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:approval:write', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce(mockFetchResponse(200, JSON.stringify({ ok: true })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer tok')
      .send({ toolCallId: 'tc-1' })
      .expect(200)

    // The approve route relays the upstream body verbatim as a raw string
    // (no JSON content-type is set), so read it via res.text.
    expect(JSON.parse(res.text)).toEqual({ ok: true })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
  })
})

describe('§11.4 wake coverage — artifacts list and download', () => {
  it('artifacts list wakes on host-down and forwards after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:task:read', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce(mockFetchResponse(200, JSON.stringify([{ filename: 'a.pdf' }])))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer tok')
      .expect(200)

    expect(JSON.parse(res.text)).toEqual([{ filename: 'a.pdf' }])
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
  })

  it('artifact download wakes on host-down and streams after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:task:read', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce(
        mockFetchResponse(200, 'PDF-BYTES', { 'content-type': 'application/pdf' })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/artifacts/report.pdf/download')
      .set('authorization', 'Bearer tok')
      .expect(200)

    expect(res.headers['content-type']).toContain('application/pdf')
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
  })
})

// ── §13.4 row 1 — GET /rpc/hosts/:hostRef/sessions/:agent/:chatId/messages ──
// sessions-passthrough.test.ts already proves the "wake accepted, host still
// down → host_waking" variant for this transcript route; the "retry after
// readiness → operation result" cell (§13.4 row 1 proper) is proven here.
describe('§13.4 row 1 — session transcript wakes on host-down and re-forwards after active', () => {
  it('a wake-capable token wakes then re-forwards the transcript after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce(
        mockFetchResponse(200, JSON.stringify({ agent: 'chatllm', chatId: 'c1', turns: [] }), {
          'content-type': 'application/json',
        })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/messages')
      .set('authorization', 'Bearer tok')
      .expect(200)

    expect(res.body).toEqual({ agent: 'chatllm', chatId: 'c1', turns: [] })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ── §11.4 wake coverage — approvals/deny (row 1) ────────────────────────────
// Closes the audit gap: POST approvals/deny had no route-level wake test at
// all. Mirrors the approve row-1 test above; the route stays host:approval:write
// and relays the upstream body verbatim as a raw string.
describe('§11.4 wake coverage — approvals deny', () => {
  it('wakes on host-down and forwards after active', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:approval:write', 'host:wake:write']))
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce(mockFetchResponse(200, JSON.stringify({ ok: true })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer tok')
      .send({ toolCallId: 'tc-1' })
      .expect(200)

    expect(JSON.parse(res.text)).toEqual({ ok: true })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'tok')
  })
})

// ── §13.4 row 3 — GET /rpc/hosts/:hostRef/tasks/:taskId/result ──────────────
// The other finite routes assert their plain-forward path in their own suites
// (model-selection, approval-artifacts, sessions-passthrough). The task-result
// route only had the wake path, so its active/ready row is proven here: even a
// wake-capable token never touches the wake plane when the host is up.
describe('§13.4 row 3 — task result forwards normally on an active host', () => {
  it('an active host forwards the task result and never touches the wake plane', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(
      claims(['host:message:invoke', 'host:wake:write'])
    )
    serviceMock.forwardTaskResultFromHost.mockResolvedValue({
      status: 'completed',
      response: 'done',
    })

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/tasks/t-7/result')
      .set('authorization', 'Bearer tok')
      .expect(200)

    expect(res.body).toEqual({ status: 'completed', response: 'done' })
    expect(serviceMock.forwardTaskResultFromHost).toHaveBeenCalledTimes(1)
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})

// ── §13.4 row 2 — suspended host + NON-wake token ───────────────────────────
// A finite operation whose token lacks host:wake:write must return today's
// deterministic legacy availability result (502 Upstream host unavailable) and
// NEVER consult the wake plane — no fallback grant is minted (§11.2, §13.4).
// GET /models already asserts this cell above; the remaining finite routes are
// proven here so every wake-eligible route has an explicit non-wake row.
describe('§13.4 row 2 — NON-wake token gets the deterministic legacy result and triggers NO wake', () => {
  it('POST messages', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:message:invoke']))
    serviceMock.forwardHostMessageToHost.mockRejectedValue(hostDownError())

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer tok')
      .send({ content: 'hello' })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('POST approvals/approve', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:approval:write']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer tok')
      .send({ toolCallId: 'tc-1' })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('POST approvals/deny', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:approval:write']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer tok')
      .send({ toolCallId: 'tc-1' })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('GET sessions', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('GET sessions/:agent/:chatId/messages (transcript)', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/messages')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('GET sessions/:agent/:chatId/context-breakdown', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:session:read']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/chatllm/c1/context-breakdown')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('POST model', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:model:write']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/model')
      .set('authorization', 'Bearer tok')
      .send({ chatId: 'c1', model: 'claude-haiku-4-5' })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('GET tasks/:taskId/result', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:message:invoke']))
    serviceMock.forwardTaskResultFromHost.mockRejectedValue(hostDownError())

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/tasks/t-1/result')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('POST tasks/:taskId/cancel', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:message:invoke']))
    serviceMock.forwardCancelToHost.mockRejectedValue(hostDownError())

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/tasks/t-1/cancel')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('GET artifacts', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:task:read']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('GET artifacts/:filename/download', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['host:task:read']))
    globalThis.fetch = vi.fn().mockRejectedValue(hostDownError()) as unknown as typeof fetch

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/artifacts/report.pdf/download')
      .set('authorization', 'Bearer tok')
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})

// ── §11.5 terminal-response (duplicate-write) safety ────────────────────────
describe('§11.5 route outer-catch responders guard headersSent (one-shot settlement)', () => {
  type FakeRes = {
    headersSent: boolean
    statusCode: number
    body: unknown
    status: (code: number) => FakeRes
    json: (payload: unknown) => FakeRes
  }
  function makeRes(headersSent = false): FakeRes {
    const res: FakeRes = {
      headersSent,
      statusCode: 0,
      body: undefined,
      status(code: number) {
        res.statusCode = code
        return res
      },
      json(payload: unknown) {
        if (res.headersSent) throw new Error('Cannot set headers after they are sent to the client')
        res.headersSent = true
        res.body = payload
        return res
      },
    }
    return res
  }

  it('respondUpstreamUnavailable is a no-op once the response is committed', () => {
    const res = makeRes(true)
    expect(() =>
      respondUpstreamUnavailable(res as unknown as ExpressResponse, new Error('boom'))
    ).not.toThrow()
    expect(res.statusCode).toBe(0)
  })

  it('respondUpstreamUnavailable still writes 502 when the response is uncommitted', () => {
    const res = makeRes(false)
    respondUpstreamUnavailable(res as unknown as ExpressResponse, new Error('boom'))
    expect(res.statusCode).toBe(502)
    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
  })

  it('respondControlApiHostAccessRejection is a no-op once the response is committed', () => {
    const res = makeRes(true)
    expect(() =>
      respondControlApiHostAccessRejection(res as unknown as ExpressResponse, 403)
    ).not.toThrow()
    expect(res.statusCode).toBe(0)
  })
})
