import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_CLAIM_TYPE,
  HOST_EDGE_ASSERTION_HEADER,
  HOST_EDGE_ASSERTION_JWT_TYPE,
  HOST_EDGE_RPC_PROXY_ROUTE_SCOPES,
  type HostEdgeRpcProxyRoute,
} from '@clerum/action-context-contracts'
import { config } from '../config.js'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter } from '../routes/rpc.js'
import {
  createRpcHostActivityStreamRouter,
  resetHostActivityStreamRuntimeForTests,
} from '../routes/rpcHostActivityStream.js'
import { createRpcHostProgressStreamRouter } from '../routes/rpcHostProgressStream.js'
import {
  createRpcHostStatusStreamRouter,
  resetHostStatusStreamRuntimeForTests,
} from '../routes/rpcHostStatusStream.js'
import { refreshV1HostConnection } from '../services/mcpProxyService.js'

// The Host edge assertion through the real rpc-proxy routes. Only the RPC token
// verifier is mocked; the real routers, resolver and control-api client run, and
// the only stubbed boundary is `fetch` (control-api and the Host).

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
vi.mock('../authToken.js', () => authTokenMock)

const USER_ID = 'user-uuid-123'
// The assertion the default control-api answer carries, signed per test with
// `exp` far from now (see `signEdgeAssertion`), so a wake-and-hold retry reuses
// it without a re-resolve.
let edgeAssertion: string

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

type HostCall = { method: string; path: string; headers: Record<string, string> }
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
  edgeAssertion = signEdgeAssertion(Math.floor(Date.now() / 1000) + 300, [])
  controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion }
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
    hostCalls.push({ method: init?.method ?? 'GET', path, headers: headersOf(init) })
    return hostAnswer(hostCalls.length - 1, path)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

type RequestRow = {
  label: string
  method: 'get' | 'post' | 'patch'
  path: string
  body?: Record<string, unknown>
  scope: string
  hostPath: string
}

type RouteRow = RequestRow & { hostRoute: HostEdgeRpcProxyRoute }

// One row per rpc-proxy route that forwards to a guarded Host route, with the
// Host route it reaches. Its scope is that Host route's row of the edge scope
// map, the scope rpc-proxy requires for it.
const HOST_ROUTE_ROWS: Array<Omit<RouteRow, 'scope'>> = [
  {
    label: 'status',
    method: 'get',
    path: '/rpc/hosts/chatllm/status',
    hostRoute: 'GET /v1/runtime/status',
    hostPath: '/v1/runtime/status',
  },
  {
    label: 'status stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/status/stream',
    hostRoute: 'GET /v1/runtime/status',
    hostPath: '/v1/runtime/status',
  },
  {
    label: 'activity',
    method: 'get',
    path: '/rpc/hosts/chatllm/activity',
    hostRoute: 'GET /v1/runtime/activity',
    hostPath: '/v1/runtime/activity',
  },
  {
    label: 'activity stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/activity/stream',
    hostRoute: 'GET /v1/runtime/activity/stream',
    hostPath: '/v1/runtime/activity/stream',
  },
  {
    label: 'messages',
    method: 'post',
    path: '/rpc/hosts/chatllm/messages',
    body: { content: 'hi' },
    hostRoute: 'POST /v1/runtime/messages',
    hostPath: '/v1/runtime/messages',
  },
  {
    label: 'approve',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/approve',
    body: { toolCallId: 'tc-1' },
    hostRoute: 'POST /v1/runtime/approvals/approve',
    hostPath: '/v1/runtime/approvals/approve',
  },
  {
    label: 'deny',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/deny',
    body: { toolCallId: 'tc-1' },
    hostRoute: 'POST /v1/runtime/approvals/deny',
    hostPath: '/v1/runtime/approvals/deny',
  },
  {
    label: 'sessions',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions',
    hostRoute: 'GET /v1/runtime/sessions',
    hostPath: '/v1/runtime/sessions',
  },
  {
    label: 'session messages',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/messages',
    hostRoute: 'GET /v1/runtime/sessions/:agent/:chatId/messages',
    hostPath: '/v1/runtime/sessions/agent-a/chat-1/messages',
  },
  {
    label: 'context breakdown',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/context-breakdown',
    hostRoute: 'GET /v1/runtime/sessions/:agent/:chatId/context-breakdown',
    hostPath: '/v1/runtime/sessions/agent-a/chat-1/context-breakdown',
  },
  {
    label: 'task result',
    method: 'get',
    path: '/rpc/hosts/chatllm/tasks/task-1/result',
    hostRoute: 'GET /v1/runtime/tasks/:taskId/result',
    hostPath: '/v1/runtime/tasks/task-1/result',
  },
  {
    label: 'task cancel',
    method: 'post',
    path: '/rpc/hosts/chatllm/tasks/task-1/cancel',
    hostRoute: 'POST /v1/runtime/tasks/:taskId/cancel',
    hostPath: '/v1/runtime/tasks/task-1/cancel',
  },
  {
    label: 'models',
    method: 'get',
    path: '/rpc/hosts/chatllm/models',
    hostRoute: 'GET /v1/runtime/models',
    hostPath: '/v1/runtime/models',
  },
  {
    label: 'set model',
    method: 'post',
    path: '/rpc/hosts/chatllm/model',
    body: { chatId: 'c1', model: 'model-fixture' },
    hostRoute: 'POST /v1/runtime/model',
    hostPath: '/v1/runtime/model',
  },
  {
    label: 'session rename',
    method: 'patch',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/name',
    body: { title: 'renamed' },
    hostRoute: 'PATCH /v1/runtime/sessions/:agent/:chatId/name',
    hostPath: '/v1/runtime/sessions/agent-a/chat-1/name',
  },
  {
    label: 'progress stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/tasks/task-1/progress/stream',
    hostRoute: 'GET /v1/runtime/tasks/:taskId/progress/stream',
    hostPath: '/v1/runtime/tasks/task-1/progress/stream',
  },
  {
    label: 'artifacts list',
    method: 'get',
    path: '/rpc/hosts/chatllm/artifacts',
    hostRoute: 'GET /v1/runtime/artifacts',
    hostPath: '/v1/runtime/artifacts',
  },
  {
    label: 'artifact download',
    method: 'get',
    path: '/rpc/hosts/chatllm/artifacts/report.pdf/download',
    hostRoute: 'GET /v1/runtime/artifacts/:filename/download',
    hostPath: '/v1/runtime/artifacts/report.pdf/download',
  },
]

