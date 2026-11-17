import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../config.js'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter } from '../routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
}))
const controlApiMock = vi.hoisted(() => ({
  requestHostWakeFromControlApi: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)
vi.mock('../services/controlApiRestService.js', () => controlApiMock)

// Same scope as rename. Wake rides on the token, copied from approve, so the
// happy path carries only host:session:write.
const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:session:write'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

// Edge identity headers are the trust boundary: mcp-host trusts
// x-clerum-edge-user-id (set by the proxy from auth.sub) and rejects any
// client Authorization. The route forwards ONLY host.headers.
const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-123',
  },
}

const MODE_PATH = '/rpc/hosts/chatllm/sessions/chatllm/c1/approval-mode'
const UPSTREAM_MODE_URL = 'http://chatllm:8080/v1/runtime/sessions/chatllm/c1/approval-mode'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  app.use(apiErrorHandler)
  return app
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const originalFetch = globalThis.fetch
const originalUpstreamTimeoutMs = config.upstreamTimeoutMs

describe('PATCH /rpc/hosts/:hostRef/sessions/:agent/:chatId/approval-mode', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
    controlApiMock.requestHostWakeFromControlApi.mockResolvedValue({
      kind: 'active',
      wakeGeneration: null,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
    config.upstreamTimeoutMs = originalUpstreamTimeoutMs
  })

  it('forwards PATCH with the edge user and only the validated mode', async () => {
    const upstream = {
      approvalMode: 'auto',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'auto',
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, upstream))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'auto', userId: 'attacker-sub', title: 'ignored' })
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
      VALID_CLAIMS.sub,
      'chatllm',
      'user-token',
      { teamId: 'team-1' }
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(UPSTREAM_MODE_URL)
    expect((init as RequestInit).method).toBe('PATCH')
    expect((init as RequestInit).headers).toMatchObject(HOST_CONNECTION.headers)
    expect((init as RequestInit).headers).not.toHaveProperty('authorization')
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization')
    expect((init as RequestInit).headers).toMatchObject({
      'x-clerum-edge-user-id': VALID_CLAIMS.sub,
    })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ mode: 'auto' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it.each(['manual', 'allow_all'] as const)('forwards mode %s', async mode => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { approvalMode: mode }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ mode })
      .expect(200)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ mode })
  })

  it('returns 401 when no caller is presented', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp()).patch(MODE_PATH).send({ mode: 'auto' }).expect(401)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    { mode: 'yolo' },
    { mode: 'allow-all' },
    { mode: 'AUTO' },
    { mode: '' },
    { mode: null },
    { mode: 1 },
    {},
    { title: 'not a mode' },
    { mode: ['auto'] },
  ])('returns 400 for %j and does not call the host', async body => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send(body)
      .expect(400)

    expect(res.body).toEqual({ error: 'mode must be manual, auto, or allow_all' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-object body and does not call the host', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send(['auto'])
      .expect(400)

    expect(res.body).toEqual({ error: 'mode must be manual, auto, or allow_all' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 403 when the token lacks host:session:write', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:session:read'],
    })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'auto' })
      .expect(403)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns 403 when the user cannot access the host', async () => {
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      denied: true,
      code: 'host_access_denied',
    })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch('/rpc/hosts/other-host/sessions/chatllm/c1/approval-mode')
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'manual' })
      .expect(403)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    '/rpc/hosts/chatllm/sessions/agent%3Aother/c1/approval-mode',
    '/rpc/hosts/chatllm/sessions/agent%0Aother/c1/approval-mode',
    '/rpc/hosts/chatllm/sessions/agent/chat%0Aother/approval-mode',
    '/rpc/hosts/chat%2Fllm/sessions/chatllm/c1/approval-mode',
  ])('rejects unsafe route segments before forwarding upstream: %s', async path => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch(path)
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'auto' })
      .expect(400)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    { status: 400, body: { error: 'invalid mode' } },
    { status: 404, body: { error: 'session not found' } },
  ])('propagates the upstream $status verbatim', async ({ status, body }) => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(status, body)) as unknown as typeof fetch

    const res = await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'manual' })
      .expect(status)

    expect(res.body).toEqual(body)
  })

  it('maps a host-down failure without host:wake:write to 502 and does not wake', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch

    const res = await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'auto' })
      .expect(502)

    expect(res.body).toEqual({ error: 'Upstream host unavailable' })
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })

  it('wakes and retries the upstream once when the token has host:wake:write', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:session:write', 'host:wake:write'],
    })
    const upstream = {
      approvalMode: 'allow_all',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'allow_all',
    }
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, upstream))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'allow_all' })
      .expect(200)

    expect(res.body).toEqual(upstream)
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledTimes(1)
    expect(controlApiMock.requestHostWakeFromControlApi).toHaveBeenCalledWith(
      'chatllm',
      'user-token'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as [unknown, RequestInit]
      expect(String(url)).toBe(UPSTREAM_MODE_URL)
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(init.body as string)).toEqual({ mode: 'allow_all' })
      expect(init.headers).toMatchObject({
        'x-clerum-edge-user-id': VALID_CLAIMS.sub,
      })
    }
  })

  it('sends the first attempt without a client-side deadline', async () => {
    config.upstreamTimeoutMs = 20
    let firstSignal: AbortSignal | undefined
    let abortedWhenAnswered: boolean | undefined
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      firstSignal = init.signal as AbortSignal
      await new Promise(resolve => setTimeout(resolve, config.upstreamTimeoutMs * 3))
      abortedWhenAnswered = firstSignal.aborted
      return jsonResponse(200, { approvalMode: 'manual' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .patch(MODE_PATH)
      .set('authorization', 'Bearer user-token')
      .send({ mode: 'manual' })
      .expect(200)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(firstSignal).toBeInstanceOf(AbortSignal)
    expect(abortedWhenAnswered).toBe(false)
    expect(controlApiMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
  })
})
