import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
import { config } from '../config.js'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter } from '../routes/rpc.js'
import { createRpcHostActivityStreamRouter } from '../routes/rpcHostActivityStream.js'
import { createRpcHostProgressStreamRouter } from '../routes/rpcHostProgressStream.js'
import { createRpcHostStatusStreamRouter } from '../routes/rpcHostStatusStream.js'

// The Host edge assertion through the real rpc-proxy routes. Only the RPC token
// verifier is mocked; the real routers, resolver and control-api client run, and
// the only stubbed boundary is `fetch` (control-api and the Host).

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
vi.mock('../authToken.js', () => authTokenMock)

const USER_ID = 'user-uuid-123'
const EDGE_ASSERTION = 'edge-assertion-fixture'

function claimsWithScopes(scopes: string[]) {
  return {
    sub: USER_ID,
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
  app.use(createRpcHostStatusStreamRouter())
  app.use(createRpcHostActivityStreamRouter())
  app.use(createRpcHostProgressStreamRouter())
  app.use(createRpcRouter())
  app.use(apiErrorHandler)
  return app
}

// The body the base control-api GET route returns: `authorization.connection`
// (control-api/src/routes/rpc-access/users.ts), built by authorizeRpcHostAccess
// as { userId, hostRef, url }. A control-api that predates the edge assertion
// returns exactly this.
const OLD_SHAPE_CONNECTION = {
  userId: USER_ID,
  hostRef: 'chatllm',
  url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
}

type HostCall = { path: string; headers: Record<string, string> }
const originalFetch = globalThis.fetch
let controlApiBody: Record<string, unknown>
let controlApiHostAccessStatus: number
let controlApiCalls: string[]
// When set, answers each control-api Host-access call by its index (0 = the
// route's first resolve); it may throw to simulate a network failure.
let controlApiHostAccessAnswer: ((index: number) => Response) | null
let hostCalls: HostCall[]
// Answers the Host request with the given index (0 = first Host call).
let hostAnswer: (index: number, path: string) => Response

function headersOf(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries())
}

function hostAccessCalls(): string[] {
  return controlApiCalls.filter(url => url.includes('/mcp-hosts/'))
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion: EDGE_ASSERTION }
  controlApiHostAccessStatus = 200
  controlApiCalls = []
  controlApiHostAccessAnswer = null
  hostCalls = []
  hostAnswer = () => jsonResponse(200, {})
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(config.controlApiBaseUrl.replace(/\/+$/, ''))) {
      controlApiCalls.push(url)
      if (url.endsWith('/wake')) return jsonResponse(200, { status: 'active' })
      if (controlApiHostAccessAnswer) {
        return controlApiHostAccessAnswer(hostAccessCalls().length - 1)
      }
      if (controlApiHostAccessStatus !== 200) {
        return jsonResponse(controlApiHostAccessStatus, { error: 'rejected' })
      }
      return jsonResponse(
        200,
        init?.method === 'POST' ? { ...controlApiBody, bindingStatus: 'recorded' } : controlApiBody
      )
    }
    const path = new URL(url).pathname
    // The wake-and-hold readiness probe uses the unguarded Host health route;
    // it is not a guarded Host call.
    if (path === '/v1/runtime/health' && hostCalls.length > 0) {
      return jsonResponse(200, { ok: true })
    }
    hostCalls.push({ path, headers: headersOf(init) })
    return hostAnswer(hostCalls.length - 1, path)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

type RouteRow = {
  label: string
  method: 'get' | 'post' | 'patch'
  path: string
  body?: Record<string, unknown>
  scope: string
  hostPath: string
}

