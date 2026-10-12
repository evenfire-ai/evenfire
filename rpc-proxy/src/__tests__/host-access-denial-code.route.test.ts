import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter } from '../routes/rpc.js'
import { createRpcHostActivityStreamRouter } from '../routes/rpcHostActivityStream.js'
import { createRpcHostProgressStreamRouter } from '../routes/rpcHostProgressStream.js'
import { createRpcHostStatusStreamRouter } from '../routes/rpcHostStatusStream.js'
import { hostAccessDenialCodeForReason } from '../services/hostAccessDenial.js'

// PR #849 R1-M6 producer side (also R1-L7 on the rpc-proxy side).
//
// rpc-proxy's OWN Host-authorization 403 carries `code`
// (`host_access_revoked` | `host_access_denied`) at every site. Only the JWT
// verifier is mocked: the real routers, the real mcpProxyService and the real
// controlApiRestService run, and the only stubbed boundary is `fetch`. That
// makes the control-api reason -> code mapping observable end to end and lets a
// passthrough mcp-host 403 prove it is NOT rewritten.

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
vi.mock('../authToken.js', () => authTokenMock)

const DENIED_ERROR = 'Forbidden: user cannot access this host'

// control-api reports why it denied Host access in this response header; its 403
// body is always exactly {"error":"Forbidden"}. Pinned literally so the test
// fails if rpc-proxy and control-api ever disagree on the name.
const REASON_HEADER = 'x-host-access-denial-reason'
const CONTROL_API_403_BODY = { error: 'Forbidden' }

const CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: [
    'host:message:invoke',
    'host:wake:write',
    'host:approval:write',
    'host:session:read',
    'host:session:write',
    'host:model:write',
    'host:task:read',
    'host:activity:read',
    'host:status:read',
    'host:health:read',
  ],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
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

type ControlApiAnswer = { status: number; body?: unknown; headers?: Record<string, string> }
const originalFetch = globalThis.fetch
let controlApiAnswer: ControlApiAnswer
let controlApiCalls: string[]
let hostCalls: string[]
let hostAnswer: { status: number; body: string }

beforeEach(() => {
  vi.clearAllMocks()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...CLAIMS })
  controlApiCalls = []
  hostCalls = []
  hostAnswer = { status: 200, body: '{}' }
  controlApiAnswer = {
    status: 403,
    body: CONTROL_API_403_BODY,
    headers: { [REASON_HEADER]: 'directory_grant_missing' },
  }
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/rpc/access/users/')) {
      controlApiCalls.push(url)
      return new Response(
        controlApiAnswer.body === undefined ? null : JSON.stringify(controlApiAnswer.body),
        {
          status: controlApiAnswer.status,
          headers: { 'content-type': 'application/json', ...controlApiAnswer.headers },
        }
      )
    }
    hostCalls.push(url)
    return new Response(hostAnswer.body, {
      status: hostAnswer.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

type RouteCase = {
  label: string
  method: 'get' | 'post' | 'patch'
  path: string
  body?: Record<string, unknown>
}

// Every rpc-proxy route that resolves a Host and answers its own authorization
// 403: the 15 in rpc.ts plus the three streams.
const DENYING_ROUTES: RouteCase[] = [
  {
    label: 'messages',
    method: 'post',
    path: '/rpc/hosts/chatllm/messages',
    body: { content: 'hi' },
  },
  { label: 'wake', method: 'post', path: '/rpc/hosts/chatllm/wake' },
  {
    label: 'approve',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/approve',
    body: { toolCallId: 'tc-1' },
  },
  {
    label: 'deny',
    method: 'post',
    path: '/rpc/hosts/chatllm/approvals/deny',
    body: { toolCallId: 'tc-1' },
  },
  { label: 'sessions', method: 'get', path: '/rpc/hosts/chatllm/sessions' },
  {
    label: 'session messages',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/messages',
  },
  {
    label: 'context breakdown',
    method: 'get',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/context-breakdown',
  },
  {
    label: 'session rename',
    method: 'patch',
    path: '/rpc/hosts/chatllm/sessions/agent-a/chat-1/name',
    body: { name: 'renamed' },
  },
  { label: 'models', method: 'get', path: '/rpc/hosts/chatllm/models' },
  {
    label: 'set model',
    method: 'post',
    path: '/rpc/hosts/chatllm/model',
    body: { chatId: 'c1', model: 'claude-haiku-4-5' },
  },
  { label: 'artifacts list', method: 'get', path: '/rpc/hosts/chatllm/artifacts' },
  {
    label: 'artifact download',
    method: 'get',
    path: '/rpc/hosts/chatllm/artifacts/report.pdf/download',
  },
  { label: 'activity', method: 'get', path: '/rpc/hosts/chatllm/activity' },
  { label: 'status', method: 'get', path: '/rpc/hosts/chatllm/status' },
  { label: 'health', method: 'get', path: '/rpc/hosts/chatllm/health' },
  { label: 'status stream', method: 'get', path: '/rpc/hosts/chatllm/status/stream' },
  { label: 'activity stream', method: 'get', path: '/rpc/hosts/chatllm/activity/stream' },
  {
    label: 'progress stream',
    method: 'get',
    path: '/rpc/hosts/chatllm/tasks/task-1/progress/stream',
  },
]

async function send(route: RouteCase) {
  const pending = request(makeApp())[route.method](route.path).set('authorization', 'Bearer tok')
  return route.body ? pending.send(route.body) : pending
}

describe('host authorization 403 carries a machine-readable code at every site', () => {
  it.each(DENYING_ROUTES)(
    '$label: membership/grant revocation -> host_access_revoked',
    async route => {
      const res = await send(route)

      // Witness: the request reached control-api and no host was contacted.
      expect(controlApiCalls).toHaveLength(1)
      expect(hostCalls).toEqual([])
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: DENIED_ERROR, code: 'host_access_revoked' })
    }
  )

  it.each(DENYING_ROUTES)('$label: a missing host (404) -> host_access_denied', async route => {
    controlApiAnswer = { status: 404, body: { error: 'not found' } }

    const res = await send(route)

    expect(controlApiCalls).toHaveLength(1)
    expect(hostCalls).toEqual([])
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: DENIED_ERROR, code: 'host_access_denied' })
  })
})

