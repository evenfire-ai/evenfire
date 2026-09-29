import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { config } from '../config.js'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter } from '../routes/rpc.js'
import { forwardHostMessageToHost } from '../services/mcpHostRestService.js'

// PR #849 R2-M3 / R1-M12 / R1-M13 / NEW-rpx-1 / NEW-sec-4.
//
// Every test here talks to a REAL http server through the real `fetch`, so the
// timers under test are the production timers, not a mocked fetch that reacts
// to an AbortSignal. Each upstream handler records the requests it saw: that is
// the liveness witness proving the request reached the upstream before the
// asserted outcome, so a 504 cannot be explained by "the request never left".

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

const ALL_SCOPES = [
  'host:approval:write',
  'host:model:write',
  'host:task:read',
  'host:message:invoke',
  'host:wake:write',
]

function claims() {
  return {
    sub: 'user-uuid-123',
    typ: 'user' as const,
    accessScope: 'team' as const,
    teamId: 'team-1',
    scopes: ALL_SCOPES,
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
  app.use(apiErrorHandler)
  return app
}

type SeenRequest = { method: string; url: string; closedEarly: boolean }
type Handler = (req: IncomingMessage, res: ServerResponse, index: number) => void

let server: Server | undefined
let seen: SeenRequest[] = []

async function startUpstream(handler: Handler): Promise<void> {
  seen = []
  server = createServer((req, res) => {
    const entry: SeenRequest = { method: req.method ?? '', url: req.url ?? '', closedEarly: false }
    seen.push(entry)
    res.once('close', () => {
      if (!res.writableFinished) entry.closedEarly = true
    })
    handler(req, res, seen.length - 1)
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({
    name: 'chatllm',
    url: `http://127.0.0.1:${port}`,
    headers: {},
  })
}

/** Ends the TCP connection without a response: undici reports it as `fetch failed`. */
function dropConnection(req: IncomingMessage): void {
  req.socket.destroy()
}

const original = {
  upstreamTimeoutMs: config.upstreamTimeoutMs,
  artifactDownloadTimeoutMs: config.artifactDownloadTimeoutMs,
  wakeMaxHoldMs: config.wakeMaxHoldMs,
}

beforeEach(() => {
  vi.clearAllMocks()
  authTokenMock.verifyRpcToken.mockReturnValue(claims())
  controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
    kind: 'active',
    wakeGeneration: null,
  })
  serviceMock.forwardHostHealth.mockResolvedValue({ ok: true })
  serviceMock.forwardHostMessageToHost.mockImplementation(
    forwardHostMessageToHost as typeof serviceMock.forwardHostMessageToHost
  )
})

afterEach(async () => {
  config.upstreamTimeoutMs = original.upstreamTimeoutMs
  config.artifactDownloadTimeoutMs = original.artifactDownloadTimeoutMs
  config.wakeMaxHoldMs = original.wakeMaxHoldMs
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
})

const MUTATING_ROUTES = [
  {
    label: 'approve',
    path: '/rpc/hosts/chatllm/approvals/approve',
    body: { toolCallId: 'tc-1' },
    upstreamPath: '/v1/runtime/approvals/approve',
  },
  {
    label: 'deny',
    path: '/rpc/hosts/chatllm/approvals/deny',
    body: { toolCallId: 'tc-1' },
    upstreamPath: '/v1/runtime/approvals/deny',
  },
  {
    label: 'set model',
    path: '/rpc/hosts/chatllm/model',
    body: { chatId: 'c1', model: 'claude-haiku-4-5' },
    upstreamPath: '/v1/runtime/model',
  },
] as const

function post(route: (typeof MUTATING_ROUTES)[number]) {
  return request(makeApp()).post(route.path).set('authorization', 'Bearer tok').send(route.body)
}

describe.each(MUTATING_ROUTES)('R2-M3 / R1-M12 $label route deadlines', route => {
  it('waits for a slow upstream past upstreamTimeoutMs and relays its real answer', async () => {
    config.upstreamTimeoutMs = 60
    await startUpstream((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ applied: true }))
      }, 400)
    })

    const startedAt = Date.now()
    const res = await post(route).expect(200)

    // Witness: the upstream received exactly this one request, was still working
    // on it well after the 60 ms deadline, and completed it (not closed early).
    expect(seen).toEqual([{ method: 'POST', url: route.upstreamPath, closedEarly: false }])
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350)
    expect(JSON.parse(res.text)).toEqual({ applied: true })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('a wake retry that hangs ends in 504 by its own bounded timeout', async () => {
    config.upstreamTimeoutMs = 150
    await startUpstream((req, _res, index) => {
      if (index === 0) dropConnection(req) // first attempt: host down
      // second attempt (the wake retry): never answered
    })

    const startedAt = Date.now()
    const res = await post(route).expect(504)

    expect(res.body).toEqual({ error: 'Gateway Timeout' })
    // Witness: two requests reached the upstream. The second is the retry; the
    // proxy aborted it (closedEarly) at ~upstreamTimeoutMs, not at some later
    // point, so the 504 comes from the retry deadline.
    expect(seen.map(entry => entry.url)).toEqual([route.upstreamPath, route.upstreamPath])
    await vi.waitFor(() => expect(seen[1]!.closedEarly).toBe(true))
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
  })

  it('a wake retry is bounded by the remaining hold budget, not by upstreamTimeoutMs', async () => {
    config.upstreamTimeoutMs = 30_000
    config.wakeMaxHoldMs = 1_300
    await startUpstream((req, _res, index) => {
      if (index === 0) dropConnection(req)
    })

    const startedAt = Date.now()
    await post(route).expect(504)
    const elapsed = Date.now() - startedAt

    expect(seen).toHaveLength(2)
    await vi.waitFor(() => expect(seen[1]!.closedEarly).toBe(true))
    // The hold budget (1.3 s) ended it, far below the 30 s upstream timeout.
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(elapsed).toBeLessThan(5_000)
  })

  // R1-M12: no idempotency key, so a duplicated POST is a duplicated side
  // effect. A host that keeps dropping connections must see a small, fixed
  // number of POSTs however long the hold window is.
  it('re-issues the POST at most once while the host keeps failing (4 s hold)', async () => {
    config.upstreamTimeoutMs = 2_000
    config.wakeMaxHoldMs = 4_000
    await startUpstream(req => dropConnection(req))

    const startedAt = Date.now()
    const res = await post(route).expect(503)

    expect(res.body).toMatchObject({ code: 'host_waking', hostRef: 'chatllm' })
    // Witness: the host was reached (POSTs observed) and a wake was requested.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalled()
    expect(seen).toHaveLength(2)
    // It answered promptly instead of looping through the whole 4 s window.
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })

  // NEW-fa-2: a retry with less than MIN_ADMISSION_RETRY_TIMEOUT_MS (1 s) of hold
  // budget left would time out after the upstream applied it. The 500 ms hold
  // budget leaves ~490 ms once the first attempt has failed: inside the
  // 100-999 ms band a lowered floor would send a second POST.
  it('sends no wake retry when less than the 1 s admission floor of the hold budget remains', async () => {
    config.upstreamTimeoutMs = 30_000
    config.wakeMaxHoldMs = 500
    await startUpstream(req => dropConnection(req))

    const res = await post(route).expect(503)

    expect(res.body).toMatchObject({ code: 'host_waking', hostRef: 'chatllm' })
    // Witness: the first attempt reached the upstream and the wake was requested,
    // so the single POST is the first attempt and the retry was withheld.
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(seen.map(entry => `${entry.method} ${entry.url}`)).toEqual([
      `POST ${route.upstreamPath}`,
    ])
  })
})