// One row per rpc-proxy route that forwards to a guarded Host route, with the
// scope rpc-proxy requires for it and the Host route it reaches.
const ROUTE_SCOPE_ROWS: RouteRow[] = [
  {
    label: 'status',
    method: 'get',
    path: '/rpc/hosts/chatllm/status',
    scope: 'host:status:read',
    hostPath: '/v1/runtime/status',
  },
  {
    label: 'status stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/status/stream',
    scope: 'host:status:read',
    hostPath: '/v1/runtime/status',
  },
  {
    label: 'activity',
    method: 'get',
    path: '/rpc/hosts/chatllm/activity',
    scope: 'host:activity:read',
    hostPath: '/v1/runtime/activity',
  },
  {
    label: 'activity stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/activity/stream',
    scope: 'host:activity:read',
    hostPath: '/v1/runtime/activity/stream',
  },
  {
    label: 'messages',
    method: 'post',
    path: '/rpc/hosts/chatllm/messages',
    body: { content: 'hi' },
    scope: 'host:message:invoke',
    hostPath: '/v1/runtime/messages',
  },
  {
    label: 'approve',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/approve',
    body: { toolCallId: 'tc-1' },
    scope: 'host:approval:write',
    hostPath: '/v1/runtime/approvals/approve',
  },
  {
    label: 'deny',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/deny',
    body: { toolCallId: 'tc-1' },
    scope: 'host:approval:write',
    hostPath: '/v1/runtime/approvals/deny',
  },
  {
    label: 'sessions',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions',
    scope: 'host:session:read',
    hostPath: '/v1/runtime/sessions',
  },
  {
    label: 'session messages',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/messages',
    scope: 'host:session:read',
    hostPath: '/v1/runtime/sessions/agent-a/chat-1/messages',
  },
  {
    label: 'context breakdown',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/context-breakdown',
    scope: 'host:session:read',
    hostPath: '/v1/runtime/sessions/agent-a/chat-1/context-breakdown',
  },
  {
    label: 'task result',
    method: 'get',
    path: '/rpc/hosts/chatllm/tasks/task-1/result',
    scope: 'host:message:invoke',
    hostPath: '/v1/runtime/tasks/task-1/result',
  },
  {
    label: 'task cancel',
    method: 'post',
    path: '/rpc/hosts/chatllm/tasks/task-1/cancel',
    scope: 'host:message:invoke',
    hostPath: '/v1/runtime/tasks/task-1/cancel',
  },
  {
    label: 'models',
    method: 'get',
    path: '/rpc/hosts/chatllm/models',
    scope: 'host:session:read',
    hostPath: '/v1/runtime/models',
  },
  {
    label: 'set model',
    method: 'post',
    path: '/rpc/hosts/chatllm/model',
    body: { chatId: 'c1', model: 'model-fixture' },
    scope: 'host:model:write',
    hostPath: '/v1/runtime/model',
  },
  {
    label: 'session rename',
    method: 'patch',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/name',
    body: { title: 'renamed' },
    scope: 'host:session:write',
    hostPath: '/v1/runtime/sessions/agent-a/chat-1/name',
  },
  {
    label: 'progress stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/tasks/task-1/progress/stream',
    scope: 'host:activity:read',
    hostPath: '/v1/runtime/tasks/task-1/progress/stream',
  },
  {
    label: 'artifacts list',
    method: 'get',
    path: '/rpc/hosts/chatllm/artifacts',
    scope: 'host:task:read',
    hostPath: '/v1/runtime/artifacts',
  },
  {
    label: 'artifact download',
    method: 'get',
    path: '/rpc/hosts/chatllm/artifacts/report.pdf/download',
    scope: 'host:task:read',
    hostPath: '/v1/runtime/artifacts/report.pdf/download',
  },
]

const ALL_ROUTE_SCOPES = [...new Set(ROUTE_SCOPE_ROWS.map(row => row.scope))]

function send(row: Pick<RouteRow, 'method' | 'path' | 'body'>) {
  const pending = request(makeApp())[row.method](row.path).set('authorization', 'Bearer tok')
  return row.body ? pending.send(row.body) : pending
}

/**
 * Sends the request and waits until it settles or the route has called the
 * Host. An SSE route never completes, so it is aborted once the Host call is
 * observable.
 */
async function sendUntilHostCall(row: RouteRow): Promise<number | null> {
  const pending = send(row)
  let status: number | null = null
  let settled = false
  const completion = pending.then(
    res => {
      status = res.status
      settled = true
    },
    () => {
      settled = true
    }
  )
  const deadline = Date.now() + 2_000
  while (!settled && hostCalls.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (!settled) pending.abort()
  await completion
  return status
}

describe('V1 Host requests carry the control-api edge assertion', () => {
  it('refuses with 500 and calls no Host when control-api returns no edge assertion', async () => {
    controlApiBody = { ...OLD_SHAPE_CONNECTION }
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:status:read']))

    const res = await send(ROUTE_SCOPE_ROWS[0]!)

    // Witness: authorization ran against control-api; the refusal then stopped
    // the request before any Host call.
    expect(controlApiCalls).toHaveLength(1)
    expect(hostCalls).toEqual([])
    expect(res.status).toBe(500)

    // The same request with an assertion in the control-api answer reaches the Host.
    controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion: EDGE_ASSERTION }
    await send(ROUTE_SCOPE_ROWS[0]!)
    expect(controlApiCalls).toHaveLength(2)
    expect(hostCalls).toHaveLength(1)
  })

  it('sends the assertion together with the clear edge headers an older Host still reads', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:status:read']))

    await send(ROUTE_SCOPE_ROWS[0]!)

    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]!.headers).toMatchObject({
      [HOST_EDGE_ASSERTION_HEADER]: EDGE_ASSERTION,
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-user-id': USER_ID,
      'x-clerum-edge-team-id': 'team-1',
      'x-clerum-edge-host-ref': 'chatllm',
    })
    expect(hostCalls[0]!.headers['x-service-token']).toBeUndefined()
    expect(hostCalls[0]!.headers['authorization']).toBeUndefined()
  })
})

