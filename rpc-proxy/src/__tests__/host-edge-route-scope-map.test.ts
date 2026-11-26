import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_CLAIM_TYPE,
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

// rpc-proxy reads the scope of each Host route it forwards to from the edge
// scope map. Here the map holds one distinct value per Host route, so each
// route admits a V1 token only when it holds that route's map value: a route
// that required a scope of its own, or another route's map value, refuses it.
// Only the RPC token verifier and the map are replaced; the real routers,
// resolver and control-api client run, and `fetch` (control-api and the Host)
// is the only stubbed boundary.

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
vi.mock('../authToken.js', () => authTokenMock)

vi.mock('@clerum/action-context-contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clerum/action-context-contracts')>()
  return {
    ...actual,
    HOST_EDGE_RPC_PROXY_ROUTE_SCOPES: Object.freeze(
      Object.fromEntries(
        Object.keys(actual.HOST_EDGE_RPC_PROXY_ROUTE_SCOPES).map(route => [
          route,
          `map-scope:${route}`,
        ])
      )
    ),
  }
})

const USER_ID = 'user-uuid-123'

const MAP_VALUES: string[] = Object.values(HOST_EDGE_RPC_PROXY_ROUTE_SCOPES)
// The scopes the unmodified map holds, read from the real contract package.
let realScopes: string[]

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('@clerum/action-context-contracts')>(
    '@clerum/action-context-contracts'
  )
  realScopes = [...new Set(Object.values(actual.HOST_EDGE_RPC_PROXY_ROUTE_SCOPES))]
  // The map this suite reads holds one distinct value per Host route.
  expect(new Set(MAP_VALUES).size).toBe(Object.keys(actual.HOST_EDGE_RPC_PROXY_ROUTE_SCOPES).length)
  expect(MAP_VALUES.some(value => realScopes.includes(value))).toBe(false)
})

function mapValue(route: HostEdgeRpcProxyRoute): string {
  return HOST_EDGE_RPC_PROXY_ROUTE_SCOPES[route]
}

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

// A V1 assertion built the way control-api signs it, with `exp` far from now,
// so the status stream polls and no retry re-resolves it.
const EDGE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })

function signEdgeAssertion(): string {
  return jwt.sign(
    {
      typ: HOST_EDGE_ASSERTION_CLAIM_TYPE,
      v: 1,
      iss: 'control-api',
      sub: USER_ID,
      host: `${config.hostNamespace}/chatllm`,
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      teamId: 'team-1',
      scopes: [],
    },
    EDGE_KEYS.privateKey,
    {
      algorithm: 'RS256',
      audience: HOST_EDGE_ASSERTION_AUDIENCE,
      header: { alg: 'RS256', typ: HOST_EDGE_ASSERTION_JWT_TYPE },
    }
  )
}

type HostCall = { method: string; path: string }
const originalFetch = globalThis.fetch
let controlApiCalls: string[]
let hostCalls: HostCall[]

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  controlApiCalls = []
  hostCalls = []
  // The control-api Host-access answer: `{ userId, hostRef, url, edgeAssertion }`.
  const controlApiBody = {
    userId: USER_ID,
    hostRef: 'chatllm',
    url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
    edgeAssertion: signEdgeAssertion(),
  }
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(config.controlApiBaseUrl.replace(/\/+$/, ''))) {
      controlApiCalls.push(url)
      return jsonResponse(
        200,
        init?.method === 'POST' ? { ...controlApiBody, bindingStatus: 'recorded' } : controlApiBody
      )
    }
    hostCalls.push({ method: init?.method ?? 'GET', path: new URL(url).pathname })
    return jsonResponse(200, {})
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetHostStatusStreamRuntimeForTests()
  resetHostActivityStreamRuntimeForTests()
})

type MapRouteRow = {
  label: string
  method: 'get' | 'post' | 'patch'
  path: string
  body?: Record<string, unknown>
  hostRoute: HostEdgeRpcProxyRoute
}

// Session search refuses V1 tokens after the scope stage, so it never reaches the Host
// with the tokens this table uses; it has its own test below.
const SESSION_SEARCH_ROUTE: HostEdgeRpcProxyRoute = 'GET /v1/runtime/sessions/search'

