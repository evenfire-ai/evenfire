import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Response as ExpressResponse } from 'express'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { config } from '../config.js'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter, respondUpstreamUnavailable } from '../routes/rpc.js'
import {
  UpstreamHostError,
  forwardHostActivity,
  forwardHostHealth,
  forwardHostMessageToHost,
  forwardHostStatus,
  forwardTaskResultFromHost,
} from '../services/mcpHostRestService.js'

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

// Issue #791 §11.4: a wake-eligible finite operation carries host:wake:write in
// addition to its operation scope (Desktop adds it; the route scope guard is
// unchanged). Without wake capability the coordinator no longer triggers a wake.
const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:message:invoke', 'host:wake:write'],
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
// Mirrors desktop-app/ui/src/constants/attachments.ts COMPOSER_FORWARDED_FIELDS_BYTES:
// the bytes rpc-proxy may add to a Desktop body before forwarding it to the Host.
const DESKTOP_FORWARDED_FIELDS_HEADROOM_BYTES = 2048
// traceContext.ts caps each correlation ref at 256 characters; `edge-request:` is 13.
const LONGEST_RETAINED_REQUEST_ID_LENGTH = 256 - 'edge-request:'.length
const originalUpstreamTimeoutMs = config.upstreamTimeoutMs
const originalFetch = globalThis.fetch

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  app.use(apiErrorHandler)
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
  // Reset, not clear: clearing keeps implementations and queued `*Once` values,
  // so a test that stops early would hand them to the next test.
  vi.resetAllMocks()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
})