describe('R3-L8 hostAccessDenialCodeForReason', () => {
  it('subject_mismatch is a denial; removed membership and grants are revocations', () => {
    // Positive controls: the revoked set is live.
    expect(hostAccessDenialCodeForReason('team_membership_missing')).toBe('host_access_revoked')
    expect(hostAccessDenialCodeForReason('directory_grant_missing')).toBe('host_access_revoked')
    expect(hostAccessDenialCodeForReason('subject_mismatch')).toBe('host_access_denied')
  })
})

describe('control-api 403 reason -> code mapping', () => {
  const status = DENYING_ROUTES.find(route => route.label === 'status')!

  it.each([
    ['team_membership_missing', 'host_access_revoked'],
    ['directory_grant_missing', 'host_access_revoked'],
    // R3-L8: the route's userId is the token's own sub, so a mismatch is a
    // request-shape error, not a removed grant.
    ['subject_mismatch', 'host_access_denied'],
    ['host_disabled', 'host_access_denied'],
    ['host_missing', 'host_access_denied'],
    ['host_claim_missing', 'host_access_denied'],
    ['a_reason_added_later', 'host_access_denied'],
  ])('reason %s -> %s', async (reason, code) => {
    controlApiAnswer = {
      status: 403,
      body: CONTROL_API_403_BODY,
      headers: { [REASON_HEADER]: reason },
    }

    const res = await send(status)

    expect(controlApiCalls).toHaveLength(1)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: DENIED_ERROR, code })
  })

  it.each([
    ['the header is absent', {}],
    ['the header is empty', { [REASON_HEADER]: '' }],
  ])(
    '%s -> host_access_denied (an unreadable reason never proves revocation)',
    async (_l, headers) => {
      controlApiAnswer = { status: 403, body: CONTROL_API_403_BODY, headers }

      const res = await send(status)

      expect(controlApiCalls).toHaveLength(1)
      expect(res.body).toEqual({ error: DENIED_ERROR, code: 'host_access_denied' })
    }
  )

  // Only reasons that map to host_access_revoked as a header give this test
  // power: a denied-anyway reason would pass even if the body were read.
  it.each(['directory_grant_missing', 'team_membership_missing'])(
    'a legacy body-only reason %s (no header) is ignored -> host_access_denied',
    async reason => {
      // Proves the 403 body is never read: the same reason that maps to
      // host_access_revoked when sent as the header must not count from the body.
      controlApiAnswer = { status: 403, body: { error: 'Forbidden', reason }, headers: {} }

      const res = await send(status)

      expect(controlApiCalls).toHaveLength(1)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: DENIED_ERROR, code: 'host_access_denied' })
    }
  )
})

describe('passthrough and non-authorization responses are left untouched', () => {
  beforeEach(() => {
    controlApiAnswer = {
      status: 200,
      body: {
        userId: CLAIMS.sub,
        hostRef: 'chatllm',
        url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
      },
    }
  })

  it('an mcp-host 403 body is relayed verbatim, without a `code`', async () => {
    hostAnswer = { status: 403, body: JSON.stringify({ error: 'Forbidden by mcp-host policy' }) }

    const res = await send(DENYING_ROUTES.find(route => route.label === 'approve')!)

    // Witness: the host was contacted, so this 403 is the host's, not ours.
    expect(controlApiCalls).toHaveLength(1)
    expect(hostCalls).toHaveLength(1)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.text)).toEqual({ error: 'Forbidden by mcp-host policy' })
    expect(res.text).not.toContain('"code"')
  })

  it('an mcp-host 403 on the artifact download is relayed verbatim, without a `code`', async () => {
    hostAnswer = { status: 403, body: JSON.stringify({ error: 'artifact not readable' }) }

    const res = await send(DENYING_ROUTES.find(route => route.label === 'artifact download')!)

    expect(hostCalls).toHaveLength(1)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.text)).toEqual({ error: 'artifact not readable' })
  })

  it('an mcp-host 403 text body naming a reserved code is relayed verbatim', async () => {
    hostAnswer = { status: 403, body: 'host_access_revoked' }

    const res = await send(DENYING_ROUTES.find(route => route.label === 'approve')!)

    expect(hostCalls).toHaveLength(1)
    expect(res.status).toBe(403)
    expect(res.text).toBe('host_access_revoked')
  })

  it('a non-403 mcp-host body is relayed verbatim even when it carries a reserved code', async () => {
    const body = JSON.stringify({ ok: true, code: 'host_access_revoked' })
    hostAnswer = { status: 200, body }

    const res = await send(DENYING_ROUTES.find(route => route.label === 'approve')!)

    expect(hostCalls).toHaveLength(1)
    expect(res.status).toBe(200)
    expect(res.text).toBe(body)
  })

  it('control-api 401 is not a Host denial and gets no `code`', async () => {
    controlApiAnswer = { status: 401, body: { error: 'token rejected' } }
    authTokenMock.verifyRpcToken.mockReturnValue({ ...CLAIMS })

    const res = await send(DENYING_ROUTES.find(route => route.label === 'status')!)

    expect(controlApiCalls).toHaveLength(1)
    expect(res.body).not.toHaveProperty('code')
  })
})