describe('route scopes: each rpc-proxy route reaches its Host route only with its scope', () => {
  it.each(ROUTE_SCOPE_ROWS)('$label requires $scope and reaches $hostPath', async row => {
    authTokenMock.verifyRpcToken.mockReturnValue(
      claimsWithScopes(ALL_ROUTE_SCOPES.filter(scope => scope !== row.scope))
    )
    const refused = await send(row)
    expect(refused.status).toBe(403)
    expect(hostCalls).toEqual([])

    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
    await sendUntilHostCall(row)

    // Witness for the refusal above: with exactly the row's scope the same
    // request records one Host call, on the row's Host route, with the assertion.
    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]!.path).toBe(row.hostPath)
    expect(hostCalls[0]!.headers[HOST_EDGE_ASSERTION_HEADER]).toBe(EDGE_ASSERTION)
  })

  it('session search is V2 only: a V1 token with host:session:read gets 403 and no Host call', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:session:read']))

    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/sessions/search?q=hello')
      .set('authorization', 'Bearer tok')

    expect(res.status).toBe(403)
    expect(controlApiCalls).toEqual([])
    expect(hostCalls).toEqual([])

    // Witness: the same token reaches the Host on the V1 sessions route.
    await request(makeApp()).get('/rpc/hosts/chatllm/sessions').set('authorization', 'Bearer tok')
    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]!.path).toBe('/v1/runtime/sessions')
  })
})

const HOST_401 = () => jsonResponse(401, { error: 'Invalid runtime edge assertion' })

function hostDownThen(next: () => Response) {
  return (index: number) => {
    if (index === 0) throw new TypeError('fetch failed')
    return next()
  }
}

// Routes whose Host forwarder throws UpstreamHostError and whose route ends in
// respondUpstreamUnavailable.
const THROWING_FORWARDER_ROWS = ROUTE_SCOPE_ROWS.filter(row =>
  ['messages', 'task result'].includes(row.label)
)

// Routes that hand a failure to the app error handler with next(error).
const NEXT_ERROR_ROWS: RouteRow[] = [
  ROUTE_SCOPE_ROWS.find(row => row.label === 'status')!,
  ROUTE_SCOPE_ROWS.find(row => row.label === 'activity')!,
  {
    label: 'health',
    method: 'get',
    path: '/rpc/hosts/chatllm/health',
    scope: 'host:health:read',
    hostPath: '/v1/runtime/health',
  },
]