const ROUTE_SCOPE_ROWS: RouteRow[] = HOST_ROUTE_ROWS.map(row => ({
  ...row,
  scope: HOST_EDGE_RPC_PROXY_ROUTE_SCOPES[row.hostRoute],
}))

const ALL_ROUTE_SCOPES = [...new Set(ROUTE_SCOPE_ROWS.map(row => row.scope))]

// The path of a map key (for example `/v1/runtime/sessions/:agent/:chatId/name`)
// as a regular expression in which each `:param` matches one path segment.
function hostRoutePathPattern(routePath: string): RegExp {
  const segments = routePath
    .split('/')
    .map(segment =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
  return new RegExp(`^${segments.join('/')}$`)
}

function send(row: Pick<RouteRow, 'method' | 'path' | 'body'>) {
  const pending = request(makeApp())[row.method](row.path).set('authorization', 'Bearer tok')
  return row.body ? pending.send(row.body) : pending
}

/**
 * Sends the request and waits until it settles or the route has called the
 * Host. An SSE route never completes, so it is aborted once the Host call is
 * observable.
 */
async function sendUntilHostCall(
  row: Pick<RouteRow, 'method' | 'path' | 'body'>
): Promise<number | null> {
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

// Every V1 route whose first resolve asks control-api for the Host connection:
// the route-scope rows plus wake, approval mode and health. Session search is V2
// only and never asks control-api (the session search test below).
// `hostPath` is null for wake, which calls control-api's wake and never the Host.
type FirstResolveRow = Omit<RequestRow, 'hostPath'> & { hostPath: string | null }
const FIRST_RESOLVE_ROWS: FirstResolveRow[] = [
  ...ROUTE_SCOPE_ROWS,
  {
    label: 'wake',
    method: 'post',
    path: '/rpc/hosts/chatllm/wake',
    scope: 'host:wake:write',
    hostPath: null,
  },
  {
    label: 'approval mode',
    method: 'patch',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/approval-mode',
    body: { mode: 'auto' },
    scope:
      HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['PATCH /v1/runtime/sessions/:agent/:chatId/approval-mode'],
    hostPath: '/v1/runtime/sessions/agent-a/chat-1/approval-mode',
  },
  {
    label: 'health',
    method: 'get',
    path: '/rpc/hosts/chatllm/health',
    scope: 'host:health:read',
    hostPath: '/v1/runtime/health',
  },
]

const MISSING_ASSERTION_LOG_PREFIX =
  '[RPC_PROXY] control-api answered the host resolve without an edge assertion'

describe('V1 Host requests carry the control-api edge assertion', () => {
  it.each(FIRST_RESOLVE_ROWS)(
    '$label: control-api without an edge assertion answers 503 authority_unavailable and calls no Host',
    async row => {
      controlApiBody = { ...OLD_SHAPE_CONNECTION }
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      const res = await send(row)

      // Witness: authorization ran against control-api once (and, for wake,
      // control-api's wake was never asked); the refusal then stopped the
      // request before any Host call.
      expect(hostAccessCalls()).toHaveLength(1)
      expect(controlApiCalls).toHaveLength(1)
      expect(hostCalls).toEqual([])
      expect(res.status).toBe(503)
      // Exactly this body: the internal message is not echoed.
      expect(res.body).toEqual({ error: 'authority_unavailable' })
      // The cause is logged once, by the resolver, without the token or the user.
      const causeLines = warn.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith(MISSING_ASSERTION_LOG_PREFIX))
      expect(causeLines).toHaveLength(1)
      expect(causeLines[0]).toContain('host=chatllm')
      expect(causeLines[0]).not.toContain(USER_ID)
      expect(causeLines[0]).not.toContain('Bearer')
      expect(causeLines[0]).not.toMatch(/\btok\b/)
      warn.mockRestore()

      // The same request with an assertion in the control-api answer goes through.
      controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion }
      if (row.hostPath === null) {
        const woken = await send(row)
        expect(woken.status).toBe(200)
        expect(controlApiCalls.filter(url => url.endsWith('/wake'))).toHaveLength(1)
        expect(hostCalls).toEqual([])
      } else {
        await sendUntilHostCall(row)
        expect(hostCalls).toHaveLength(1)
        expect(hostCalls[0]!.path).toBe(row.hostPath)
      }
      expect(hostAccessCalls()).toHaveLength(2)
    }
  )

  it('sends the assertion together with the clear edge headers an older Host still reads', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:status:read']))

    await send(ROUTE_SCOPE_ROWS[0]!)

    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]!.headers).toMatchObject({
      [HOST_EDGE_ASSERTION_HEADER]: edgeAssertion,
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
    expect(hostCalls[0]!.headers[HOST_EDGE_ASSERTION_HEADER]).toBe(edgeAssertion)
    // The call is the map row's Host route: same method, and a path that
    // matches the route with one segment per `:param`.
    const [hostMethod, hostRoutePath] = row.hostRoute.split(' ')
    expect(hostCalls[0]!.method).toBe(hostMethod)
    expect(hostCalls[0]!.path).toMatch(hostRoutePathPattern(hostRoutePath!))
  })

  it('every map row has a route test', () => {
    const covered = new Set<string>([
      ...ROUTE_SCOPE_ROWS.map(row => row.hostRoute),
      // Covered in host-edge-route-scope-map.test.ts and
      // session-approval-mode-passthrough.test.ts.
      'PATCH /v1/runtime/sessions/:agent/:chatId/approval-mode',
      // V2 only: the session search test below.
      'GET /v1/runtime/sessions/search',
    ])

    expect([...covered].sort()).toEqual(Object.keys(HOST_EDGE_RPC_PROXY_ROUTE_SCOPES).sort())
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
const NEXT_ERROR_ROWS: RequestRow[] = [
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

  it.each(NEXT_ERROR_ROWS)('$label: a Host 500 answers 500 without the Host body', async row => {
    const marker = 'host-internal-detail-7f3a'
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
    hostAnswer = () => jsonResponse(500, { error: marker })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const res = await send(row)

      // Witness: the Host was asked once and its failure reached the app
      // error handler, which logged it by name and status only.
      expect(hostCalls).toHaveLength(1)
      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'Internal Server Error' })
      expect(res.text).not.toContain(marker)
      const lines = logged.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[RPC_PROXY] unhandled route error '))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('error=UpstreamHostError status=500')
      expect(lines[0]).not.toContain(marker)
    } finally {
      logged.mockRestore()
    }
  })
})

