import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  // vi.mock must mirror every named export the production module surfaces or
  // sibling routers fail to load (see progress-stream.test.ts).
  forwardCancelToHost: vi.fn(),
  forwardHostActivity: vi.fn(),
  forwardHostHealth: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  forwardHostStatus: vi.fn(),
  forwardRpcToServer: vi.fn(),
  forwardTaskResultFromHost: vi.fn(),
  listAllowedServersForUser: vi.fn(),
  resolveHostConnectionForUser: vi.fn(),
  resolveServerConnectionForUser: vi.fn(),
  validateRpcRequest: vi.fn(),
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

const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:message:invoke'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
  headers: {},
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

function hostDownError(): Error {
  return new TypeError('fetch failed')
}

function drainingError(): Error {
  return new serviceMock.UpstreamHostError(503, '{"code":"host_draining","retryAfterMs":1000}')
}

function postMessage(app: express.Express) {
  return request(app)
    .post('/rpc/hosts/chatllm/messages')
    .set('authorization', 'Bearer token')
    .send({ content: 'hello' })
}

beforeEach(() => {
  vi.clearAllMocks()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
})

describe('POST /rpc/hosts/:hostRef/messages wake-and-hold triggers', () => {
  it('host-down network error triggers a wake; 200 active leads to one immediate upstream retry', async () => {
    serviceMock.forwardHostMessageToHost
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce({ success: true, taskId: 't-1' })
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    const response = await postMessage(makeApp()).expect(200)

    expect(response.body).toEqual({ success: true, taskId: 't-1' })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'token')
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(2)
  })

  it('the wake retry re-forwards the SAME stable messageId as the first forward (idempotency identity)', async () => {
    // P1-1: without a stable delivery id the wake-and-hold retry re-forwards
    // the same turn under a fresh uuid at mcp-host and executes it twice. The
    // route must stamp a deterministic messageId ONCE and carry it identically
    // across the first forward and the retry, so mcp-host's admission sink can
    // dedup the retry instead of re-executing.
    serviceMock.forwardHostMessageToHost
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce({ success: true, taskId: 't-1' })
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    await postMessage(makeApp()).expect(200)

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(2)
    const firstBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1] as {
      messageId?: unknown
      traceContext?: unknown
    }
    const retryBody = serviceMock.forwardHostMessageToHost.mock.calls[1][1] as {
      messageId?: unknown
      traceContext?: unknown
    }
    expect(typeof firstBody.messageId).toBe('string')
    expect((firstBody.messageId as string).length).toBeGreaterThan(0)
    // Neither Date.now() nor random: the two deliveries MUST be byte-identical.
    expect(retryBody.messageId).toBe(firstBody.messageId)
    expect(retryBody.traceContext).toBe(firstBody.traceContext)
  })

  it('two DISTINCT sends with identical content in one thread get DIFFERENT messageIds (D1)', async () => {
    // D1: a content-hash delivery id would collapse two legitimate identical
    // turns ("yes", "ok", "retry") into one, replaying the first answer and
    // dropping the second. The id must be per-request unique, so byte-identical
    // sends produce distinct messageIds and both execute at mcp-host.
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, taskId: 't-1' })

    const app = makeApp()
    const send = () =>
      request(app)
        .post('/rpc/hosts/chatllm/messages')
        .set('authorization', 'Bearer token')
        .send({ content: 'yes', threadId: 'chat-1' })
        .expect(200)

    await send()
    await send()

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(2)
    const firstId = (
      serviceMock.forwardHostMessageToHost.mock.calls[0][1] as { messageId?: string }
    ).messageId
    const secondId = (
      serviceMock.forwardHostMessageToHost.mock.calls[1][1] as { messageId?: string }
    ).messageId
    expect(typeof firstId).toBe('string')
    expect(typeof secondId).toBe('string')
    expect(secondId).not.toBe(firstId)
  })

  it('a client-supplied Idempotency-Key header is used as the delivery id (D1 opt-in)', async () => {
    // When the client scopes its own retries via Idempotency-Key, two sends that
    // carry the SAME header value present the SAME messageId so mcp-host dedups
    // them — this is the client's explicit choice, distinct from the default
    // per-request nonce.
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, taskId: 't-1' })

    const app = makeApp()
    const sendWithKey = (key: string) =>
      request(app)
        .post('/rpc/hosts/chatllm/messages')
        .set('authorization', 'Bearer token')
        .set('idempotency-key', key)
        .send({ content: 'anything', threadId: 'chat-1' })
        .expect(200)

    await sendWithKey('client-key-abc')
    await sendWithKey('client-key-abc')

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(2)
    const firstId = (
      serviceMock.forwardHostMessageToHost.mock.calls[0][1] as { messageId?: string }
    ).messageId
    const secondId = (
      serviceMock.forwardHostMessageToHost.mock.calls[1][1] as { messageId?: string }
    ).messageId
    expect(firstId).toBe('client-key-abc')
    expect(secondId).toBe('client-key-abc')
  })

  it('upstream 503 host_draining triggers a wake and is NOT surfaced as a client error', async () => {
    serviceMock.forwardHostMessageToHost
      .mockRejectedValueOnce(drainingError())
      .mockResolvedValueOnce({ success: true, taskId: 't-2' })
    // Draining host: control-api answers 200 active + bumped generation.
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: 12,
    })

    const response = await postMessage(makeApp()).expect(200)

    expect(response.body).toEqual({ success: true, taskId: 't-2' })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
  })

  it('drain-cancel bounce resolves within the short retry schedule (250ms then 1s)', async () => {
    serviceMock.forwardHostMessageToHost
      .mockRejectedValueOnce(drainingError()) // trigger
      .mockRejectedValueOnce(drainingError()) // immediate retry still fenced
      .mockResolvedValueOnce({ success: true, taskId: 't-3' }) // 250ms later: fence lifted
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: 13,
    })

    const response = await postMessage(makeApp()).expect(200)

    expect(response.body).toEqual({ success: true, taskId: 't-3' })
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(3)
  })

  it('409 not-stateless keeps today behavior exactly: 502 Upstream host unavailable', async () => {
    serviceMock.forwardHostMessageToHost.mockRejectedValue(hostDownError())
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'not-stateless' })

    const response = await postMessage(makeApp()).expect(502)

    expect(response.body).toEqual({ error: 'Upstream host unavailable' })
  })

  it('404 unknown host maps to a 404 for the caller', async () => {
    serviceMock.forwardHostMessageToHost.mockRejectedValue(hostDownError())
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'unknown' })

    const response = await postMessage(makeApp()).expect(404)

    expect(response.body).toEqual({ error: 'Host not found or not accessible' })
  })

  it('429 rate-limited maps to structured host_waking with Retry-After respected', async () => {
    serviceMock.forwardHostMessageToHost.mockRejectedValue(hostDownError())
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'rate-limited',
      retryAfterSeconds: 30,
    })

    const response = await postMessage(makeApp()).expect(503)

    expect(response.headers['retry-after']).toBe('30')
    expect(response.body).toMatchObject({
      code: 'host_waking',
      hostRef: 'chatllm',
      retryAfterMs: 30_000,
      message: 'Host is waking up',
    })
    // Never leak tokens or internal state into the waking contract.
    expect(JSON.stringify(response.body)).not.toContain('token')
  })

  it('host still unreachable after a wake reports active resolves to host_waking, never a hang', async () => {
    serviceMock.forwardHostMessageToHost.mockRejectedValue(hostDownError())
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    const response = await postMessage(makeApp()).expect(503)

    expect(response.body).toMatchObject({ code: 'host_waking', hostRef: 'chatllm' })
    // Trigger + the full short retry schedule were attempted.
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(4)
  })

  it('a non-availability upstream failure (mcp-host 500) never triggers a wake', async () => {
    serviceMock.forwardHostMessageToHost.mockRejectedValue(
      new serviceMock.UpstreamHostError(500, '{"error":"boom"}')
    )

    const response = await postMessage(makeApp()).expect(502)

    expect(response.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('an upstream AbortError keeps the 504 path and never triggers a wake', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    serviceMock.forwardHostMessageToHost.mockRejectedValue(abort)

    const response = await postMessage(makeApp()).expect(504)

    expect(response.body).toEqual({ error: 'Gateway Timeout' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})

describe('task result and cancel host-down paths', () => {
  it('GET task result triggers wake on host-down and forwards after active', async () => {
    const claims = { ...VALID_CLAIMS, scopes: ['host:message:invoke'] }
    authTokenMock.verifyRpcToken.mockReturnValue(claims)
    serviceMock.forwardTaskResultFromHost
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce({ status: 'completed', response: 'done' })
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    const response = await request(makeApp())
      .get('/rpc/hosts/chatllm/tasks/t-9/result')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(response.body).toEqual({ status: 'completed', response: 'done' })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
  })

  it('POST cancel triggers wake on host-down and forwards after active', async () => {
    serviceMock.forwardCancelToHost
      .mockRejectedValueOnce(hostDownError())
      .mockResolvedValueOnce({ status: 202, body: '{"ok":true}', contentType: 'application/json' })
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    const response = await request(makeApp())
      .post('/rpc/hosts/chatllm/tasks/t-9/cancel')
      .set('authorization', 'Bearer token')
      .expect(202)

    expect(response.body).toEqual({ ok: true })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
  })
})
