import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../app.js'
import { createRpcRouter } from '../routes/rpc.js'

// Issue #1043 — the model-step continuation write path and the session-read
// field it pairs with. rpc-proxy adds no protocol state: it forwards the
// `{version}` body, the edge identity headers and mcp-host's own status/body.

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:message:invoke', 'host:session:read'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

// Edge identity headers are the trust boundary: mcp-host's runtimeEdgeGuard
// trusts x-clerum-edge-user-id (set by the proxy) and rejects any client
// Authorization. resolveHostConnectionForUser is what injects these; the route
// forwards ONLY host.headers, never the inbound Authorization.
const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-123',
  },
}

const CHECKPOINT_ID = 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1'
const CONTINUE_PATH = `/rpc/hosts/chatllm/sessions/chatllm/c1/model-step-checkpoints/${CHECKPOINT_ID}/continue`
const CONTINUE_UPSTREAM_PATH = `/v1/runtime/sessions/chatllm/c1/model-step-checkpoints/${CHECKPOINT_ID}/continue`
const MESSAGES_PATH = '/rpc/hosts/chatllm/sessions/chatllm/c1/messages'

// The C0 wire vectors (tests/fixtures/model-step-checkpoint) are the contract
// shared with the Host test suite and Desktop; relaying them here pins the
// proxy to the same bodies instead of a local copy.
const VECTOR_DIR = path.join(__dirname, '../../../tests/fixtures/model-step-checkpoint')

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(VECTOR_DIR, name), 'utf8'))
}