describe('R1-M12 /messages keeps the retry-until-deadline loop (it carries a messageId)', () => {
  it('re-issues the POST until the host admits the request', async () => {
    config.upstreamTimeoutMs = 2_000
    config.wakeMaxHoldMs = 4_000
    await startUpstream((req, res, index) => {
      if (index < 3) {
        dropConnection(req)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, taskId: 't-1' }))
    })

    await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer tok')
      .send({ content: 'hello' })
      .expect(200)

    // Three dropped connections then an accepted one: more than the single
    // re-issue every other route is limited to.
    expect(seen).toHaveLength(4)
    expect(seen.every(entry => entry.url.startsWith('/v1/runtime/'))).toBe(true)
  })

  // NEW-fa-2: even the retry-until-deadline route stops re-issuing once less than
  // the 1 s admission floor of the hold budget remains (100-999 ms band).
  it('sends no retry when less than the 1 s admission floor of the hold budget remains', async () => {
    config.upstreamTimeoutMs = 30_000
    config.wakeMaxHoldMs = 500
    await startUpstream(req => dropConnection(req))

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer tok')
      .send({ content: 'hello' })
      .expect(503)

    expect(res.body).toMatchObject({ code: 'host_waking', hostRef: 'chatllm' })
    // Witness: the first attempt reached the upstream and the wake was requested.
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url.startsWith('/v1/runtime/')).toBe(true)
  })
})