// Two row sets for the V1 re-resolve before a wake-and-hold retry.
// V1_WAKE_ROWS: every route of this file that retries through wake-and-hold
// with the V1 refresh, each passing its own denial answer for a denied
// re-resolve; the approval-mode PATCH is covered in
// session-approval-mode-passthrough.test.ts. They run the re-resolved
// assertion case and one denial case.
// REFRESH_ROWS: a single-attempt route (re-issued at most once after the wake)
// and a route that retries until the hold deadline. They run the cases of the
// shared re-resolve and wake-and-hold code: the other denials, the 401, the
// Host URL move and the unavailable answers.
const SINGLE_ATTEMPT_ROW = ROUTE_SCOPE_ROWS.find(row => row.label === 'approve')!
const RETRY_UNTIL_DEADLINE_ROW = ROUTE_SCOPE_ROWS.find(row => row.label === 'task result')!
const REFRESH_ROWS = [SINGLE_ATTEMPT_ROW, RETRY_UNTIL_DEADLINE_ROW]
const V1_WAKE_ROW_LABELS = [
  'messages',
  'approve',
  'deny',
  'sessions',
  'session messages',
  'context breakdown',
  'models',
  'set model',
  'task result',
  'task cancel',
  'artifacts list',
  'artifact download',
]
const V1_WAKE_ROWS = V1_WAKE_ROW_LABELS.map(label => {
  const row = ROUTE_SCOPE_ROWS.find(candidate => candidate.label === label)
  if (!row) throw new Error(`no route row labelled ${label}`)
  return row
})

// The first resolve succeeds; every later Host-access call (a re-resolve before
// a retry attempt) gets `reresolve(index)`.
function firstResolveThen(reresolve: (index: number) => Response) {
  return (index: number) => (index === 0 ? jsonResponse(200, controlApiBody) : reresolve(index))
}

// An `exp` inside the re-resolve margin (`upstreamTimeoutMs` plus 2 s), built
// from the same config the code reads.
function nearExpSeconds(): number {
  return Math.floor(Date.now() / 1000) + Math.floor(config.upstreamTimeoutMs / 1000)
}

