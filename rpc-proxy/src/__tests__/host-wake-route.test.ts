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

// The wake route must NEVER poll readiness. forwardHostStatus here is the
// probe the wake-and-hold coordinator polls (wakeAndHold.ts imports it from
// mcpHostRestService directly); mocking the module lets the no-hold test
// prove the pre-warm route never touches it.
const mcpHostRestMock = vi.hoisted(() => ({
  forwardCancelToHost: vi.fn(),
  forwardHostActivity: vi.fn(),
  forwardHostHealth: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  forwardHostStatus: vi.fn(),
  forwardTaskResultFromHost: vi.fn(),
  __test__normalizeHostStatusPayload: vi.fn(),
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
vi.mock('../services/controlApiRestService.js', () => controlApiMock)
vi.mock('../services/mcpHostRestService.js', () => mcpHostRestMock)

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

function postWake(app: express.Express) {
  return request(app).post('/rpc/hosts/chatllm/wake').set('authorization', 'Bearer token')
}

beforeEach(() => {
  vi.clearAllMocks()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
})

describe('POST /rpc/hosts/:hostRef/wake auth', () => {
  it('rejects a token that cannot access :hostRef exactly like the messages route (403) and never calls the wake plane', async () => {
    // Same enforcement point as the messages route: control-api refuses the
    // host resolution for this user/token → resolveHostConnectionForUser null.
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)

    const response = await postWake(makeApp()).expect(403)

    expect(response.body).toEqual({ error: 'Forbidden: user cannot access this host' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('rejects a message-only token missing host:wake:write before resolving the host', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:message:invoke'],
    })

    const response = await postWake(makeApp()).expect(403)

    expect(response.body).toEqual({ error: 'Forbidden: missing scope' })
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})

describe('POST /rpc/hosts/:hostRef/wake control-api passthrough', () => {
  it('200 active is returned verbatim (status + body)', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: 7,
    })

    const response = await postWake(makeApp()).expect(200)

    expect(response.body).toEqual({ status: 'active', wakeGeneration: 7 })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith('chatllm', 'token')
  })

  it('202 wake-requested is returned verbatim (status + body)', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'wake-requested',
      wakeGeneration: 3,
    })

    const response = await postWake(makeApp()).expect(202)

    expect(response.body).toEqual({ status: 'wake-requested', wakeGeneration: 3 })
  })

  it('409 not-stateless is returned verbatim (status + body)', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'not-stateless' })

    const response = await postWake(makeApp()).expect(409)

    expect(response.body).toEqual({ status: 'not-stateless' })
  })

  it('404 unknown host is returned verbatim (status + body)', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'unknown' })

    const response = await postWake(makeApp()).expect(404)

    expect(response.body).toEqual({ status: 'unknown' })
  })

  it('429 rate-limited surfaces Retry-After and the structured body', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'rate-limited',
      retryAfterSeconds: 30,
    })

    const response = await postWake(makeApp()).expect(429)

    expect(response.headers['retry-after']).toBe('30')
    expect(response.body).toEqual({ error: 'Host wake rate limited', retryAfterSeconds: 30 })
  })

  it('a control-api auth rejection is mirrored with its status', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'auth', status: 401 })

    const response = await postWake(makeApp()).expect(401)

    expect(response.body).toEqual({ error: 'Control API rejected the rpc access token' })
  })

  it('an out-of-union wake response kind answers 502 instead of hanging', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({ kind: 'mystery' } as never)

    const response = await postWake(makeApp()).expect(502)

    expect(response.body).toEqual({ error: 'Unhandled wake response' })
  })
})

describe('POST /rpc/hosts/:hostRef/wake failure and no-hold guarantees', () => {
  it('an unreachable control-api responds 502 with a structured error (never a 200, never a hang)', async () => {
    controlApiMock.requestHostWakeFromControlApi.mockRejectedValue(new TypeError('fetch failed'))

    const response = await postWake(makeApp()).expect(502)

    expect(response.body).toEqual({ error: 'Control API host wake unavailable' })
  })

  it('returns immediately after a 202 — exactly one wake call, no readiness polling, no upstream forward', async () => {
    // probeReady (forwardHostStatus) never resolves ready in this file: if the
    // route ever entered the wake-and-hold path this request would park until
    // maxHoldMs and the probe spy would fire. A fire-and-forget route touches
    // neither.
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'wake-requested',
      wakeGeneration: null,
    })

    const response = await postWake(makeApp()).expect(202)

    expect(response.body).toEqual({ status: 'wake-requested' })
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(mcpHostRestMock.forwardHostStatus).not.toHaveBeenCalled()
    expect(serviceMock.forwardHostStatus).not.toHaveBeenCalled()
    expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
  })
})
