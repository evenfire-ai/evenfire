import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { config } from '../config.js'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter } from '../routes/rpc.js'
import { forwardCancelToHost, forwardTaskResultFromHost } from '../services/mcpHostRestService.js'

// PR #849 R3-M1: a wake-and-hold retry of an idempotent GET keeps re-issuing
// the read until the hold deadline, like `/messages`; the mutating routes keep
// their single re-issue. Every test talks to a REAL http server through the
// real `fetch`; the requests the upstream records are the liveness witness.

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

function claims() {
  return {
    sub: 'user-uuid-123',
    typ: 'user' as const,
    accessScope: 'team' as const,
    teamId: 'team-1',
    scopes: [
      'host:approval:write',
      'host:model:write',
      'host:session:read',
      'host:task:read',
      'host:message:invoke',
      'host:wake:write',
    ],
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

type SeenRequest = { method: string; url: string }
type Handler = (req: IncomingMessage, res: ServerResponse, index: number) => void

let server: Server | undefined
let seen: SeenRequest[] = []

async function startUpstream(handler: Handler): Promise<void> {
  seen = []
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' })
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

function answerJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** The first `drops` requests lose their connection; later ones answer 200. */
function dropThenAnswer(drops: number, body: unknown): Handler {
  return (req, res, index) => {
    if (index < drops) {
      dropConnection(req)
      return
    }
    answerJson(res, 200, body)
  }
}

const original = {
  upstreamTimeoutMs: config.upstreamTimeoutMs,
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
  serviceMock.forwardTaskResultFromHost.mockImplementation(
    forwardTaskResultFromHost as typeof serviceMock.forwardTaskResultFromHost
  )
  serviceMock.forwardCancelToHost.mockImplementation(
    forwardCancelToHost as typeof serviceMock.forwardCancelToHost
  )
  config.upstreamTimeoutMs = 2_000
  config.wakeMaxHoldMs = 4_000
})

afterEach(async () => {
  config.upstreamTimeoutMs = original.upstreamTimeoutMs
  config.wakeMaxHoldMs = original.wakeMaxHoldMs
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
})

const IDEMPOTENT_GET_ROUTES = [
  {
    label: 'list sessions',
    path: '/rpc/hosts/chatllm/sessions',
    upstreamPath: '/v1/runtime/sessions',
  },
  {
    label: 'session transcript',
    path: '/rpc/hosts/chatllm/sessions/agent-1/chat-1/messages',
    upstreamPath: '/v1/runtime/sessions/agent-1/chat-1/messages',
  },
  {
    label: 'context breakdown',
    path: '/rpc/hosts/chatllm/sessions/agent-1/chat-1/context-breakdown',
    upstreamPath: '/v1/runtime/sessions/agent-1/chat-1/context-breakdown',
  },
  {
    label: 'list models',
    path: '/rpc/hosts/chatllm/models',
    upstreamPath: '/v1/runtime/models',
  },
  {
    label: 'task result',
    path: '/rpc/hosts/chatllm/tasks/task-1/result',
    upstreamPath: '/v1/runtime/tasks/task-1/result',
  },
  {
    label: 'list artifacts',
    path: '/rpc/hosts/chatllm/artifacts',
    upstreamPath: '/v1/runtime/artifacts',
  },
  {
    label: 'artifact download',
    path: '/rpc/hosts/chatllm/artifacts/report.bin/download',
    upstreamPath: '/v1/runtime/artifacts/report.bin/download',
  },
] as const

describe.each(IDEMPOTENT_GET_ROUTES)('R3-M1 $label retries until the hold deadline', route => {
  it('re-issues the read past a second dropped connection and relays the answer', async () => {
    const payload = { route: route.label, ok: true }
    await startUpstream(dropThenAnswer(2, payload))

    const res = await request(makeApp())
      .get(route.path)
      .set('authorization', 'Bearer tok')
      .buffer(true)
      .parse((response, callback) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (text += chunk))
        response.on('end', () => callback(null, text))
      })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual(payload)
    // Witness: two dropped reads and the accepted third one all reached the
    // upstream, and exactly one wake was requested for them.
    expect(seen).toEqual([
      { method: 'GET', url: route.upstreamPath },
      { method: 'GET', url: route.upstreamPath },
      { method: 'GET', url: route.upstreamPath },
    ])
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
  })
})

// Paired control: the same upstream behavior on a mutating route keeps the
// single re-issue (no idempotency key), so the caller gets host_waking with
// exactly two POSTs and the third never happens.
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
  {
    label: 'cancel task',
    path: '/rpc/hosts/chatllm/tasks/task-1/cancel',
    body: {},
    upstreamPath: '/v1/runtime/tasks/task-1/cancel',
  },
] as const

describe.each(MUTATING_ROUTES)('R3-M1 control: $label keeps a single re-issue', route => {
  it('answers host_waking after exactly two POSTs', async () => {
    await startUpstream(dropThenAnswer(2, { applied: true }))

    const res = await request(makeApp())
      .post(route.path)
      .set('authorization', 'Bearer tok')
      .send(route.body)
      .expect(503)

    expect(res.body).toMatchObject({ code: 'host_waking', hostRef: 'chatllm' })
    // Witness: the wake was requested and the re-issue reached the upstream.
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([
      { method: 'POST', url: route.upstreamPath },
      { method: 'POST', url: route.upstreamPath },
    ])
  })
})

// Lateral finding: forwardTaskResultFromHost threw its UpstreamHostError with an
// empty body, so mcp-host's `host_draining` fence was invisible and a draining
// Host answered 502 without a wake.
describe('task result sees the host_draining fence', () => {
  it('wakes and relays the re-issued read after a draining 503', async () => {
    await startUpstream((_req, res, index) => {
      if (index === 0) {
        answerJson(res, 503, { code: 'host_draining' })
        return
      }
      answerJson(res, 200, { taskId: 'task-1', status: 'completed' })
    })

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/tasks/task-1/result')
      .set('authorization', 'Bearer tok')
      .expect(200)

    expect(res.body).toEqual({ taskId: 'task-1', status: 'completed' })
    // Witness: the draining answer was seen, one wake followed, then one retry.
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(seen.map(entry => `${entry.method} ${entry.url}`)).toEqual([
      'GET /v1/runtime/tasks/task-1/result',
      'GET /v1/runtime/tasks/task-1/result',
    ])
  })
})