function readVector(name: string): { httpStatus: number; body: Record<string, unknown> } {
  return readJson(name) as { httpStatus: number; body: Record<string, unknown> }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

/** Minimal fetch Response mock: the route reads status, content-type and text. */
function mockResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReset()
  serviceMock.resolveHostConnectionForUser.mockReset()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

describe(`POST ${CONTINUE_PATH} — model-step continuation passthrough`, () => {
  it('forwards the version to the Host continuation route and relays its 202 claim', async () => {
    const claimed = readVector('continue-response.claimed.json')
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(claimed.httpStatus, claimed.body))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post(CONTINUE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ version: 3 })
      .expect(202)

    expect(res.body).toEqual(claimed.body)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`http://chatllm:8080${CONTINUE_UPSTREAM_PATH}`)
    expect((init as RequestInit).method).toBe('POST')
    // Only the edge headers are forwarded; the client Authorization is not.
    expect((init as RequestInit).headers).toMatchObject(HOST_CONNECTION.headers)
    expect((init as RequestInit).headers).not.toHaveProperty('authorization')
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization')
    // The body reaches the upstream verbatim (re-serialized from the parsed JSON).
    expect((init as RequestInit).body).toBe(JSON.stringify({ version: 3 }))
    // The claim may already be applied upstream, so a disconnect (never a
    // client-side deadline) is what releases the call.
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  // One case per row of the contract's precedence table, plus the lifecycle
  // drain fence, which this route relays instead of waking the Host.
  const RELAYED_CASES = [
    { name: 'claimed (202)', response: readVector('continue-response.claimed.json') },
    { name: 'reclaimed (202)', response: readVector('continue-response.reclaimed.json') },
    { name: 'replayed (202)', response: readVector('continue-response.replayed.json') },
    { name: 'completed (200)', response: readVector('continue-response.completed.json') },
    { name: 'not-found (404)', response: readVector('continue-response.not-found.json') },
    { name: 'blocked (409)', response: readVector('continue-response.blocked.json') },
    {
      name: 'version-mismatch (409)',
      response: readVector('continue-response.version-mismatch.json'),
    },
    {
      name: 'host_draining (503)',
      response: { httpStatus: 503, body: { code: 'host_draining', retryAfterMs: 1000 } },
    },
  ]

  it.each(RELAYED_CASES)(
    'relays the Host $name status and body unchanged',
    async ({ response }) => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(response.httpStatus, response.body))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const res = await request(makeApp())
        .post(CONTINUE_PATH)
        .set('authorization', 'Bearer user-token')
        .send({ version: 1 })
        .expect(response.httpStatus)

      expect(res.body).toEqual(response.body)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        `http://chatllm:8080${CONTINUE_UPSTREAM_PATH}`
      )
    }
  )

  it('rejects a token without host:message:invoke and never reaches the Host', async () => {
    // A navigation/read token must not start a continuation turn.
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: ['host:session:read'] })
    const deniedFetch = vi.fn()
    globalThis.fetch = deniedFetch as unknown as typeof fetch

    const denied = await request(makeApp())
      .post(CONTINUE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ version: 1 })
      .expect(403)

    expect(denied.body).toEqual({ error: 'Forbidden: missing scope' })
    // Liveness witness: the token was verified, so the 403 is the scope gate's
    // verdict on parsed claims, not a failed authentication or a routing miss.
    expect(authTokenMock.verifyRpcToken).toHaveBeenCalled()
    expect(deniedFetch).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()

    // Control: the same request with the scope present does reach the Host.
    authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
    const allowed = readVector('continue-response.claimed.json')
    const allowedFetch = vi.fn().mockResolvedValue(mockResponse(allowed.httpStatus, allowed.body))
    globalThis.fetch = allowedFetch as unknown as typeof fetch
    await request(makeApp())
      .post(CONTINUE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ version: 1 })
      .expect(202)
    expect(allowedFetch).toHaveBeenCalledTimes(1)
  })

  it('returns 401 without a token and never parses or forwards the request', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp()).post(CONTINUE_PATH).send({ version: 1 }).expect(401)

    // Liveness witness: the guarded route answered, and it answered as the
    // authentication middleware, not as a routing miss.
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns the proxy 403 when the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      denied: true,
      code: 'host_access_denied',
    })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post(CONTINUE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ version: 1 })
      .expect(403)

    expect(res.body).toEqual({
      error: 'Forbidden: user cannot access this host',
      code: 'host_access_denied',
    })
    // Liveness witness: resolution ran for this caller before the denial.
    expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
      'user-uuid-123',
      'chatllm',
      'user-token',
      { teamId: 'team-1' }
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    '/rpc/hosts/chat%2Fllm/sessions/chatllm/c1/model-step-checkpoints/msc_1/continue',
    '/rpc/hosts/chatllm/sessions/agent%3Aother/c1/model-step-checkpoints/msc_1/continue',
    '/rpc/hosts/chatllm/sessions/chatllm/chat%0Aother/model-step-checkpoints/msc_1/continue',
    '/rpc/hosts/chatllm/sessions/chatllm/c1/model-step-checkpoints/msc%2F1/continue',
    '/rpc/hosts/chatllm/sessions/chatllm/c1/model-step-checkpoints/msc%0A1/continue',
  ])('rejects unsafe route segments before forwarding upstream: %s', async unsafePath => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post(unsafePath)
      .set('authorization', 'Bearer user-token')
      .send({ version: 1 })
      .expect(400)

    // Liveness witness: the 400 is the route's own segment guard.
    expect(res.body).toEqual({ error: 'Invalid hostRef, agent, chatId, or checkpointId' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('maps a host-down fetch failure to a sanitized 502', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .post(CONTINUE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ version: 1 })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
  })

  it('maps an upstream timeout to a sanitized 504 on the public route', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const fetchMock = vi.fn().mockRejectedValue(timeout)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(createApp())
      .post(`/api/v1${CONTINUE_PATH}`)
      .set('authorization', 'Bearer user-token')
      .send({ version: 1 })
      .expect(504)

    expect(res.body).toEqual({ error: 'Gateway Timeout' })
  })
})

describe(`GET ${MESSAGES_PATH} — modelStepCheckpoint passthrough`, () => {
  it('passes the Host modelStepCheckpoint field through unchanged', async () => {
    const view = readJson('session-view.resumable.json')
    const upstream = {
      agent: 'chatllm',
      chatId: 'c1',
      state: 'awaiting_user',
      activeTaskId: null,
      modelStepCheckpoint: view,
      totalTurns: 1,
      turns: [],
    }
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, upstream))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get(MESSAGES_PATH)
      .set('authorization', 'Bearer user-token')
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(res.body.modelStepCheckpoint).toEqual(view)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://chatllm:8080/v1/runtime/sessions/chatllm/c1/messages')
    expect((init as RequestInit).method).toBe('GET')
  })

  it('adds no modelStepCheckpoint field when the Host omits it', async () => {
    const upstream = { agent: 'chatllm', chatId: 'c1', state: 'ready', totalTurns: 1, turns: [] }
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, upstream))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .get(MESSAGES_PATH)
      .set('authorization', 'Bearer user-token')
      .expect(200)

    // Liveness witness: the read answered from the Host body, and that body's
    // actual fields arrived untouched, so the absence is the Host's.
    expect(res.body).toEqual(upstream)
    expect(Object.keys(res.body)).not.toContain('modelStepCheckpoint')
    expect(res.body.state).toBe('ready')
  })
})