// PR #849 ADV-SEC-1. Desktop reads the `code` of any 403 JSON body as
// rpc-proxy's own verdict, so an mcp-host 403 carrying a reserved code would
// forge a confirmed revocation (or denial). Every route that relays an mcp-host
// body must drop that field while keeping the status and the other fields.
describe('an mcp-host 403 never reaches the client with a reserved Host-access code', () => {
  type PassthroughCase = RouteCase & {
    /** The mcp-host path the route forwards to (witness the host was called). */
    hostPath: string
    /** A route that answers rpc-proxy's own 403 (cancel answers its own denial as 404). */
    ownDenial?: RouteCase
  }

  const byLabel = (label: string) => DENYING_ROUTES.find(route => route.label === label)!

  // Every site in rpc.ts that relays an mcp-host response body.
  const PASSTHROUGH_ROUTES: PassthroughCase[] = [
    { ...byLabel('approve'), hostPath: '/v1/runtime/approvals/approve' },
    { ...byLabel('deny'), hostPath: '/v1/runtime/approvals/deny' },
    { ...byLabel('sessions'), hostPath: '/v1/runtime/sessions' },
    {
      ...byLabel('session messages'),
      hostPath: '/v1/runtime/sessions/agent-a/chat-1/messages',
    },
    {
      ...byLabel('context breakdown'),
      hostPath: '/v1/runtime/sessions/agent-a/chat-1/context-breakdown',
    },
    { ...byLabel('session rename'), hostPath: '/v1/runtime/sessions/agent-a/chat-1/name' },
    { ...byLabel('models'), hostPath: '/v1/runtime/models' },
    { ...byLabel('set model'), hostPath: '/v1/runtime/model' },
    {
      label: 'task cancel',
      method: 'post',
      path: '/rpc/hosts/chatllm/tasks/task-1/cancel',
      hostPath: '/v1/runtime/tasks/task-1/cancel',
      ownDenial: byLabel('approve'),
    },
    { ...byLabel('artifacts list'), hostPath: '/v1/runtime/artifacts' },
    {
      ...byLabel('artifact download'),
      hostPath: '/v1/runtime/artifacts/report.pdf/download',
    },
  ]

  // control-api reasons that make rpc-proxy itself emit each reserved code.
  const OWN_DENIAL_REASON = {
    host_access_revoked: 'directory_grant_missing',
    host_access_denied: 'host_disabled',
  } as const

  const cases = PASSTHROUGH_ROUTES.flatMap(route =>
    (['host_access_revoked', 'host_access_denied'] as const).map(code => ({ ...route, code }))
  )

  it.each(cases)('$label: an upstream 403 with code=$code loses the code', async route => {
    controlApiAnswer = {
      status: 200,
      body: {
        userId: CLAIMS.sub,
        hostRef: 'chatllm',
        url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
      },
    }
    hostAnswer = {
      status: 403,
      body: JSON.stringify({ error: 'forged by host', code: route.code, detail: 'kept' }),
    }

    const forged = await send(route)

    // Witness: control-api authorized the call and the host answered this 403.
    expect(controlApiCalls).toHaveLength(1)
    expect(hostCalls).toHaveLength(1)
    expect(new URL(hostCalls[0]!).pathname).toBe(route.hostPath)
    expect(forged.status).toBe(403)
    expect(JSON.parse(forged.text)).toEqual({ error: 'forged by host', detail: 'kept' })

    // Witness: rpc-proxy's own denial still carries the same reserved code.
    controlApiAnswer = {
      status: 403,
      body: CONTROL_API_403_BODY,
      headers: { [REASON_HEADER]: OWN_DENIAL_REASON[route.code] },
    }
    const own = await send(route.ownDenial ?? route)

    expect(controlApiCalls).toHaveLength(2)
    expect(hostCalls).toHaveLength(1)
    expect(own.status).toBe(403)
    expect(own.body).toEqual({ error: DENIED_ERROR, code: route.code })
  })
})