describe('a V1 wake-and-hold retry re-resolves the Host connection near the assertion exp', () => {
  const originalWakeMaxHoldMs = config.wakeMaxHoldMs

  beforeEach(() => {
    // Bounds a retry-until-deadline route that keeps failing.
    config.wakeMaxHoldMs = 3_000
    // The first resolve's assertion is within the margin of its exp, so the
    // retry re-resolves it.
    edgeAssertion = signEdgeAssertion(nearExpSeconds(), [])
    controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion }
  })

  afterEach(() => {
    config.wakeMaxHoldMs = originalWakeMaxHoldMs
  })

  it.each(V1_WAKE_ROWS)('$label: the retry carries the re-resolved assertion', async row => {
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
    // Witness: the first attempt failed as Host down and the wake ran once.
    expect(controlApiCalls.filter(url => url.endsWith('/wake'))).toHaveLength(1)
    expect(hostAccessCalls()).toHaveLength(2)
    expect(hostAccessCalls().every(url => url.includes('/mcp-hosts/chatllm'))).toBe(true)
    expect(hostCalls).toHaveLength(2)
    expect(hostCalls[0]!.headers[HOST_EDGE_ASSERTION_HEADER]).toBe(edgeAssertion)
    expect(hostCalls[1]!.path).toBe(row.hostPath)
    expect(hostCalls[1]!.headers[HOST_EDGE_ASSERTION_HEADER]).toBe('edge-assertion-refreshed-1')
  })

  it('task result: each retry re-resolves while the held assertion is within the margin of exp', async () => {
    const row = RETRY_UNTIL_DEADLINE_ROW
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
    // Re-resolved assertions are near their exp too, so every retry re-resolves.
    const refreshed = [1, 2].map(() => signEdgeAssertion(nearExpSeconds(), []))
    controlApiHostAccessAnswer = firstResolveThen(index =>
      jsonResponse(200, {
        ...OLD_SHAPE_CONNECTION,
        edgeAssertion: refreshed[index - 1],
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
      edgeAssertion,
      refreshed[0],
      refreshed[1],
    ])
  })

  it('task result: retries make no control-api call while the held assertion is far from exp', async () => {
    const row = RETRY_UNTIL_DEADLINE_ROW
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
    edgeAssertion = signEdgeAssertion(Math.floor(Date.now() / 1000) + 300, [])
    controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion }
    hostAnswer = index => {
      if (index < 2) throw new TypeError('fetch failed')
      return jsonResponse(200, {})
    }

    const res = await send(row)

    expect(res.status).toBe(200)
    // Witness: the wake ran and both retries reached the Host, each with the
    // held assertion.
    expect(controlApiCalls.filter(url => url.endsWith('/wake'))).toHaveLength(1)
    expect(hostCalls.map(call => call.headers[HOST_EDGE_ASSERTION_HEADER])).toEqual([
      edgeAssertion,
      edgeAssertion,
      edgeAssertion,
    ])
    expect(hostCalls[2]!.path).toBe(row.hostPath)
    // Only the route's first resolve called control-api.
    expect(hostAccessCalls()).toHaveLength(1)
  })

  it('approve: a held assertion with no readable exp answers 502 and makes no second control-api call', async () => {
    const row = SINGLE_ATTEMPT_ROW
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
    edgeAssertion = 'edge-assertion-without-exp-fixture'
    controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion }
    hostAnswer = hostDownThen(() => jsonResponse(200, {}))

    const res = await send(row)

    // Witness: the first attempt reached the Host as Host down and the wake ran,
    // so the retry's refresh read the held assertion.
    expect(controlApiCalls.filter(url => url.endsWith('/wake'))).toHaveLength(1)
    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]!.headers[HOST_EDGE_ASSERTION_HEADER]).toBe(edgeAssertion)
    expect(hostAccessCalls()).toHaveLength(1)
    expect(res.status).toBe(502)
  })

  it.each(REFRESH_ROWS)(
    '$label: a control-api 401 on the re-resolve (expired RPC token) answers 401',
    async row => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
      controlApiHostAccessAnswer = firstResolveThen(() => jsonResponse(401, { error: 'expired' }))
      hostAnswer = hostDownThen(() => jsonResponse(200, {}))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      const res = await send(row)

      // Witness: the first attempt reached the Host and the retry re-resolved.
      expect(hostCalls).toHaveLength(1)
      expect(hostAccessCalls()).toHaveLength(2)
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Unauthorized' })
      // The rejection is an answer, not a failed retry: the hold loop logs nothing.
      const retryLines = warn.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('[RPC_PROXY] wake-hold'))
      expect(retryLines).toEqual([])
      warn.mockRestore()
    }
  )

  type DenialCase = { label: string; answer: () => Response }
  // Runs on every V1 wake row: each route passes its own denial answer.
  const ROUTE_DENIAL_CASES: DenialCase[] = [
    { label: 'control-api 403', answer: () => jsonResponse(403, { reason: 'host_disabled' }) },
  ]
  // Run on REFRESH_ROWS: the other denials the shared re-resolve code maps.
  const SHARED_DENIAL_CASES: DenialCase[] = [
    { label: 'control-api 404', answer: () => jsonResponse(404, { error: 'not found' }) },
    {
      label: 'a userId mismatch',
      answer: () =>
        jsonResponse(200, {
          ...OLD_SHAPE_CONNECTION,
          userId: 'another-user',
          edgeAssertion,
        }),
    },
  ]

  describe.each([
    ...V1_WAKE_ROWS.map(row => ({ ...row, cases: ROUTE_DENIAL_CASES })),
    ...REFRESH_ROWS.map(row => ({ ...row, cases: SHARED_DENIAL_CASES })),
  ])('$label', ({ cases, ...row }) => {
    it.each(cases)(
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
        edgeAssertion,
      })
    )
    hostAnswer = hostDownThen(() => jsonResponse(200, {}))

    const res = await send(row)

    expect(hostCalls).toHaveLength(1)
    expect(hostAccessCalls()).toHaveLength(2)
    expect(res.status).toBe(502)
  })

  const UNAVAILABLE_CASES: Array<{
    label: string
    answer: () => Response
    status: number
    body: Record<string, unknown>
  }> = [
    {
      label: 'a network failure',
      answer: () => {
        throw new TypeError('fetch failed')
      },
      status: 503,
      body: { error: 'authority_unavailable' },
    },
    {
      label: 'a timeout',
      answer: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
      status: 504,
      body: { error: 'Gateway Timeout' },
    },
    {
      label: 'a control-api 503',
      answer: () => jsonResponse(503, { error: 'unavailable' }),
      status: 503,
      body: { error: 'authority_unavailable' },
    },
    {
      label: 'a 200 without an edge assertion',
      answer: () => jsonResponse(200, { ...OLD_SHAPE_CONNECTION }),
      status: 503,
      body: { error: 'authority_unavailable' },
    },
  ]

  describe.each(REFRESH_ROWS)('$label', row => {
    it.each(UNAVAILABLE_CASES)(
      'a re-resolve that fails with $label answers $status at once',
      async ({ answer, status, body }) => {
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
        expect(res.status).toBe(status)
        expect(res.body).toEqual(body)
      }
    )
  })

  it('a failed re-resolve logs the hostRef without control characters', async () => {
    // Called directly: every route validates hostRef against HOST_REF_RE first,
    // so no request can carry a control character this far.
    controlApiHostAccessAnswer = () => {
      throw new TypeError('fetch failed')
    }
    const host = {
      name: 'chatllm',
      url: OLD_SHAPE_CONNECTION.url,
      headers: { [HOST_EDGE_ASSERTION_HEADER]: signEdgeAssertion(nearExpSeconds(), []) },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(
        refreshV1HostConnection(host, USER_ID, 'chat\r\nllm\tforged', 'rpc-access-token')
      ).resolves.toEqual({ unavailable: true, cause: 'request_failed' })

      // Exactly one line: it is also the witness that the failure path ran.
      const lines = warn.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[RPC_PROXY] control-api host resolve unavailable'))
      expect(lines).toEqual([
        '[RPC_PROXY] control-api host resolve unavailable phase=re-resolve host=chatllmforged cause=request_failed error=TypeError',
      ])
    } finally {
      warn.mockRestore()
    }
  })
})