describe('authentication failures reach the client as 401', () => {
  it.each(THROWING_FORWARDER_ROWS)(
    '$label: a Host 401 on the first attempt answers 401, not 502',
    async row => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
      hostAnswer = HOST_401

      const res = await send(row)

      expect(hostCalls).toHaveLength(1)
      expect(hostCalls[0]!.path).toBe(row.hostPath)
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Unauthorized' })
    }
  )

  it.each(THROWING_FORWARDER_ROWS)(
    '$label: a Host 401 on the post-wake retry answers 401, not 502',
    async row => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
      hostAnswer = hostDownThen(HOST_401)

      const res = await send(row)

      // Witness: the first attempt failed as Host down, the wake ran, and the
      // retry reached the Host, which refused it.
      expect(controlApiCalls.filter(url => url.endsWith('/wake'))).toHaveLength(1)
      expect(hostCalls).toHaveLength(2)
      expect(hostCalls[1]!.path).toBe(row.hostPath)
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Unauthorized' })
    }
  )

  it.each(NEXT_ERROR_ROWS)('$label: a Host 401 answers 401, not 500', async row => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
    hostAnswer = HOST_401

    const res = await send(row)

    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]!.path).toBe(row.hostPath)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it.each(NEXT_ERROR_ROWS)(
    '$label: a control-api 401 on the Host resolve answers 401, not 500',
    async row => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
      controlApiHostAccessStatus = 401

      const res = await send(row)

      // Witness: the resolve reached control-api; its rejection stopped the
      // request before any Host call.
      expect(controlApiCalls).toHaveLength(1)
      expect(hostCalls).toEqual([])
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Unauthorized' })
    }
  )

  it('wake: a control-api 401 on the Host resolve answers 401, not 500', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:wake:write']))
    controlApiHostAccessStatus = 401

    const res = await request(makeApp())
      .post('/rpc/hosts/chatllm/wake')
      .set('authorization', 'Bearer tok')

    expect(controlApiCalls).toHaveLength(1)
    expect(controlApiCalls[0]).toContain('/mcp-hosts/chatllm')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('status: any other Host failure keeps the 500 answer', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:status:read']))
    hostAnswer = () => jsonResponse(500, { error: 'boom' })

    const res = await send(NEXT_ERROR_ROWS[0]!)

    expect(hostCalls).toHaveLength(1)
    expect(res.status).toBe(500)
  })
})

// A single-attempt route (re-issued at most once after the wake) and a route
// that retries until the hold deadline.
const SINGLE_ATTEMPT_ROW = ROUTE_SCOPE_ROWS.find(row => row.label === 'approve')!
const RETRY_UNTIL_DEADLINE_ROW = ROUTE_SCOPE_ROWS.find(row => row.label === 'task result')!
const REFRESH_ROWS = [SINGLE_ATTEMPT_ROW, RETRY_UNTIL_DEADLINE_ROW]

// The first resolve succeeds; every later Host-access call (a re-resolve before
// a retry attempt) gets `reresolve(index)`.
function firstResolveThen(reresolve: (index: number) => Response) {
  return (index: number) => (index === 0 ? jsonResponse(200, controlApiBody) : reresolve(index))
}

