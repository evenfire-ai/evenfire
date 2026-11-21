import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
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
let controlApiCalls: string[]
let hostCalls: HostCall[]

function headersOf(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries())
}

beforeEach(() => {
  vi.clearAllMocks()
  controlApiBody = { ...OLD_SHAPE_CONNECTION, edgeAssertion: EDGE_ASSERTION }
  controlApiCalls = []
  hostCalls = []
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/rpc/access/users/')) {
      controlApiCalls.push(url)
      const body =
        init?.method === 'POST' ? { ...controlApiBody, bindingStatus: 'recorded' } : controlApiBody
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    hostCalls.push({ path: new URL(url).pathname, headers: headersOf(init) })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
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