// A V1 assertion built the way control-api signs it (RS256, the assertion JWT
// type, the Host runtime audience), so the Host stub below decides on its real
// `exp` and not on a hand-typed marker.
const EDGE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })

function signEdgeAssertion(expSeconds: number, scopes: string[]): string {
  return jwt.sign(
    {
      typ: HOST_EDGE_ASSERTION_CLAIM_TYPE,
      v: 1,
      iss: 'control-api',
      sub: USER_ID,
      host: `${config.hostNamespace}/chatllm`,
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: expSeconds,
      teamId: 'team-1',
      scopes,
    },
    EDGE_KEYS.privateKey,
    {
      algorithm: 'RS256',
      audience: HOST_EDGE_ASSERTION_AUDIENCE,
      header: { alg: 'RS256', typ: HOST_EDGE_ASSERTION_JWT_TYPE },
    }
  )
}

type HostVerdict = { at: number; status: number }

/**
 * The Host's check of the assertion at instant `at`: signature, audience and
 * expiry. An expired assertion gets the Host's 401; any other verification
 * failure is a broken fixture and fails the test.
 */
function hostChecksAssertion(headers: Record<string, string>, at: number): Response | null {
  try {
    jwt.verify(headers[HOST_EDGE_ASSERTION_HEADER] ?? '', EDGE_KEYS.publicKey, {
      algorithms: ['RS256'],
      audience: HOST_EDGE_ASSERTION_AUDIENCE,
      clockTimestamp: Math.floor(at / 1000),
    })
    return null
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenExpiredError') return HOST_401()
    throw error
  }
}

