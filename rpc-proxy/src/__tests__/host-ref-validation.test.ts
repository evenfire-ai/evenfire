import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import request from 'supertest'
import { createRpcRouter } from '../routes/rpc.js'
import { createRpcHostActivityStreamRouter } from '../routes/rpcHostActivityStream.js'
import { createRpcHostProgressStreamRouter } from '../routes/rpcHostProgressStream.js'
import { createRpcHostStatusStreamRouter } from '../routes/rpcHostStatusStream.js'

const authMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const hostMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  resolveArtifactReadHostConnectionForUser: vi.fn(),
  requestHostWakeFromControlApi: vi.fn(),
}))

const repositoryRoot = resolve(process.cwd(), '..')
const tsx = resolve(repositoryRoot, 'rpc-proxy', 'node_modules', '.bin', 'tsx')
const hostWakeDelegationProducer = resolve(
  repositoryRoot,
  'control-api',
  'test',
  'fixtures',
  'emitUserDelegationV2Fixture.ts'
)

vi.mock('../authToken.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../authToken.js')>()),
  verifyRpcToken: authMock.verifyRpcToken,
}))
vi.mock('../services/mcpProxyService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/mcpProxyService.js')>()),
  resolveHostConnectionForUser: hostMock.resolveHostConnectionForUser,
  resolveArtifactReadHostConnectionForUser: hostMock.resolveArtifactReadHostConnectionForUser,
}))
vi.mock('../services/controlApiRestService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/controlApiRestService.js')>()),
  requestHostWakeFromControlApi: hostMock.requestHostWakeFromControlApi,
}))

const legacyClaims = {
  sub: 'user-1',
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
  hostRefs: ['host-a'],
  jti: 'jti-1',
  iat: 1,
  exp: 9_999_999_999,
}

function mountedApp() {
  const app = express()
  app.use(createRpcRouter())
  app.use(createRpcHostStatusStreamRouter())
  app.use(createRpcHostActivityStreamRouter())
  app.use(createRpcHostProgressStreamRouter())
  app.use((_req, res) => res.status(404).json({ error: 'Not Found' }))
  return app
}

type Route = { method: 'get' | 'post' | 'patch'; suffix: string; body?: object }
const legacyRoutes: Route[] = [
  { method: 'post', suffix: '/messages', body: { content: 'hello' } },
  { method: 'post', suffix: '/wake', body: {} },
  { method: 'post', suffix: '/approvals/approve', body: {} },
  { method: 'post', suffix: '/approvals/deny', body: {} },
  { method: 'post', suffix: '/model', body: {} },
  { method: 'post', suffix: '/tasks/task-1/cancel', body: {} },
  { method: 'patch', suffix: '/sessions/agent/chat/name', body: {} },
  { method: 'get', suffix: '/sessions' },
  { method: 'get', suffix: '/sessions/agent/chat/messages' },
  { method: 'get', suffix: '/sessions/agent/chat/context-breakdown' },
  { method: 'get', suffix: '/models' },
  { method: 'get', suffix: '/tasks/task-1/result' },
  { method: 'get', suffix: '/artifacts' },
  { method: 'get', suffix: '/artifacts/file.txt/download' },
  { method: 'get', suffix: '/activity' },
  { method: 'get', suffix: '/status' },
  { method: 'get', suffix: '/health' },
  { method: 'get', suffix: '/status/stream' },
  { method: 'get', suffix: '/activity/stream' },
  { method: 'get', suffix: '/tasks/task-1/progress/stream' },
]
const invalidCapturedRefs = [
  '*',
  '%2A',
  '%252A',
  'Host',
  '-host',
  'host-',
  'bad.name',
  'bad%20name',
  'bad_host',
  'bad%2Fhost',
  'bad%0Ahost',
  'bad%00host',
  'h'.repeat(64),
]