afterEach(() => {
  vi.useRealTimers()
  config.upstreamTimeoutMs = originalUpstreamTimeoutMs
  globalThis.fetch = originalFetch
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
    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][2]).toEqual({ async: false })
  })

  it('uses the normal POST timeout before wake-hold retries until the suspended Host admits', async () => {
    serviceMock.forwardHostMessageToHost
      .mockRejectedValueOnce(hostDownError()) // Initial POST fails quickly on the suspended Host.
      .mockRejectedValueOnce(hostDownError()) // Wake was accepted, but admission is not ready yet.
      .mockResolvedValueOnce({ success: true, taskId: 't-delayed' })
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    const response = await postMessage(makeApp()).expect(200)

    expect(response.body).toEqual({ success: true, taskId: 't-delayed' })
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(3)
    // The first POST omits timeoutMs so the service applies its normal full upstream timeout.
    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][2]).toEqual({ async: false })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][1]).toBe(
      serviceMock.forwardHostMessageToHost.mock.calls.at(-1)![1]
    )
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
    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][2]).toEqual({ async: false })
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

  it('409 not-stateless keeps the full upstream timeout and legacy 502 behavior', async () => {
    serviceMock.forwardHostMessageToHost.mockRejectedValue(hostDownError())
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'not-stateless' })

    const response = await postMessage(makeApp()).expect(502)

    expect(response.body).toEqual({ error: 'Upstream host unavailable' })
    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][2]).toEqual({ async: false })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
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
    let wakeStarted!: () => void
    const wakeCalled = new Promise<void>(resolve => {
      wakeStarted = resolve
    })
    serviceMock.forwardHostMessageToHost.mockRejectedValue(hostDownError())
    controlApiMock.requestHostWakeFromControlApi.mockImplementation(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      wakeStarted()
      return { kind: 'active', wakeGeneration: null }
    })

    const responsePromise = postMessage(makeApp())
      .expect(503)
      .then(response => response)
    await wakeCalled
    await vi.advanceTimersByTimeAsync(48_000)
    const response = await responsePromise

    expect(response.body).toMatchObject({ code: 'host_waking', hostRef: 'chatllm' })
    expect(serviceMock.forwardHostMessageToHost.mock.calls.length).toBeGreaterThan(4)
  })

  it('a non-availability upstream failure (mcp-host 500) never enters the wake hold', async () => {
    serviceMock.forwardHostMessageToHost.mockRejectedValue(
      new serviceMock.UpstreamHostError(500, '{"error":"boom"}')
    )

    const response = await postMessage(makeApp()).expect(502)

    expect(response.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('passes a real Host 413 through as 413 Payload Too Large without entering the wake hold', async () => {
    let hostHits = 0
    const server = createServer((req, res) => {
      hostHits += 1
      req.resume()
      req.on('end', () => {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload Too Large' }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      ...HOST_CONNECTION,
      url: `http://127.0.0.1:${port}`,
    })
    serviceMock.forwardHostMessageToHost.mockImplementation(
      forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
    )

    try {
      const response = await postMessage(makeApp())

      expect(response.status).toBe(413)
      expect(response.body).toEqual({ error: 'Payload Too Large' })
      expect(hostHits).toBe(1)
      expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  // A real Host that answers the first POST with a draining 503 and the
  // post-wake retry with `retryStatus`, so both errors come from the real
  // forwardHostMessageToHost rather than hand-built UpstreamHostErrors.
  async function withDrainingThenHost(
    retryStatus: number,
    retryBody: Record<string, unknown>,
    run: (hostHits: () => number) => Promise<void>
  ): Promise<void> {
    let hits = 0
    const server = createServer((req, res) => {
      hits += 1
      const hit = hits
      req.resume()
      req.on('end', () => {
        res.writeHead(hit === 1 ? 503 : retryStatus, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify(hit === 1 ? { code: 'host_draining', retryAfterMs: 1000 } : retryBody)
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      ...HOST_CONNECTION,
      url: `http://127.0.0.1:${port}`,
    })
    serviceMock.forwardHostMessageToHost.mockImplementation(
      forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
    )
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: 21,
    })
    try {
      await run(() => hits)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  it('passes a Host 413 on the post-wake retry through as the same 413 as the direct path', async () => {
    await withDrainingThenHost(413, { error: 'Payload Too Large' }, async hostHits => {
      const response = await postMessage(makeApp())

      // Witness: the 503 entered the wake hold and the retry reached the Host.
      expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
      expect(hostHits()).toBe(2)
      expect(response.status).toBe(413)
      expect(response.body).toEqual({ error: 'Payload Too Large' })
    })
  })

  it('still answers 200 when the post-wake retry is accepted by the Host', async () => {
    await withDrainingThenHost(200, { success: true, taskId: 't-after-wake' }, async hostHits => {
      const response = await postMessage(makeApp())

      expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
      expect(hostHits()).toBe(2)
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ success: true, taskId: 't-after-wake' })
    })
  })

  it('keeps a non-413 Host failure on the post-wake retry on the 502 path', async () => {
    await withDrainingThenHost(500, { error: 'boom' }, async hostHits => {
      const response = await postMessage(makeApp())

      expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
      expect(hostHits()).toBe(2)
      expect(response.status).toBe(502)
      expect(response.body).toEqual({ error: 'Upstream host unavailable' })
    })
  })

  it('forwards at most the Desktop headroom of bytes beyond the inbound Desktop body', async () => {
    let forwardedRaw = ''
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        forwardedRaw = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, taskId: 't-growth' }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      sub: randomUUID(),
      teamId: randomUUID(),
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      ...HOST_CONNECTION,
      url: `http://127.0.0.1:${port}`,
    })
    serviceMock.forwardHostMessageToHost.mockImplementation(
      forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
    )
    const inboundRaw = JSON.stringify({ content: 'hello', threadId: randomUUID() })

    try {
      await request(makeApp())
        .post('/rpc/hosts/chatllm/messages')
        .set('authorization', 'Bearer token')
        .set('content-type', 'application/json')
        .set('x-request-id', 'r'.repeat(LONGEST_RETAINED_REQUEST_ID_LENGTH))
        .send(inboundRaw)
        .expect(200)

      const forwarded = JSON.parse(forwardedRaw) as {
        traceContext: { correlationRefs: string[] }
      }
      // Witness: the longest retained x-request-id is among the forwarded refs.
      expect(forwarded.traceContext.correlationRefs.length).toBe(3)
      expect(Buffer.byteLength(forwardedRaw) - Buffer.byteLength(inboundRaw)).toBeLessThanOrEqual(
        DESKTOP_FORWARDED_FIELDS_HEADROOM_BYTES
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('an upstream AbortError keeps the 504 path without entering the wake hold', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    serviceMock.forwardHostMessageToHost.mockRejectedValue(abort)

    const response = await postMessage(makeApp()).expect(504)

    expect(response.body).toEqual({ error: 'Gateway Timeout' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('returns 504 when the real host REST service times out a hanging HTTP request', async () => {
    config.upstreamTimeoutMs = 25
    const server = createServer(() => {
      // Leave the request unanswered so the service timeout must abort it.
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      ...HOST_CONNECTION,
      url: `http://127.0.0.1:${port}`,
    })
    serviceMock.forwardHostMessageToHost.mockImplementation(
      forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
    )

    try {
      await postMessage(makeApp()).expect(504, { error: 'Gateway Timeout' })
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('a wake retry that times out returns 504 instead of 502', async () => {
    const timeout = new Error('aborted')
    timeout.name = 'AbortError'
    serviceMock.forwardHostMessageToHost
      .mockRejectedValueOnce(hostDownError())
      .mockRejectedValueOnce(timeout)
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    const response = await postMessage(makeApp()).expect(504)

    expect(response.body).toEqual({ error: 'Gateway Timeout' })
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(2)
    expect(serviceMock.forwardHostMessageToHost.mock.calls[1][2]).toEqual({
      async: false,
      timeoutMs: expect.any(Number),
    })
  })

  it('the real REST forwarder aborts a hanging wake retry and returns 504', async () => {
    config.upstreamTimeoutMs = 30
    let retrySignal: AbortSignal | undefined
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(hostDownError())
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        retrySignal = init.signal as AbortSignal
        return new Promise((_resolve, reject) => {
          retrySignal!.addEventListener('abort', () => reject(retrySignal!.reason), {
            once: true,
          })
        })
      })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    serviceMock.forwardHostMessageToHost.mockImplementation(
      forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
    )
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })

    const response = await postMessage(makeApp()).expect(504)

    expect(response.body).toEqual({ error: 'Gateway Timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(retrySignal?.aborted).toBe(true)
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
  })

  it('a token without wake scope keeps the original full upstream timeout', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    serviceMock.forwardHostMessageToHost.mockRejectedValue(abort)

    await postMessage(makeApp()).expect(504)

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][2]).toEqual({ async: false })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('uses the normal upstream timeout for a healthy POST without requesting a wake', async () => {
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, taskId: 't-stateful' })

    await postMessage(makeApp()).expect(200)

    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][2]).toEqual({ async: false })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})

describe('task result and cancel host-down paths', () => {
  it('GET task result triggers wake on host-down and forwards after active', async () => {
    const claims = { ...VALID_CLAIMS, scopes: ['host:message:invoke', 'host:wake:write'] }
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

// A Host error body can carry user content (a prompt echo, a file name, a tool
// argument). rpc-proxy logs which failure happened, never what the Host said:
// these tests drive the REAL Host REST forwarders against a local Host whose
// error body holds a unique marker, then search every console line for it.
describe('Host error bodies stay out of rpc-proxy logs', () => {
  const CONSOLE_METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const
  const MARKER_FRAGMENT_WIDTH = 12

  type ScriptedReply = { status: number; body: Record<string, unknown> }

  function captureConsole() {
    const spies = CONSOLE_METHODS.map(method =>
      vi.spyOn(console, method).mockImplementation(() => {})
    )
    const render = (args: unknown[]) =>
      args
        .map(arg => (typeof arg === 'string' ? arg : (JSON.stringify(arg) ?? String(arg))))
        .join(' ')
    return {
      allLines: () => spies.flatMap(spy => spy.mock.calls.map(render)),
      warnLines: () => spies[CONSOLE_METHODS.indexOf('warn')].mock.calls.map(render),
      restore: () => spies.forEach(spy => spy.mockRestore()),
    }
  }

  function markerFragmentsIn(lines: string[], marker: string): string[] {
    const hits: string[] = []
    for (let start = 0; start + MARKER_FRAGMENT_WIDTH <= marker.length; start++) {
      const fragment = marker.slice(start, start + MARKER_FRAGMENT_WIDTH)
      if (lines.some(line => line.includes(fragment))) hits.push(fragment)
    }
    return hits
  }

  // Answers hit N with replies[N-1] (the last reply repeats) and points the
  // resolved host connection at it.
  async function withScriptedHost(
    replies: ScriptedReply[],
    run: (hostHits: () => number) => Promise<void>
  ): Promise<void> {
    let hits = 0
    const server = createServer((req, res) => {
      hits += 1
      const reply = replies[Math.min(hits, replies.length) - 1]
      req.resume()
      req.on('end', () => {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      ...HOST_CONNECTION,
      url: `http://127.0.0.1:${port}`,
    })
    try {
      await run(() => hits)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  function userContentMarker(): string {
    return `user-content-${randomUUID()}`
  }

  it('logs the status of a first-attempt Host failure without the Host body', async () => {
    const marker = userContentMarker()
    serviceMock.forwardHostMessageToHost.mockImplementation(
      forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
    )
    const logs = captureConsole()
    try {
      await withScriptedHost(
        [{ status: 500, body: { error: 'boom', detail: marker } }],
        async hostHits => {
          const response = await postMessage(makeApp())

          expect(hostHits()).toBe(1)
          expect(response.status).toBe(502)
        }
      )
      const failureLines = logs
        .warnLines()
        .filter(line => line.includes('[RPC_PROXY] host message forward failed host=chatllm'))
      // Witness: the failure path ran and logged exactly once.
      expect(failureLines).toHaveLength(1)
      expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
      expect(failureLines[0]).toContain('error=UpstreamHostError status=500')
    } finally {
      logs.restore()
    }
  })

  it('logs the status of a post-wake retry Host failure without the Host body', async () => {
    const marker = userContentMarker()
    serviceMock.forwardHostMessageToHost.mockImplementation(
      forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
    )
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: 22,
    })
    const logs = captureConsole()
    try {
      await withScriptedHost(
        [
          { status: 503, body: { code: 'host_draining', retryAfterMs: 1000 } },
          { status: 500, body: { error: 'boom', detail: marker } },
        ],
        async hostHits => {
          const response = await postMessage(makeApp())

          expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
          expect(hostHits()).toBe(2)
          expect(response.status).toBe(502)
        }
      )
      const retryLines = logs
        .warnLines()
        .filter(line => line.includes('[RPC_PROXY] wake-hold upstream retry failed host=chatllm'))
      // Witness: the post-wake retry failure path ran and logged exactly once.
      expect(retryLines).toHaveLength(1)
      expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
      expect(retryLines[0]).toContain('error=UpstreamHostError status=500')
    } finally {
      logs.restore()
    }
  })

  it('logs the status of a task result Host failure without the Host body', async () => {
    const marker = userContentMarker()
    serviceMock.forwardTaskResultFromHost.mockImplementation(
      forwardTaskResultFromHost as typeof serviceMock.forwardTaskResultFromHost
    )
    const logs = captureConsole()
    try {
      await withScriptedHost(
        [{ status: 500, body: { error: 'boom', detail: marker } }],
        async hostHits => {
          const response = await request(makeApp())
            .get('/rpc/hosts/chatllm/tasks/t-9/result')
            .set('authorization', 'Bearer token')

          expect(hostHits()).toBe(1)
          expect(response.status).toBe(502)
        }
      )
      const failureLines = logs
        .warnLines()
        .filter(line => line.includes('[RPC_PROXY] task result forward failed'))
      // Witness: the failure path ran and logged exactly once.
      expect(failureLines).toHaveLength(1)
      expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
      expect(failureLines[0]).toContain('error=UpstreamHostError status=500')
    } finally {
      logs.restore()
    }
  })

  it('logs the status of a host status read failure without the Host body', async () => {
    const marker = userContentMarker()
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:status:read'],
    })
    serviceMock.forwardHostStatus.mockImplementation(
      forwardHostStatus as typeof serviceMock.forwardHostStatus
    )
    const logs = captureConsole()
    try {
      await withScriptedHost(
        [{ status: 500, body: { error: 'boom', detail: marker } }],
        async hostHits => {
          await request(makeApp())
            .get('/rpc/hosts/chatllm/status')
            .set('authorization', 'Bearer token')

          expect(hostHits()).toBe(1)
        }
      )
      const failureLines = logs
        .warnLines()
        .filter(line => line.includes('[RPC_PROXY] host status failed host=chatllm'))
      // Witness: the failure path ran and logged exactly once.
      expect(failureLines).toHaveLength(1)
      expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
      expect(failureLines[0]).toContain('error=UpstreamHostError status=500')
    } finally {
      logs.restore()
    }
  })

  it.each([
    {
      site: 'host activity',
      scope: 'host:activity:read',
      path: '/rpc/hosts/chatllm/activity',
      prefix: '[RPC_PROXY] host activity failed host=chatllm',
      useRealForwarder: () =>
        serviceMock.forwardHostActivity.mockImplementation(
          forwardHostActivity as typeof serviceMock.forwardHostActivity
        ),
    },
    {
      site: 'host health',
      scope: 'host:health:read',
      path: '/rpc/hosts/chatllm/health',
      prefix: '[RPC_PROXY] host health failed host=chatllm',
      useRealForwarder: () =>
        serviceMock.forwardHostHealth.mockImplementation(
          forwardHostHealth as typeof serviceMock.forwardHostHealth
        ),
    },
  ])(
    'logs the status of a $site read failure without the Host body',
    async ({ scope, path, prefix, useRealForwarder }) => {
      const marker = userContentMarker()
      authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS, scopes: [scope] })
      useRealForwarder()
      const logs = captureConsole()
      try {
        await withScriptedHost(
          [{ status: 500, body: { error: 'boom', detail: marker } }],
          async hostHits => {
            const response = await request(makeApp()).get(path).set('authorization', 'Bearer token')

            expect(hostHits()).toBe(1)
            // The route hands the error to the app error handler, which answers 500.
            expect(response.status).toBe(500)
          }
        )
        const failureLines = logs.warnLines().filter(line => line.includes(prefix))
        // Witness: the failure path ran and logged exactly once.
        expect(failureLines).toHaveLength(1)
        expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
        expect(failureLines[0]).toContain('error=UpstreamHostError status=500')
      } finally {
        logs.restore()
      }
    }
  )

  // Built exactly as the real Host REST forwarders build it: the message embeds
  // up to 300 characters of the Host body, so printing `error.message` would
  // print the marker.
  function hostErrorCarrying(marker: string): UpstreamHostError {
    const error = new UpstreamHostError(
      500,
      JSON.stringify({ error: 'boom', detail: marker }).slice(0, 300)
    )
    // Precondition: a log line printing the message would leak the marker.
    expect(error.message).toContain(marker)
    return error
  }

  // The real forwardCancelToHost relays a Host non-2xx as a status/body pair
  // instead of throwing, so the forwarder rejects here with the Host error type
  // the cancel route's inner catch has to log without its body.
  it('logs the status of a cancel forward Host failure without the Host body', async () => {
    const marker = userContentMarker()
    serviceMock.forwardCancelToHost.mockRejectedValueOnce(hostErrorCarrying(marker))
    const logs = captureConsole()
    try {
      const response = await request(makeApp())
        .post('/rpc/hosts/chatllm/tasks/t-9/cancel')
        .set('authorization', 'Bearer token')

      expect(serviceMock.forwardCancelToHost).toHaveBeenCalledTimes(1)
      expect(response.status).toBe(502)
      const failureLines = logs
        .warnLines()
        .filter(line => line.includes('[RPC_PROXY] cancel forward failed'))
      // Witness: a cancel failure was logged exactly once. The inner and outer
      // catches log the same prefix and both answer 502, so this does not tell
      // them apart; both describe the error with `describeErrorForLog`.
      expect(failureLines).toHaveLength(1)
      expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
      expect(failureLines[0]).toContain('error=UpstreamHostError status=500')
    } finally {
      logs.restore()
    }
  })

  // An outer catch logs whatever escapes before the inner Host forward; host
  // resolution is the step a route test can make reject.
  it.each([
    {
      site: 'host message',
      send: (app: express.Express) => postMessage(app),
      forwarder: serviceMock.forwardHostMessageToHost,
      prefix: '[RPC_PROXY] host message forward failed host=chatllm',
    },
    {
      site: 'task result',
      send: (app: express.Express) =>
        request(app)
          .get('/rpc/hosts/chatllm/tasks/t-9/result')
          .set('authorization', 'Bearer token'),
      forwarder: serviceMock.forwardTaskResultFromHost,
      prefix: '[RPC_PROXY] task result forward failed',
    },
    {
      site: 'cancel',
      send: (app: express.Express) =>
        request(app)
          .post('/rpc/hosts/chatllm/tasks/t-9/cancel')
          .set('authorization', 'Bearer token'),
      forwarder: serviceMock.forwardCancelToHost,
      prefix: '[RPC_PROXY] cancel forward failed',
    },
  ])(
    'logs the status of an error reaching the $site outer catch without the Host body',
    async ({ send, forwarder, prefix }) => {
      const marker = userContentMarker()
      serviceMock.resolveHostConnectionForUser.mockRejectedValueOnce(hostErrorCarrying(marker))
      const logs = captureConsole()
      try {
        const response = await send(makeApp())

        expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledTimes(1)
        expect(response.status).toBe(502)
        // The inner forward never ran, so the line below comes from the outer catch.
        expect(forwarder).not.toHaveBeenCalled()
        const failureLines = logs.warnLines().filter(line => line.includes(prefix))
        // Witness: the outer catch ran and logged exactly once.
        expect(failureLines).toHaveLength(1)
        expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
        expect(failureLines[0]).toContain('error=UpstreamHostError status=500')
      } finally {
        logs.restore()
      }
    }
  )

  // No route reaches respondUpstreamUnavailable with a committed response: that
  // takes an Express write that throws after committing, which a route test can
  // only produce by replacing Express's response methods. The responder is
  // exported, so the duplicate-suppression branch is driven directly.
  it('logs the status of a Host failure on a committed response without the Host body', () => {
    const marker = userContentMarker()
    const status = vi.fn()
    const committed = { headersSent: true, status } as unknown as ExpressResponse
    const logs = captureConsole()
    try {
      respondUpstreamUnavailable(committed, hostErrorCarrying(marker))

      const suppressionLines = logs
        .warnLines()
        .filter(line =>
          line.includes(
            '[RPC_PROXY] suppressing duplicate terminal response (upstream-unavailable)'
          )
        )
      // Witness: the duplicate-suppression branch ran and logged exactly once.
      expect(suppressionLines).toHaveLength(1)
      expect(status).not.toHaveBeenCalled()
      expect(markerFragmentsIn(logs.allLines(), marker)).toEqual([])
      expect(suppressionLines[0]).toContain('UpstreamHostError status=500')
    } finally {
      logs.restore()
    }
  })
})