describe('streams and the assertion expiry', () => {
  const originalStreamIntervalMs = config.streamIntervalMs
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    config.streamIntervalMs = 100
    resetHostStatusStreamRuntimeForTests()
    resetHostActivityStreamRuntimeForTests()
    server = makeApp().listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    config.streamIntervalMs = originalStreamIntervalMs
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  // Reads the SSE response through the real HTTP server until `done` holds.
  async function readStream(path: string, done: (text: string) => boolean): Promise<string> {
    const controller = new AbortController()
    const res = await originalFetch(`${baseUrl}${path}`, {
      headers: { authorization: 'Bearer tok' },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!done(text)) {
      const { value, done: ended } = await reader.read()
      if (ended) break
      text += decoder.decode(value, { stream: true })
    }
    controller.abort()
    return text
  }

  // The Host answers a status poll as it would at that instant: 401 once the
  // assertion has expired, a valid status payload before.
  function statusHostRecordingVerdicts(verdicts: HostVerdict[]) {
    return (index: number) => {
      const at = Date.now()
      const answer =
        hostChecksAssertion(hostCalls[index]!.headers, at) ??
        jsonResponse(200, { agent: { state: 'idle' }, queue: { pending: 0 } })
      verdicts.push({ at, status: answer.status })
      return answer
    }
  }

  it('status stream: polls succeed, then it ends with auth-expired before the assertion exp and no poll is refused', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:status:read']))
    // Outside the near-expiry window (`upstreamTimeoutMs` plus 2 s) for 2 to 3 s.
    const expSeconds =
      Math.floor(Date.now() / 1000) + Math.floor(config.upstreamTimeoutMs / 1000) + 5
    controlApiBody = {
      ...OLD_SHAPE_CONNECTION,
      edgeAssertion: signEdgeAssertion(expSeconds, ['host:status:read']),
    }
    const verdicts: HostVerdict[] = []
    hostAnswer = statusHostRecordingVerdicts(verdicts)

    const text = await readStream('/rpc/hosts/chatllm/status/stream', body =>
      body.includes('event: closed')
    )
    const closedAt = Date.now()

    const accepted = verdicts.filter(verdict => verdict.status === 200)
    const refused = verdicts.filter(verdict => verdict.status === 401)
    // Witness: polls reached the Host and succeeded.
    expect(accepted.length).toBeGreaterThan(0)
    expect(text).toContain('event: status')
    // The stream ends before the expiry, so the Host refuses no poll.
    expect(refused).toHaveLength(0)
    expect(closedAt).toBeLessThan(expSeconds * 1000)
    expect(text).toContain('event: auth-expired')
    expect(text).toContain('"reason":"auth-expired"')
    expect(text).not.toContain('event: error')
    // One resolve for the whole stream.
    expect(hostAccessCalls()).toHaveLength(1)
  }, 20_000)

  it('status stream: opened inside the expiry margin, it ends with auth-expired before any Host poll', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:status:read']))
    const expSeconds = nearExpSeconds()
    controlApiBody = {
      ...OLD_SHAPE_CONNECTION,
      edgeAssertion: signEdgeAssertion(expSeconds, ['host:status:read']),
    }
    const verdicts: HostVerdict[] = []
    hostAnswer = statusHostRecordingVerdicts(verdicts)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    // The spies are restored after the assertions: mockRestore also clears the
    // recorded calls.
    try {
      const text = await readStream('/rpc/hosts/chatllm/status/stream', body =>
        body.includes('event: closed')
      )

      // Witness: the stream opened and the poll loop ran.
      expect(text).toContain('event: open')
      expect(text).toContain('event: auth-expired')
      expect(text).toContain('"reason":"auth-expired"')
      expect(hostCalls).toHaveLength(0)
      expect(hostAccessCalls()).toHaveLength(1)
      // The stream's poll and keepalive intervals and its lifetime timeout were
      // created and then cleared when it ended.
      const handlesCreatedWith = (
        spy: typeof setIntervalSpy | typeof setTimeoutSpy,
        delayMs: number
      ) =>
        spy.mock.calls.flatMap((call, index) =>
          call[1] === delayMs ? [spy.mock.results[index]!.value] : []
        )
      const pollIntervals = handlesCreatedWith(setIntervalSpy, config.streamIntervalMs)
      const keepAliveIntervals = handlesCreatedWith(setIntervalSpy, config.streamKeepaliveMs)
      const lifetimeTimeouts = handlesCreatedWith(setTimeoutSpy, config.streamMaxLifetimeMs)
      expect(pollIntervals).toHaveLength(1)
      expect(keepAliveIntervals).toHaveLength(1)
      expect(lifetimeTimeouts).toHaveLength(1)
      expect(clearIntervalSpy).toHaveBeenCalledWith(pollIntervals[0])
      expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveIntervals[0])
      expect(clearTimeoutSpy).toHaveBeenCalledWith(lifetimeTimeouts[0])
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  }, 20_000)

  it('status stream: three Host 401 answers far from the assertion exp still end it with auth-expired', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes(['host:status:read']))
    controlApiBody = {
      ...OLD_SHAPE_CONNECTION,
      edgeAssertion: signEdgeAssertion(Math.floor(Date.now() / 1000) + 300, ['host:status:read']),
    }
    hostAnswer = HOST_401

    const text = await readStream('/rpc/hosts/chatllm/status/stream', body =>
      body.includes('event: closed')
    )

    expect(hostCalls).toHaveLength(3)
    const authExpiredAt = text.indexOf('event: auth-expired')
    expect(authExpiredAt).toBeGreaterThan(-1)
    const errorsBefore = text.slice(0, authExpiredAt).split('event: error').length - 1
    expect(errorsBefore).toBe(2)
    expect(text).toContain('"reason":"auth-expired"')
  }, 20_000)

  // Each stream forwards only its own event names.
  const PASSTHROUGH_STREAM_ROWS = [
    { ...ROUTE_SCOPE_ROWS.find(row => row.label === 'activity stream')!, hostEvent: 'activity' },
    { ...ROUTE_SCOPE_ROWS.find(row => row.label === 'progress stream')!, hostEvent: 'tool_start' },
  ]

  it.each(PASSTHROUGH_STREAM_ROWS)(
    '$label: verified once at the start, it keeps flowing past the assertion exp',
    async row => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
      const expSeconds = Math.floor(Date.now() / 1000) + 1
      controlApiBody = {
        ...OLD_SHAPE_CONNECTION,
        edgeAssertion: signEdgeAssertion(expSeconds, [row.scope]),
      }
      const verdicts: HostVerdict[] = []
      let lateEventAt = 0
      hostAnswer = index => {
        const at = Date.now()
        const refusal = hostChecksAssertion(hostCalls[index]!.headers, at)
        verdicts.push({ at, status: refusal ? refusal.status : 200 })
        if (refusal) return refusal
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`event: ${row.hostEvent}\ndata: {"marker":"before-exp"}\n\n`)
            )
            setTimeout(
              () => {
                lateEventAt = Date.now()
                controller.enqueue(
                  encoder.encode(`event: ${row.hostEvent}\ndata: {"marker":"after-exp"}\n\n`)
                )
              },
              expSeconds * 1000 + 300 - Date.now()
            )
          },
        })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }

      const text = await readStream(row.path, body => body.includes('after-exp'))

      expect(verdicts).toEqual([{ at: expect.any(Number), status: 200 }])
      expect(hostCalls).toHaveLength(1)
      expect(hostCalls[0]!.path).toBe(row.hostPath)
      expect(text).toContain('before-exp')
      expect(text).toContain('after-exp')
      expect(lateEventAt).toBeGreaterThanOrEqual(expSeconds * 1000)
    },
    10_000
  )
})

// The outcome of every control-api answer at the V1 Host resolve, through the
// real routes (S1: first resolve; S2: re-resolve before a wake-and-hold retry).
// Each stub carries its expected outcome per control-api method: a refusal of
// the refusal writer's table, a denial (answered 403 with its code, or 404 on
// the task routes), or a success.
type ControlApiMethod = 'GET' | 'POST'
type StubOutcome =
  | { kind: 'refusal'; status: number; body: Record<string, unknown> }
  | { kind: 'denied'; code: 'host_access_revoked' | 'host_access_denied' }
  | { kind: 'success' }