// One row per rpc-proxy route that forwards to a guarded Host route, with the
// map row of the Host route it reaches.
const MAP_ROUTE_ROWS: MapRouteRow[] = [
  {
    label: 'status',
    method: 'get',
    path: '/rpc/hosts/chatllm/status',
    hostRoute: 'GET /v1/runtime/status',
  },
  {
    label: 'status stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/status/stream',
    hostRoute: 'GET /v1/runtime/status',
  },
  {
    label: 'activity',
    method: 'get',
    path: '/rpc/hosts/chatllm/activity',
    hostRoute: 'GET /v1/runtime/activity',
  },
  {
    label: 'activity stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/activity/stream',
    hostRoute: 'GET /v1/runtime/activity/stream',
  },
  {
    label: 'messages',
    method: 'post',
    path: '/rpc/hosts/chatllm/messages',
    body: { content: 'hi' },
    hostRoute: 'POST /v1/runtime/messages',
  },
  {
    label: 'approve',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/approve',
    body: { toolCallId: 'tc-1' },
    hostRoute: 'POST /v1/runtime/approvals/approve',
  },
  {
    label: 'deny',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/deny',
    body: { toolCallId: 'tc-1' },
    hostRoute: 'POST /v1/runtime/approvals/deny',
  },
  {
    label: 'sessions',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions',
    hostRoute: 'GET /v1/runtime/sessions',
  },
  {
    label: 'session messages',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/messages',
    hostRoute: 'GET /v1/runtime/sessions/:agent/:chatId/messages',
  },
  {
    label: 'context breakdown',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/context-breakdown',
    hostRoute: 'GET /v1/runtime/sessions/:agent/:chatId/context-breakdown',
  },
  {
    label: 'task result',
    method: 'get',
    path: '/rpc/hosts/chatllm/tasks/task-1/result',
    hostRoute: 'GET /v1/runtime/tasks/:taskId/result',
  },
  {
    label: 'task cancel',
    method: 'post',
    path: '/rpc/hosts/chatllm/tasks/task-1/cancel',
    hostRoute: 'POST /v1/runtime/tasks/:taskId/cancel',
  },
  {
    label: 'models',
    method: 'get',
    path: '/rpc/hosts/chatllm/models',
    hostRoute: 'GET /v1/runtime/models',
  },
  {
    label: 'set model',
    method: 'post',
    path: '/rpc/hosts/chatllm/model',
    body: { chatId: 'c1', model: 'model-fixture' },
    hostRoute: 'POST /v1/runtime/model',
  },
  {
    label: 'session rename',
    method: 'patch',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/name',
    body: { title: 'renamed' },
    hostRoute: 'PATCH /v1/runtime/sessions/:agent/:chatId/name',
  },
  {
    label: 'approval mode',
    method: 'patch',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/approval-mode',
    body: { mode: 'auto', userId: 'attacker-sub', title: 'ignored' },
    hostRoute: 'PATCH /v1/runtime/sessions/:agent/:chatId/approval-mode',
  },
  {
    label: 'progress stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/tasks/task-1/progress/stream',
    hostRoute: 'GET /v1/runtime/tasks/:taskId/progress/stream',
  },
  {
    label: 'artifacts list',
    method: 'get',
    path: '/rpc/hosts/chatllm/artifacts',
    hostRoute: 'GET /v1/runtime/artifacts',
  },
  {
    label: 'artifact download',
    method: 'get',
    path: '/rpc/hosts/chatllm/artifacts/report.pdf/download',
    hostRoute: 'GET /v1/runtime/artifacts/:filename/download',
  },
]

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

function expectOneCallTo(hostRoute: HostEdgeRpcProxyRoute): void {
  const [method, routePath] = hostRoute.split(' ')
  expect(hostCalls).toHaveLength(1)
  expect(hostCalls[0]!.method).toBe(method)
  expect(hostCalls[0]!.path).toMatch(hostRoutePathPattern(routePath!))
}

function send(row: Pick<MapRouteRow, 'method' | 'path' | 'body'>) {
  const pending = request(makeApp())[row.method](row.path).set('authorization', 'Bearer tok')
  return row.body ? pending.send(row.body) : pending
}

/**
 * Sends the request and waits until it settles or the route has called the
 * Host. An SSE route never completes, so it is aborted once the Host call is
 * observable; its answer is then `null`.
 */