async function callRoute(app: express.Express, route: Route, encodedHostRef: string) {
  const path = `/rpc/hosts/${encodedHostRef}${route.suffix}`
  const call = request(app)[route.method](path).set('authorization', 'Bearer legacy-token')
  return route.body === undefined ? call : call.send(route.body)
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.verifyRpcToken.mockReturnValue(legacyClaims)
  hostMock.resolveHostConnectionForUser.mockResolvedValue(null)
  hostMock.resolveArtifactReadHostConnectionForUser.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('public Host-ref validation', () => {
  it('uses the Control API Host-create grammar exactly', async () => {
    const { HOST_REF_RE } = await import('../middleware/hostRefValidation.js')
    const authority = readFileSync(
      resolve(process.cwd(), '../control-api/src/http/rfc1123.ts'),
      'utf8'
    )
    const authoritativePattern = authority.match(/export const RFC1123_RE\s*=\s*(\/[^\n]+\/)/)
    expect(authoritativePattern?.[1]).toBe(HOST_REF_RE.toString())
  })

  it.each(legacyRoutes)(
    '$method $suffix rejects invalid captured Host refs before resolution',
    async route => {
      const response = await callRoute(mountedApp(), route, 'invalid_host')
      expect(response.status).toBe(400)
      expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
      expect(hostMock.resolveArtifactReadHostConnectionForUser).not.toHaveBeenCalled()
      expect(hostMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
    }
  )

  it.each(legacyRoutes)(
    '$method $suffix rejects every captured invalid Host before effects',
    async route => {
      for (const encodedHostRef of invalidCapturedRefs) {
        vi.clearAllMocks()
        const response = await callRoute(mountedApp(), route, encodedHostRef)
        expect(response.status).toBe(400)
        expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
        expect(hostMock.resolveArtifactReadHostConnectionForUser).not.toHaveBeenCalled()
        expect(hostMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['a', 'a'.repeat(63), 'valid-host-1'])(
    'allows valid boundary %s to reach the existing live authority path',
    async hostRef => {
      const response = await callRoute(mountedApp(), { method: 'get', suffix: '/status' }, hostRef)
      expect(response.status).toBe(403)
      expect(hostMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
        'user-1',
        hostRef,
        'legacy-token',
        expect.anything()
      )
    }
  )

  it.each([legacyRoutes[5], legacyRoutes[11]])(
    'retains 404 for a valid but inaccessible $suffix task Host',
    async route => {
      const response = await callRoute(mountedApp(), route, 'valid-host')
      expect(response.status).toBe(404)
      expect(hostMock.resolveHostConnectionForUser).toHaveBeenCalled()
    }
  )

  it('keeps the v2-only session-search denial before W1 for a legacy token', async () => {
    const response = await request(mountedApp())
      .get('/rpc/hosts/invalid_host/sessions/search?q=x')
      .set('authorization', 'Bearer legacy-token')
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'User delegation v2 required for session search' })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('keeps authentication and scope denial ahead of W1', async () => {
    await request(mountedApp()).get('/rpc/hosts/invalid_host/status').expect(401)
    authMock.verifyRpcToken.mockReturnValue({ ...legacyClaims, scopes: [] })
    await request(mountedApp())
      .get('/rpc/hosts/invalid_host/status')
      .set('authorization', 'Bearer legacy-token')
      .expect(403)
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('rejects a whitespace Host ref after real v2 binding but before the remote checkpoint', async () => {
    const producerOutput = execFileSync(tsx, [hostWakeDelegationProducer], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
    const { token } = JSON.parse(producerOutput) as { token: string }
    const remoteCheckpoint = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'checkpoint_should_not_run' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', remoteCheckpoint)

    // The real producer signs mcp-host/chatllm. The local route binder's
    // existing trim makes this exact target match, while W1 must inspect and
    // reject the captured bare segment without normalization.
    const response = await request(mountedApp())
      .post('/rpc/hosts/%20chatllm%20/wake')
      .set('authorization', `Bearer ${token}`)
      .send({ wakeReason: 'explicit' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Invalid hostRef' })
    expect(remoteCheckpoint).not.toHaveBeenCalled()
    expect(hostMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('rejects real v2 target substitutions during local binding before W1 or checkpoint I/O', async () => {
    const producerOutput = execFileSync(tsx, [hostWakeDelegationProducer], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
    const { token } = JSON.parse(producerOutput) as { token: string }
    const remoteCheckpoint = vi.fn()
    vi.stubGlobal('fetch', remoteCheckpoint)

    for (const routeHost of ['other-host', 'invalid_host']) {
      const response = await request(mountedApp())
        .post(`/rpc/hosts/${routeHost}/wake`)
        .set('authorization', `Bearer ${token}`)
        .send({ wakeReason: 'explicit' })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_binding' })
    }
    expect(remoteCheckpoint).not.toHaveBeenCalled()
    expect(hostMock.requestHostWakeFromControlApi).not.toHaveBeenCalled()
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('does not convert a missing segment into a captured invalid Host', async () => {
    await request(mountedApp())
      .get('/rpc/hosts//status')
      .set('authorization', 'Bearer legacy-token')
      .expect(404)
  })

  it('preserves malformed JSON precedence for a legacy session rename', async () => {
    const response = await request(mountedApp())
      .patch('/rpc/hosts/invalid_host/sessions/agent/chat/name')
      .set('authorization', 'Bearer legacy-token')
      .set('content-type', 'application/json')
      .send('{')
    expect(response.status).toBe(400)
    expect(response.text).not.toContain('Invalid hostRef')
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('returns W1 400 after valid JSON on a legacy session rename', async () => {
    const response = await request(mountedApp())
      .patch('/rpc/hosts/invalid_host/sessions/agent/chat/name')
      .set('authorization', 'Bearer legacy-token')
      .send({ title: 'Valid title' })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Invalid hostRef' })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    { method: 'get' as const, suffix: '/tasks/bad.id/result' },
    { method: 'post' as const, suffix: '/tasks/bad.id/cancel' },
  ])('keeps task-ID denial before W1 on $method $suffix', async route => {
    const response = await callRoute(mountedApp(), route, 'invalid_host')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Invalid taskId' })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('keeps progress task-ID denial before W1', async () => {
    const response = await callRoute(
      mountedApp(),
      { method: 'get', suffix: '/tasks/bad.id/progress/stream' },
      'invalid_host'
    )
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: 'taskId is required and must be alphanumeric (max 128 chars)',
    })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    {
      suffix: '/status/stream',
      error: 'Status stream is read-only and does not accept request bodies',
    },
    {
      suffix: '/activity/stream',
      error: 'Activity stream is read-only and does not accept request bodies',
    },
    {
      suffix: '/tasks/task-1/progress/stream',
      error: 'Progress stream is read-only and does not accept request bodies',
    },
  ])('keeps read-only body denial before W1 on $suffix', async route => {
    const response = await request(mountedApp())
      .get(`/rpc/hosts/invalid_host${route.suffix}`)
      .set('authorization', 'Bearer legacy-token')
      .set('content-length', '1')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: route.error })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it.each([
    { suffix: '/sessions?limit=0', error: 'Invalid session pagination query' },
    { suffix: '/sessions/bad:agent/chat/messages', error: 'Invalid hostRef, agent, or chatId' },
    {
      suffix: '/sessions/agent/bad%2Fchat/context-breakdown',
      error: 'Invalid hostRef, agent, or chatId',
    },
  ])('keeps pre-resolution session validation before W1 on $suffix', async route => {
    const response = await request(mountedApp())
      .get(`/rpc/hosts/invalid_host${route.suffix}`)
      .set('authorization', 'Bearer legacy-token')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: route.error })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('keeps message payload denial before W1', async () => {
    const response = await request(mountedApp())
      .post('/rpc/hosts/invalid_host/messages')
      .set('authorization', 'Bearer legacy-token')
      .send({ content: '' })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Invalid host message request payload' })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })

  it('keeps message attachment denial before W1', async () => {
    const response = await request(mountedApp())
      .post('/rpc/hosts/invalid_host/messages')
      .set('authorization', 'Bearer legacy-token')
      .send({ content: 'hello', attachments: 'invalid' })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: 'invalid_attachments',
      message: 'Image attachments must be a list.',
    })
    expect(hostMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
  })
})