type FailureStub = {
  failure: string
  answer: (method: ControlApiMethod) => Response
  GET: StubOutcome
  POST: StubOutcome
}

const UNAVAILABLE: StubOutcome = {
  kind: 'refusal',
  status: 503,
  body: { error: 'authority_unavailable' },
}
const DENIED: StubOutcome = { kind: 'denied', code: 'host_access_denied' }

// A 200 body that is a valid connection except for `override`; a POST answer
// carries a valid binding status, so the field under test decides the outcome.
function connectionAnswer(method: ControlApiMethod, override: Record<string, unknown>): Response {
  return jsonResponse(200, {
    ...OLD_SHAPE_CONNECTION,
    edgeAssertion,
    ...(method === 'POST' ? { bindingStatus: 'recorded' } : {}),
    ...override,
  })
}

function withoutKey(key: string): Record<string, unknown> {
  const connection: Record<string, unknown> = { ...OLD_SHAPE_CONNECTION, edgeAssertion }
  delete connection[key]
  return connection
}

const FAILURE_STUBS: FailureStub[] = [
  ...[401, 409].map(
    (status): FailureStub => ({
      failure: String(status),
      answer: () => jsonResponse(status, { error: 'rejected' }),
      GET: {
        kind: 'refusal',
        status,
        body: { error: status === 401 ? 'Unauthorized' : 'Direct run attribution conflict' },
      },
      POST: {
        kind: 'refusal',
        status,
        body: { error: status === 401 ? 'Unauthorized' : 'Direct run attribution conflict' },
      },
    })
  ),
  {
    failure: '403 with the reason team_membership_missing',
    answer: () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-host-access-denial-reason': 'team_membership_missing',
        },
      }),
    GET: { kind: 'denied', code: 'host_access_revoked' },
    POST: { kind: 'denied', code: 'host_access_revoked' },
  },
  {
    failure: '403 without a reason',
    answer: () => jsonResponse(403, { error: 'Forbidden' }),
    GET: DENIED,
    POST: DENIED,
  },
  {
    failure: '404',
    answer: () => jsonResponse(404, { error: 'not found' }),
    GET: DENIED,
    POST: UNAVAILABLE,
  },
  ...[400, 429, 500, 503].map(
    (status): FailureStub => ({
      failure: String(status),
      answer: () => jsonResponse(status, { error: 'control-api-detail' }),
      GET: UNAVAILABLE,
      POST: UNAVAILABLE,
    })
  ),
  {
    failure: 'timeout',
    answer: () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
    GET: { kind: 'refusal', status: 504, body: { error: 'Gateway Timeout' } },
    POST: { kind: 'refusal', status: 504, body: { error: 'Gateway Timeout' } },
  },
  {
    failure: 'network failure',
    answer: () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    },
    GET: UNAVAILABLE,
    POST: UNAVAILABLE,
  },
  {
    failure: '200 without an edge assertion',
    answer: method => connectionAnswer(method, { edgeAssertion: undefined }),
    GET: UNAVAILABLE,
    POST: UNAVAILABLE,
  },
  {
    failure: '200 text/html',
    answer: () =>
      new Response('<html>control-api-detail</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    GET: UNAVAILABLE,
    POST: UNAVAILABLE,
  },
  {
    failure: '200 JSON null',
    answer: () => jsonResponse(200, null),
    GET: UNAVAILABLE,
    POST: UNAVAILABLE,
  },
  {
    failure: '200 for another user',
    answer: method => connectionAnswer(method, { userId: 'another-user' }),
    GET: DENIED,
    POST: DENIED,
  },
  {
    failure: '200 without a url',
    answer: method =>
      jsonResponse(200, {
        ...withoutKey('url'),
        ...(method === 'POST' ? { bindingStatus: 'recorded' } : {}),
      }),
    GET: DENIED,
    POST: DENIED,
  },
  {
    failure: '200 for another hostRef',
    answer: method => connectionAnswer(method, { hostRef: 'another-host' }),
    GET: DENIED,
    POST: DENIED,
  },
  {
    failure: '200 JSON []',
    answer: () => jsonResponse(200, []),
    GET: DENIED,
    POST: DENIED,
  },
  {
    failure: '204 without a body',
    answer: () => new Response(null, { status: 204 }),
    GET: UNAVAILABLE,
    POST: UNAVAILABLE,
  },
  {
    failure: '200 with an invalid bindingStatus',
    answer: () =>
      jsonResponse(200, { ...OLD_SHAPE_CONNECTION, edgeAssertion, bindingStatus: 'not-a-status' }),
    GET: { kind: 'success' },
    POST: UNAVAILABLE,
  },
]

// The task routes answer a denial 404; every other V1 route 403 with the code.
const NOT_FOUND_DENIAL_LABELS = new Set(['task result', 'task cancel'])

type ExpectedAnswer = { status: number; body: Record<string, unknown> }

function expectedRefusal(label: string, outcome: StubOutcome): ExpectedAnswer | null {
  if (outcome.kind === 'success') return null
  if (outcome.kind === 'refusal') return { status: outcome.status, body: outcome.body }
  if (NOT_FOUND_DENIAL_LABELS.has(label)) {
    return { status: 404, body: { error: 'Host not found or not accessible' } }
  }
  return {
    status: 403,
    body: { error: 'Forbidden: user cannot access this host', code: outcome.code },
  }
}

