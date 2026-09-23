import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createRpcAccessUsersRouter } from '../src/routes/rpc-access/users.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

const directory = vi.hoisted(() => ({
  getUserAgents: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
  getUserContexts: vi.fn(),
}))
const limiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/services/rateLimiterService.js', () => limiter)

const USER_A = '00000000-0000-4000-8000-000000000001'
const USER_B = '00000000-0000-4000-8000-000000000002'
const ROUTE = (user: string, host: string) =>
  `/rpc/access/users/${user}/mcp-hosts/${host}/message-resolution`
const BINDING = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'session-a',
  origin: 'direct_chat',
}

function token(user: string, hosts: string[], scopes = ['host:message:invoke']) {
  return signRpcAccessToken({
    sub: user,
    typ: 'user',
    teamId: 'team-a',
    role: 'member',
    scopes: scopes as ['host:message:invoke'],
    hostRefs: hosts,
    jti: `jti-${user}`,
  })
}

function app() {
  const gateway = {
    listResource: vi.fn(async () => [
      { metadata: { name: 'host-a' }, spec: { enabled: true } },
      { metadata: { name: 'host-b' }, spec: { enabled: true } },
    ]),
  }
  const bindingService = { bind: vi.fn(async () => ({ status: 'created' })) }
  const server = express()
  server.use(createRpcAccessUsersRouter(gateway as unknown as K8sGateway, { bindingService }))
  return { server, gateway, bindingService }
}

function send(
  server: express.Express,
  user: string,
  host: string,
  body: object,
  jwt = token(user, [host])
) {
  return request(server).post(ROUTE(user, host)).set('x-rpc-access-token', jwt).send(body)
}

describe('R44-H1 legacy Host-message admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    directory.getUserAgents.mockImplementation(async (userId: string) => ({
      userId,
      agentNames: ['host-a', 'host-b'],
    }))
    directory.getCurrentTeam.mockResolvedValue({ id: 'team-a', role: 'member' })
    directory.getTeamAgents.mockResolvedValue({ agentNames: ['host-a', 'host-b'] })
    const counts = new Map<string, number>()
    limiter.checkAndIncrement.mockImplementation(async (key: string, max: number) => {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return {
        allowed: count <= max,
        remaining: Math.max(0, max - count),
        resetMs: Date.now() + 30_000,
        windowStartMs: Date.now() - 30_000,
        count,
        backendAvailable: true,
      }
    })
  })

  it('allows 60 ordinary and bound sends in one subject bucket, then denies before Host work', async () => {
    const { server, gateway, bindingService } = app()
    const jwt = token(USER_A, ['host-a', 'host-b'])
    for (let index = 0; index < 60; index += 1) {
      const host = index % 2 ? 'host-b' : 'host-a'
      const body = index % 2 ? { ...BINDING, sessionId: `session-${index}` } : {}
      await send(server, USER_A, host, body, jwt).expect(200)
    }
    const resolverCalls = gateway.listResource.mock.calls.length
    const bindingCalls = bindingService.bind.mock.calls.length
    const denied = await send(
      server,
      USER_A,
      'host-b',
      { ...BINDING, sessionId: 'rotated' },
      jwt
    ).expect(429)
    expect(denied.body).toEqual({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0)
    for (const header of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      expect(denied.headers[header]).toBeDefined()
    }
    expect(gateway.listResource).toHaveBeenCalledTimes(resolverCalls)
    expect(bindingService.bind).toHaveBeenCalledTimes(bindingCalls)
    expect(new Set(limiter.checkAndIncrement.mock.calls.map(call => call[0])).size).toBe(1)
    const producerClient =
      await import('../../rpc-proxy/src/services/controlApiRestService.js').then(
        module => ({ module }),
        error => ({ error })
      )
    expect(producerClient).toHaveProperty('module')
    if (!('module' in producerClient)) return

    const fetchHostConnectionFromControlApi =
      producerClient.module.fetchHostConnectionFromControlApi
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const rpcPath = new URL(url).pathname.split('/rpc/access')[1]
      expect(rpcPath).toBeDefined()
      const produced = await request(server)
        .post(`/rpc/access${rpcPath}`)
        .set('x-rpc-access-token', jwt)
        .send(JSON.parse(String(init.body)))
      return new Response(produced.text, {
        status: produced.status,
        headers: produced.headers as Record<string, string>,
      })
    }) as unknown as typeof fetch
    await expect(
      fetchHostConnectionFromControlApi(USER_A, 'host-b', jwt, {
        messageResolution: true,
        fetchImpl,
      })
    ).rejects.toMatchObject({
      status: 429,
      body: { error: 'Too Many Requests', retryAfterSeconds: expect.any(Number) },
      headers: { 'x-ratelimit-limit': '60' },
    })
    expect(gateway.listResource).toHaveBeenCalledTimes(resolverCalls)
    await send(server, USER_B, 'host-a', {}).expect(200)
  })

  it('leaves shared GET and the existing strict POST outside message admission', async () => {
    const { server } = app()
    const jwt = token(USER_A, ['host-a'])
    await request(server)
      .get(`/rpc/access/users/${USER_A}/mcp-hosts/host-a`)
      .set('x-rpc-access-token', jwt)
      .expect(200)
    await request(server)
      .post(`/rpc/access/users/${USER_A}/mcp-hosts/host-a`)
      .set('x-rpc-access-token', jwt)
      .send({})
      .expect(400)
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
  })

  it('rejects invalid auth, scope, claim, and binding before charging', async () => {
    const { server, gateway } = app()
    await request(server).post(ROUTE(USER_A, 'host-a')).send({}).expect(401)
    await send(server, USER_A, 'host-a', {}, 'bad-token').expect(401)
    await send(
      server,
      USER_A,
      'host-a',
      {},
      token(USER_A, ['host-a'], ['host:status:read'])
    ).expect(403)
    await send(server, USER_A, 'host-a', {}, token(USER_B, ['host-a'])).expect(403)
    await send(server, USER_A, 'host-b', {}, token(USER_A, ['host-a'])).expect(403)
    await send(server, USER_A, 'host-a', { runId: 'bad' }).expect(400)
    await request(server)
      .post(ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', token(USER_A, ['host-a']))
      .set('content-type', 'application/json')
      .send('{"runId":')
      .expect(400)
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it('charges a valid request before a later live grant denial', async () => {
    const { server, gateway } = app()
    directory.getUserAgents.mockResolvedValue({ userId: USER_A, agentNames: [] })
    directory.getTeamAgents.mockResolvedValue({ agentNames: [] })
    await send(server, USER_A, 'host-a', {}).expect(403)
    expect(limiter.checkAndIncrement).toHaveBeenCalledOnce()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it.each([
    ['backend unavailable', { allowed: true, backendAvailable: false, count: 0 }],
    ['missing result', undefined],
    [
      'malformed result',
      { allowed: true, backendAvailable: true, count: 61, resetMs: Date.now() + 30_000 },
    ],
  ])('fails closed when %s', async (_name, result) => {
    limiter.checkAndIncrement.mockResolvedValue(result)
    const { server, gateway } = app()
    await send(server, USER_A, 'host-a', {})
      .expect(503)
      .expect({ error: 'host_message_admission_unavailable' })
    expect(gateway.listResource).not.toHaveBeenCalled()
  })
})