describe('artifact download deadlines (NEW-rpx-1)', () => {
  const DOWNLOAD_PATH = '/rpc/hosts/chatllm/artifacts/report.bin/download'
  const UPSTREAM_DOWNLOAD_PATH = '/v1/runtime/artifacts/report.bin/download'

  function download() {
    return request(makeApp()).get(DOWNLOAD_PATH).set('authorization', 'Bearer tok')
  }

  it('slow response headers are cut off by upstreamTimeoutMs and answer 504', async () => {
    config.upstreamTimeoutMs = 30
    config.artifactDownloadTimeoutMs = 60_000
    await startUpstream((_req, res) => {
      // Headers would arrive after 1.5 s; the client must give up long before.
      setTimeout(() => {
        if (res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end('late')
      }, 1_500)
    })

    const startedAt = Date.now()
    const res = await download().expect(504)

    expect(res.body).toEqual({ error: 'Gateway Timeout' })
    expect(seen.map(entry => entry.url)).toEqual([UPSTREAM_DOWNLOAD_PATH])
    await vi.waitFor(() => expect(seen[0]!.closedEarly).toBe(true))
    expect(Date.now() - startedAt).toBeLessThan(1_200)
  })

  it('a body that stalls after the headers is cut off by artifactDownloadTimeoutMs and answers 504', async () => {
    config.upstreamTimeoutMs = 10_000
    config.artifactDownloadTimeoutMs = 50
    let headersFlushed = false
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000' })
      res.write('first-bytes', () => {
        headersFlushed = true
      })
      // ...and then nothing: the body never completes.
    })

    const startedAt = Date.now()
    const res = await download().expect(504)

    expect(res.body).toEqual({ error: 'Gateway Timeout' })
    // Witness: the upstream had already sent its headers and first bytes, so the
    // 504 is the body-phase timer, not the 10 s header timer.
    expect(seen.map(entry => entry.url)).toEqual([UPSTREAM_DOWNLOAD_PATH])
    expect(headersFlushed).toBe(true)
    await vi.waitFor(() => expect(seen[0]!.closedEarly).toBe(true))
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })

  // NEW-sec-4: on a wake retry the body phase gets min(artifactDownloadTimeoutMs,
  // remaining hold budget), so a stalled retry cannot outlive the request.
  it('a stalled body on the wake retry is bounded by the remaining hold budget', async () => {
    config.upstreamTimeoutMs = 10_000
    config.artifactDownloadTimeoutMs = 60_000
    config.wakeMaxHoldMs = 1_400
    await startUpstream((req, res, index) => {
      if (index === 0) {
        dropConnection(req)
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000' })
      res.write('first-bytes')
    })

    const startedAt = Date.now()
    await download().expect(504)
    const elapsed = Date.now() - startedAt

    // Witness: the wake happened and the retry reached the upstream, which began
    // to answer (headers + first bytes) before stalling.
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(2)
    await vi.waitFor(() => expect(seen[1]!.closedEarly).toBe(true))
    // 1.4 s hold budget, not the 60 s download timeout.
    expect(elapsed).toBeLessThan(5_000)
  })

  // NEW-tq-3(c): both download timers are released once the response is
  // committed, so a completed download leaves no armed timer behind. Sentinel
  // delays (7777 header, 8888 body) identify the route's own timers among the
  // ones express/undici/supertest create.
  it('clears both the header timer and the body timer after a successful download', async () => {
    config.upstreamTimeoutMs = 7_777
    config.artifactDownloadTimeoutMs = 8_888
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const armed = new Map<unknown, number>()
    const cleared = new Set<unknown>()
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(handler, delay, ...args)
      if (delay === 7_777 || delay === 8_888) armed.set(timer, delay)
      return timer
    }) as typeof setTimeout)
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      timer?: Parameters<typeof clearTimeout>[0]
    ) => {
      cleared.add(timer)
      return realClearTimeout(timer)
    }) as typeof clearTimeout)
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('artifact-bytes')
    })

    try {
      await download().expect(200)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }

    // Witness: the route armed the header timer AND re-armed a body timer.
    expect([...armed.values()].sort()).toEqual([7_777, 8_888])
    for (const timer of armed.keys()) expect(cleared.has(timer)).toBe(true)
  })

  it('a healthy download still completes (control for the deadline tests)', async () => {
    config.upstreamTimeoutMs = 2_000
    config.artifactDownloadTimeoutMs = 2_000
    await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('artifact-bytes')
    })

    const res = await download().expect(200)

    expect(Buffer.from(res.body).toString()).toBe('artifact-bytes')
    expect(seen).toHaveLength(1)
  })
})

describe('artifacts list keeps a finite first-attempt deadline', () => {
  it('returns 504 when the upstream never answers (read-only, small JSON)', async () => {
    config.upstreamTimeoutMs = 60
    await startUpstream(() => {
      // never answered
    })

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/artifacts')
      .set('authorization', 'Bearer tok')
      .expect(504)

    expect(res.body).toEqual({ error: 'Gateway Timeout' })
    expect(seen.map(entry => entry.url)).toEqual(['/v1/runtime/artifacts'])
    await vi.waitFor(() => expect(seen[0]!.closedEarly).toBe(true))
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})