function wakeCalls(): string[] {
  return controlApiCalls.filter(url => url.endsWith('/wake'))
}

// The row's success leg of the existing harness: wake answers 200 with one
// control-api wake call and no Host call; every other route reaches the Host
// once (a stream route is aborted once the Host call is observable).
async function expectRowReachesHost(row: FirstResolveRow): Promise<void> {
  if (row.hostPath === null) {
    const woken = await send(row)
    expect(woken.status).toBe(200)
    expect(wakeCalls()).toHaveLength(1)
    expect(hostCalls).toEqual([])
  } else {
    await sendUntilHostCall(row)
    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]!.path).toBe(row.hostPath)
  }
  expect(hostAccessCalls()).toHaveLength(1)
}

type FirstResolveOutcomeRow = FirstResolveRow & { controlApiMethod: ControlApiMethod }

const FIRST_RESOLVE_OUTCOME_ROWS: FirstResolveOutcomeRow[] = [
  ...FIRST_RESOLVE_ROWS.map(row => ({ ...row, controlApiMethod: 'GET' as const })),
  {
    label: 'messages with threadId',
    method: 'post',
    path: '/rpc/hosts/chatllm/messages',
    body: { content: 'hi', threadId: 'session-1' },
    scope: HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['POST /v1/runtime/messages'],
    hostPath: '/v1/runtime/messages',
    controlApiMethod: 'POST',
  },
]

const FIRST_RESOLVE_OUTCOME_CASES = FIRST_RESOLVE_OUTCOME_ROWS.flatMap(row =>
  FAILURE_STUBS.map(stub => {
    const outcome = stub[row.controlApiMethod]
    const expected = expectedRefusal(row.label, outcome)
    return {
      route: row.label,
      failure: stub.failure,
      status: expected ? String(expected.status) : 'the Host',
      row,
      stub,
      expected,
    }
  })
)

describe('V1 first resolve outcome', () => {
  it('covers every V1 first-resolve route and every failure stub', () => {
    expect(FIRST_RESOLVE_ROWS).toHaveLength(21)
    expect(FIRST_RESOLVE_OUTCOME_CASES).toHaveLength(22 * FAILURE_STUBS.length)
  })

  it.each(FIRST_RESOLVE_OUTCOME_CASES)(
    '$route: control-api $failure answers $status',
    async ({ row, stub, expected }) => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope]))
      controlApiHostAccessAnswer = () => stub.answer(row.controlApiMethod)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        if (expected === null) {
          // The stub is a success for this method: the request reaches the Host.
          await expectRowReachesHost(row)
          return
        }

        const res = await send(row)

        // Witness: the resolve reached control-api once; its refusal stopped
        // the request before any Host call and any wake.
        expect(hostAccessCalls()).toHaveLength(1)
        expect(res.status).toBe(expected.status)
        expect(res.body).toEqual(expected.body)
        expect(hostCalls).toEqual([])
        expect(wakeCalls()).toEqual([])

        // The same request with a valid control-api answer reaches the Host.
        controlApiCalls = []
        controlApiHostAccessAnswer = null
        await expectRowReachesHost(row)
      } finally {
        warn.mockRestore()
      }
    }
  )
})

const RE_RESOLVE_OUTCOME_CASES = V1_WAKE_ROWS.flatMap(row =>
  FAILURE_STUBS.filter(stub => stub.failure !== '200 with an invalid bindingStatus').map(stub => {
    const expected = expectedRefusal(row.label, stub.GET)
    if (expected === null) throw new Error(`${stub.failure} is not a refusal on GET`)
    return { route: row.label, failure: stub.failure, status: expected.status, row, stub, expected }
  })
)

describe('V1 re-resolve outcome', () => {
  const originalWakeMaxHoldMs = config.wakeMaxHoldMs

  beforeEach(() => {
    // Bounds a retry-until-deadline route.
    config.wakeMaxHoldMs = 3_000
    // The first resolve's assertion is within the margin of its exp, so the
    // retry re-resolves it.
    edgeAssertion = signEdgeAssertion(nearExpSeconds(), [])
    controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion }
  })

  afterEach(() => {
    config.wakeMaxHoldMs = originalWakeMaxHoldMs
  })

  it('covers every V1 wake route and every failure stub but the GET success', () => {
    expect(V1_WAKE_ROWS).toHaveLength(12)
    expect(RE_RESOLVE_OUTCOME_CASES).toHaveLength(12 * (FAILURE_STUBS.length - 1))
  })

  it.each(RE_RESOLVE_OUTCOME_CASES)(
    '$route: a re-resolve that gets $failure answers $status',
    async ({ row, stub, expected }) => {
      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([row.scope, 'host:wake:write']))
      controlApiHostAccessAnswer = firstResolveThen(() => stub.answer('GET'))
      hostAnswer = hostDownThen(() => jsonResponse(200, {}))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const res = await send(row)

        // Witness: the first forward failed as Host down, the wake ran once
        // and the retry re-resolved. The refusal then ended the request: no
        // second Host call and no further control-api call.
        expect(hostCalls).toHaveLength(1)
        expect(hostAccessCalls()).toHaveLength(2)
        expect(wakeCalls()).toHaveLength(1)
        expect(res.status).toBe(expected.status)
        expect(res.body).toEqual(expected.body)
        const retryFailures = warn.mock.calls
          .map(args => String(args[0]))
          .filter(line => line.startsWith('[RPC_PROXY] wake-hold') && line.includes('retry failed'))
        expect(retryFailures).toEqual([])
      } finally {
        warn.mockRestore()
      }
    }
  )
})
