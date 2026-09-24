import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import request from 'supertest'
import { signRpcAccessToken } from '../../../control-api/src/utils/auth/rpcAuthToken.js'

const events = vi.hoisted(() => ({ values: [] as string[] }))
const service = vi.hoisted(() => ({
  forwardCancelToHost: vi.fn(),
  forwardHostActivity: vi.fn(),
  forwardHostHealth: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  forwardHostStatus: vi.fn(),
  forwardRpcToServer: vi.fn(),
  forwardTaskResultFromHost: vi.fn(),
  listAllowedServersForUser: vi.fn(),
  resolveArtifactReadHostConnectionForUser: vi.fn(),
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
const controlApi = vi.hoisted(() => ({
  ControlApiArtifactReadRateLimitedError: class extends Error {},
  ControlApiConnectorsRejectedError: class extends Error {},
  ControlApiHostAccessRejectedError: class extends Error {},
  ControlApiHostMessageAdmissionError: class extends Error {},
  ControlApiHostRpcAdmissionError: class extends Error {
    constructor(
      readonly status: 429 | 503,
      readonly body: { error: string; retryAfterSeconds?: number },
      readonly headers: Record<string, string>
    ) {
      super('Host-RPC admission rejected')
      this.name = 'ControlApiHostRpcAdmissionError'
    }
  },
  fetchUserConnectorsFromControlApi: vi.fn(),
  fetchUserAllowedServersFromControlApi: vi.fn(),
  requestHostWakeFromControlApi: vi.fn(),
  requestHostRpcAdmission: vi.fn(),
}))

vi.mock('../services/mcpProxyService.js', () => service)
vi.mock('../services/controlApiRestService.js', () => controlApi)

const { createRpcRouter } = await import('../routes/rpc.js')
const { createRpcHostStatusStreamRouter } = await import('../routes/rpcHostStatusStream.js')
const { createRpcHostActivityStreamRouter } = await import('../routes/rpcHostActivityStream.js')
const { createRpcHostProgressStreamRouter } = await import('../routes/rpcHostProgressStream.js')

const USER = '00000000-0000-4000-8000-000000000001'
const TASK = '40000000-0000-4000-8000-000000000001'
const CHAT = '40000000-0000-4000-8000-000000000002'
const REPOSITORY_ROOT = resolve(process.cwd(), '..')
const TSX = resolve(REPOSITORY_ROOT, 'rpc-proxy/node_modules/.bin/tsx')
const RUNTIME_SESSION_PRODUCER = resolve(
  REPOSITORY_ROOT,
  'control-api/test/fixtures/emitRuntimeSessionDelegationV2Fixture.ts'
)
const TEAM_RUNTIME_PRODUCER = resolve(
  REPOSITORY_ROOT,
  'control-api/test/fixtures/emitTeamDerivedRuntimeDelegationV2Fixture.ts'
)
const signedAccessToken = signRpcAccessToken({
  sub: USER,
  typ: 'user',
  accessScope: 'team',
  teamId: 'team-a',
  scopes: [
    'host:health:read',
    'host:status:read',
    'host:activity:read',
    'host:message:invoke',
    'host:wake:write',
    'host:task:read',
    'host:approval:write',
    'host:session:read',
    'host:session:write',
    'host:model:write',
  ],
  hostRefs: ['chatllm'],
  jti: 'producer-token-jti',
})

const CASES = [
  {
    name: 'wake',
    path: '/rpc/hosts/chatllm/wake',
    method: 'post' as const,
    body: {},
  },
  {
    name: 'approval write',
    path: '/rpc/hosts/chatllm/approvals/approve',
    method: 'post' as const,
    body: { taskId: TASK, toolCallId: 'approval-1' },
  },
  { name: 'session read', path: '/rpc/hosts/chatllm/sessions', method: 'get' as const },
  {
    name: 'model write',
    path: '/rpc/hosts/chatllm/model',
    method: 'post' as const,
    body: { agent: 'chatllm', chatId: CHAT, provider: 'openai', model: 'm1' },
  },
  {
    name: 'task read',
    path: `/rpc/hosts/chatllm/tasks/${TASK}/result`,
    method: 'get' as const,
    expectedStatus: 404,
  },
  { name: 'telemetry read', path: '/rpc/hosts/chatllm/health', method: 'get' as const },
  { name: 'status stream open', path: '/rpc/hosts/chatllm/status/stream', method: 'get' as const },
  {
    name: 'activity stream open',
    path: '/rpc/hosts/chatllm/activity/stream',
    method: 'get' as const,
  },
  {
    name: 'task progress stream open',
    path: `/rpc/hosts/chatllm/tasks/${TASK}/progress/stream`,
    method: 'get' as const,
  },
] as const

function app() {
  const server = express()
  server.use(express.json())
  server.use(createRpcRouter())
  server.use(createRpcHostStatusStreamRouter())
  server.use(createRpcHostActivityStreamRouter())
  server.use(createRpcHostProgressStreamRouter())
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  events.values.length = 0
  controlApi.requestHostRpcAdmission.mockImplementation(async () => {
    events.values.push('admission')
  })
  service.resolveHostConnectionForUser.mockImplementation(async () => {
    events.values.push('live-resolver')
    return null
  })
})

describe('Spec 65 legacy Host-RPC admission ordering (real Control API token producer)', () => {
  it.each(CASES)('admits the $name route before live Host resolution', async route => {
    const testRequest = request(app())
      [route.method](route.path)
      .set('authorization', `Bearer ${signedAccessToken}`)
    if ('body' in route && route.body) testRequest.send(route.body)
    await testRequest.expect('expectedStatus' in route ? route.expectedStatus : 403)
    expect(events.values).toEqual(['admission', 'live-resolver'])
  })

  it('returns canonical request-N+1 429 before live Host resolution', async () => {
    controlApi.requestHostRpcAdmission.mockImplementation(async () => {
      events.values.push('admission')
      throw new controlApi.ControlApiHostRpcAdmissionError(
        429,
        { error: 'Too Many Requests', retryAfterSeconds: 22 },
        {
          'Retry-After': '22',
          'X-RateLimit-Limit': '300',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1900000000',
        }
      )
    })
    const response = await request(app())
      .get('/rpc/hosts/chatllm/health')
      .set('authorization', `Bearer ${signedAccessToken}`)
      .expect(429)
    expect(response.body).toEqual({ error: 'Too Many Requests', retryAfterSeconds: 22 })
    expect(response.headers['retry-after']).toBe('22')
    expect(response.headers['x-ratelimit-limit']).toBe('300')
    expect(response.headers['x-ratelimit-remaining']).toBe('0')
    expect(response.headers['x-ratelimit-reset']).toBe('1900000000')
    expect(events.values).toEqual(['admission'])
    expect(service.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('does not charge invalid authentication or insufficient scope', async () => {
    const noScopeToken = signRpcAccessToken({
      sub: USER,
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-a',
      scopes: ['mcp:servers:list'],
      hostRefs: ['chatllm'],
      jti: 'producer-no-host-scope',
    })
    await request(app())
      .get('/rpc/hosts/chatllm/health')
      .set('authorization', 'Bearer invalid')
      .expect(401)
    await request(app())
      .get('/rpc/hosts/chatllm/health')
      .set('authorization', `Bearer ${noScopeToken}`)
      .expect(403)
    expect(controlApi.requestHostRpcAdmission).not.toHaveBeenCalled()
    expect(service.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('rejects invalid legacy route input after scope but before admission or live resolution', async () => {
    const response = await request(app())
      .get('/rpc/hosts/chatllm/sessions?limit=not-a-number')
      .set('authorization', `Bearer ${signedAccessToken}`)
      .expect(400)
    expect(response.body).toEqual({ error: 'Invalid session pagination query' })
    expect(controlApi.requestHostRpcAdmission).not.toHaveBeenCalled()
    expect(service.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'model write body shape',
      method: 'post' as const,
      path: '/rpc/hosts/chatllm/model',
      body: [],
      expectedBody: { error: 'Invalid set-model request payload' },
    },
    {
      name: 'task identifier syntax',
      method: 'get' as const,
      path: '/rpc/hosts/chatllm/tasks/bad%21id/result',
      expectedBody: { error: 'Invalid taskId' },
    },
    {
      name: 'progress stream task identifier syntax',
      method: 'get' as const,
      path: '/rpc/hosts/chatllm/tasks/bad%21id/progress/stream',
      expectedBody: {
        error: 'taskId is required and must be alphanumeric (max 128 chars)',
      },
    },
    {
      name: 'read-only stream body shape',
      method: 'get' as const,
      path: '/rpc/hosts/chatllm/status/stream',
      body: { unexpected: true },
      expectedBody: { error: 'Status stream is read-only and does not accept request bodies' },
    },
  ])('rejects invalid legacy $name before admission or live resolution', async item => {
    const testRequest = request(app())
      [item.method](item.path)
      .set('authorization', `Bearer ${signedAccessToken}`)
    if (item.body) testRequest.send(item.body)
    const response = await testRequest.expect(400)
    expect(response.body).toEqual(item.expectedBody)
    expect(controlApi.requestHostRpcAdmission).not.toHaveBeenCalled()
    expect(service.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('preserves legacy scope denial before route preflight', async () => {
    const noScopeToken = signRpcAccessToken({
      sub: USER,
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-a',
      scopes: ['mcp:servers:list'],
      hostRefs: ['chatllm'],
      jti: 'producer-no-session-scope',
    })
    const response = await request(app())
      .get('/rpc/hosts/chatllm/sessions?limit=not-a-number')
      .set('authorization', `Bearer ${noScopeToken}`)
      .expect(403)
    expect(response.body).toEqual({ error: 'Forbidden: missing scope' })
    expect(controlApi.requestHostRpcAdmission).not.toHaveBeenCalled()
  })

  it('rejects invalid v2 route input after real local binding and before the remote checkpoint', async () => {
    const fixture = JSON.parse(
      execFileSync(TSX, [RUNTIME_SESSION_PRODUCER, 'session.read'], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: process.env,
      })
    ) as { token: string }
    const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await request(app())
        .get('/rpc/hosts/chatllm/sessions/search?q=')
        .set('authorization', `Bearer ${fixture.token}`)
        .expect(400)
      expect(response.body).toEqual({ error: 'Invalid session search query' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(controlApi.requestHostRpcAdmission).not.toHaveBeenCalled()
      expect(service.resolveHostConnectionForUser).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('preserves exact v2 binding denial before invalid route preflight', async () => {
    const fixture = JSON.parse(
      execFileSync(TSX, [RUNTIME_SESSION_PRODUCER, 'session.read'], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: process.env,
      })
    ) as { token: string }
    const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await request(app())
        .get('/rpc/hosts/other-host/sessions/search?q=')
        .set('authorization', `Bearer ${fixture.token}`)
        .expect(400)
      expect(response.body).toEqual({ error: 'invalid_binding' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(controlApi.requestHostRpcAdmission).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps exact v2 binding ahead of stream-body preflight and preflights before checkpoint', async () => {
    const fixture = JSON.parse(
      execFileSync(TSX, [TEAM_RUNTIME_PRODUCER], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: process.env,
      })
    ) as { token: string }
    const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const invalidPreflight = await request(app())
        .get('/rpc/hosts/chatllm/status/stream')
        .set('authorization', `Bearer ${fixture.token}`)
        .send({ unexpected: true })
        .expect(400)
      expect(invalidPreflight.body).toEqual({
        error: 'Status stream is read-only and does not accept request bodies',
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(service.resolveHostConnectionForUser).not.toHaveBeenCalled()

      const invalidBinding = await request(app())
        .get('/rpc/hosts/other-host/status/stream')
        .set('authorization', `Bearer ${fixture.token}`)
        .send({ unexpected: true })
        .expect(400)
      expect(invalidBinding.body).toEqual({ error: 'invalid_binding' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(service.resolveHostConnectionForUser).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