async function sendUntilHostCall(
  row: MapRouteRow
): Promise<{ status: number; body: unknown } | null> {
  const pending = send(row)
  let answer: { status: number; body: unknown } | null = null
  let settled = false
  const completion = pending.then(
    res => {
      answer = { status: res.status, body: res.body }
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
  return answer
}

describe('rpc-proxy reads each Host route scope from the edge scope map', () => {
  it('covers every Host route of the map, in the table or the session search test, and no other', () => {
    const mapRoutes = Object.keys(HOST_EDGE_RPC_PROXY_ROUTE_SCOPES).sort()
    const tableRoutes = new Set(MAP_ROUTE_ROWS.map(row => row.hostRoute))
    expect(tableRoutes.has(SESSION_SEARCH_ROUTE)).toBe(false)
    const coveredRoutes = [...tableRoutes, SESSION_SEARCH_ROUTE].sort()
    expect(mapRoutes.length).toBeGreaterThan(0)
    expect(coveredRoutes).toEqual(mapRoutes)
  })

  it.each(MAP_ROUTE_ROWS)(
    '$label requires the map value of $hostRoute and reaches that Host route',
    async row => {
      const ownValue = mapValue(row.hostRoute)
      authTokenMock.verifyRpcToken.mockReturnValue(
        claimsWithScopes([...realScopes, ...MAP_VALUES.filter(value => value !== ownValue)])
      )
      // A stream route that admitted the token would never complete; it is
      // aborted at its Host call and its answer is `null`.
      const refused = await sendUntilHostCall(row)
      expect(refused?.status).toBe(403)
      expect(refused?.body).toEqual({ error: 'Forbidden: missing scope' })
      expect(hostCalls).toEqual([])

      authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([ownValue]))
      await sendUntilHostCall(row)

      // Witness for the refusal above: with only the row's map value the same
      // request records one Host call, on the row's Host route.
      expectOneCallTo(row.hostRoute)
    }
  )

  it('session search checks the map value of its Host route before the V2 requirement', async () => {
    const searchRow = {
      method: 'get' as const,
      path: '/rpc/hosts/chatllm/sessions/search?q=hello',
    }
    const searchValue = mapValue(SESSION_SEARCH_ROUTE)
    authTokenMock.verifyRpcToken.mockReturnValue(
      claimsWithScopes([...realScopes, ...MAP_VALUES.filter(value => value !== searchValue)])
    )
    const refused = await send(searchRow)
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ error: 'Forbidden: missing scope' })

    // Witness: with the map value the scope stage passes and the V2 stage
    // refuses the V1 token.
    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([searchValue]))
    const v2Required = await send(searchRow)
    expect(v2Required.status).toBe(403)
    expect(v2Required.body).toEqual({ error: 'User delegation v2 required for session search' })
    expect(hostCalls).toEqual([])
  })

  it('a message carrying approvalMode also requires the map value of the approval-mode route', async () => {
    const row: MapRouteRow = {
      label: 'messages with approvalMode',
      method: 'post',
      path: '/rpc/hosts/chatllm/messages',
      body: { content: 'hi', approvalMode: 'auto' },
      hostRoute: 'POST /v1/runtime/messages',
    }
    const messageValue = mapValue('POST /v1/runtime/messages')
    const approvalModeValue = mapValue('PATCH /v1/runtime/sessions/:agent/:chatId/approval-mode')

    authTokenMock.verifyRpcToken.mockReturnValue(claimsWithScopes([messageValue]))
    const refusedWithMessageValue = await send(row)
    expect(refusedWithMessageValue.status).toBe(403)
    expect(refusedWithMessageValue.body).toEqual({ error: 'Forbidden: missing scope' })

    // Every real scope does not stand in for the approval-mode map value.
    authTokenMock.verifyRpcToken.mockReturnValue(
      claimsWithScopes([...realScopes, ...MAP_VALUES.filter(value => value !== approvalModeValue)])
    )
    const refusedWithRealScopes = await send(row)
    expect(refusedWithRealScopes.status).toBe(403)
    expect(refusedWithRealScopes.body).toEqual({ error: 'Forbidden: missing scope' })
    expect(hostCalls).toEqual([])

    // Witness: with both map values the same message reaches the Host.
    authTokenMock.verifyRpcToken.mockReturnValue(
      claimsWithScopes([messageValue, approvalModeValue])
    )
    await send(row)
    expectOneCallTo(row.hostRoute)
  })
})