describe('a V1 wake-and-hold retry re-resolves the Host connection', () => {
  const originalWakeMaxHoldMs = config.wakeMaxHoldMs

  beforeEach(() => {
    // Bounds a retry-until-deadline route that keeps failing.
    config.wakeMaxHoldMs = 3_000
  })

  afterEach(() => {
    config.wakeMaxHoldMs = originalWakeMaxHoldMs
  })

  it.each(REFRESH_ROWS)('$label: the retry carries the re-resolved assertion', async row => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
    controlApiHostAccessAnswer = firstResolveThen(index =>
      jsonResponse(200, {
        ...OLD_SHAPE_CONNECTION,
        edgeAssertion: `edge-assertion-refreshed-${index}`,
      })
    )
    hostAnswer = hostDownThen(() => jsonResponse(200, {}))

    const res = await send(row)

    expect(res.status).toBe(200)
    expect(hostAccessCalls()).toHaveLength(2)
    expect(hostAccessCalls().every(url => url.includes('/mcp-hosts/chatllm'))).toBe(true)
    expect(hostCalls).toHaveLength(2)
    expect(hostCalls[0]!.headers[HOST_EDGE_ASSERTION_HEADER]).toBe(EDGE_ASSERTION)
    expect(hostCalls[1]!.path).toBe(row.hostPath)
    expect(hostCalls[1]!.headers[HOST_EDGE_ASSERTION_HEADER]).toBe('edge-assertion-refreshed-1')
  })

  it('task result: every retry attempt re-resolves first (one control-api call per attempt)', async () => {
    const row = RETRY_UNTIL_DEADLINE_ROW
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
    controlApiHostAccessAnswer = firstResolveThen(index =>
      jsonResponse(200, {
        ...OLD_SHAPE_CONNECTION,
        edgeAssertion: `edge-assertion-refreshed-${index}`,
      })
    )
    hostAnswer = index => {
      if (index < 2) throw new TypeError('fetch failed')
      return jsonResponse(200, {})
    }

    const res = await send(row)

    expect(res.status).toBe(200)
    // One first resolve plus one re-resolve per retry attempt (two attempts).
    expect(hostAccessCalls()).toHaveLength(3)
    expect(hostCalls.map(call => call.headers[HOST_EDGE_ASSERTION_HEADER])).toEqual([
      EDGE_ASSERTION,
      'edge-assertion-refreshed-1',
      'edge-assertion-refreshed-2',
    ])
  })

  it.each(REFRESH_ROWS)(
    '$label: a control-api 401 on the re-resolve (expired RPC token) answers 401',
    async row => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
      controlApiHostAccessAnswer = firstResolveThen(() => jsonResponse(401, { error: 'expired' }))
      hostAnswer = hostDownThen(() => jsonResponse(200, {}))

      const res = await send(row)

      // Witness: the first attempt reached the Host and the retry re-resolved.
      expect(hostCalls).toHaveLength(1)
      expect(hostAccessCalls()).toHaveLength(2)
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Unauthorized' })
    }
  )

  const DENIAL_CASES: Array<{ label: string; answer: () => Response }> = [
    { label: 'control-api 403', answer: () => jsonResponse(403, { reason: 'host_disabled' }) },
    { label: 'control-api 404', answer: () => jsonResponse(404, { error: 'not found' }) },
    {
      label: 'a userId mismatch',
      answer: () =>
        jsonResponse(200, {
          ...OLD_SHAPE_CONNECTION,
          userId: 'another-user',
          edgeAssertion: EDGE_ASSERTION,
        }),
    },
  ]

  describe.each(REFRESH_ROWS)('$label', row => {
    it.each(DENIAL_CASES)(
      'a re-resolve denied by $label answers what the first resolve answers',
      async ({ answer }) => {
        authTokenMock.verifyRpcToken.mockReturnValue(
          claimsWithScopes([row.scope, 'host:wake:write'])
        )
        // The route's answer when its first resolve gets the same control-api answer.
        controlApiHostAccessAnswer = () => answer()
        const firstResolveDenied = await send(row)
        expect(hostCalls).toEqual([])
        expect(firstResolveDenied.status).not.toBe(200)

        controlApiCalls = []
        controlApiHostAccessAnswer = firstResolveThen(answer)
        hostAnswer = hostDownThen(() => jsonResponse(200, {}))

        const res = await send(row)

        expect(hostCalls).toHaveLength(1)
        expect(hostAccessCalls()).toHaveLength(2)
        expect(res.status).toBe(firstResolveDenied.status)
        expect(res.body).toEqual(firstResolveDenied.body)
      }
    )
  })

  it.each(REFRESH_ROWS)('$label: a re-resolve that moves the Host URL answers 502', async row => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
    controlApiHostAccessAnswer = firstResolveThen(() =>
      jsonResponse(200, {
        ...OLD_SHAPE_CONNECTION,
        url: 'http://other.mcp-host.svc.cluster.local:8080',
        edgeAssertion: EDGE_ASSERTION,
      })
    )
    hostAnswer = hostDownThen(() => jsonResponse(200, {}))

    const res = await send(row)

    expect(hostCalls).toHaveLength(1)
    expect(hostAccessCalls()).toHaveLength(2)
    expect(res.status).toBe(502)
  })

  const UNAVAILABLE_CASES: Array<{ label: string; answer: () => Response }> = [
    {
      label: 'a network failure',
      answer: () => {
        throw new TypeError('fetch failed')
      },
    },
    {
      label: 'a timeout',
      answer: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
    },
    { label: 'a control-api 503', answer: () => jsonResponse(503, { error: 'unavailable' }) },
    {
      label: 'a 200 without an edge assertion',
      answer: () => jsonResponse(200, { ...OLD_SHAPE_CONNECTION }),
    },
  ]

  describe.each(REFRESH_ROWS)('$label', row => {
    it.each(UNAVAILABLE_CASES)(
      'a re-resolve that fails with $label answers 503 authority_unavailable at once',
      async ({ answer }) => {
        authTokenMock.verifyRpcToken.mockReturnValue(
          claimsWithScopes([row.scope, 'host:wake:write'])
        )
        controlApiHostAccessAnswer = firstResolveThen(answer)
        hostAnswer = hostDownThen(() => jsonResponse(200, {}))

        const res = await send(row)

        // Witness: the first attempt reached the Host. No Host call and no
        // further control-api call follow the failed re-resolve.
        expect(hostCalls).toHaveLength(1)
        expect(hostCalls[0]!.path).toBe(row.hostPath)
        expect(hostAccessCalls()).toHaveLength(2)
        expect(res.status).toBe(503)
        expect(res.body).toEqual({ error: 'authority_unavailable' })
      }
    )
  })
})
