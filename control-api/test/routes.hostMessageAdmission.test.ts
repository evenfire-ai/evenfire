import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { fetchHostConnectionFromControlApi } from '../../rpc-proxy/src/services/controlApiRestService.js'
import { config } from '../src/config.js'
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
const LEGACY_ROUTE = (user: string, host: string) => `/rpc/access/users/${user}/mcp-hosts/${host}`
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

  it('charges the legacy strict POST into the same subject bucket as message-resolution', async () => {
    const { server, gateway, bindingService } = app()
    const jwt = token(USER_A, ['host-a', 'host-b'])
    const limit = config.hostMessageRlPerMin
    const legacyStatuses: number[] = []
    const resolutionStatuses: number[] = []
    for (let index = 0; index < limit; index += 1) {
      const host = index % 2 ? 'host-b' : 'host-a'
      if (index % 2 === 0) {
        const legacy = await request(server)
          .post(LEGACY_ROUTE(USER_A, host))
          .set('x-rpc-access-token', jwt)
          .send({ ...BINDING, sessionId: `legacy-${index}` })
        legacyStatuses.push(legacy.status)
      } else {
        const resolution = await send(server, USER_A, host, {}, jwt)
        resolutionStatuses.push(resolution.status)
      }
    }
    // Witness: both routes admitted requests into the shared bucket before it
    // filled, so the refusals below cannot come from a route that never worked.
    expect(legacyStatuses.length).toBeGreaterThan(0)
    expect(resolutionStatuses.length).toBeGreaterThan(0)
    expect(legacyStatuses).toEqual(Array.from({ length: legacyStatuses.length }, () => 200))
    expect(resolutionStatuses).toEqual(Array.from({ length: resolutionStatuses.length }, () => 200))

    const resolverCalls = gateway.listResource.mock.calls.length
    const bindingCalls = bindingService.bind.mock.calls.length
    // Witness: the admitted half really authorized and bound, so the unchanged
    // counts after both refusals are not a zero-against-zero comparison.
    expect(resolverCalls).toBeGreaterThan(0)
    expect(bindingCalls).toBeGreaterThan(0)
    const legacyDenied = await request(server)
      .post(LEGACY_ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', jwt)
      .send({ ...BINDING, sessionId: 'legacy-denied' })
      .expect(429)
    const resolutionDenied = await send(server, USER_A, 'host-b', {}, jwt).expect(429)
    expect(legacyDenied.body).toEqual({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
    expect(resolutionDenied.body).toEqual({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
    expect(gateway.listResource).toHaveBeenCalledTimes(resolverCalls)
    expect(bindingService.bind).toHaveBeenCalledTimes(bindingCalls)
    expect(new Set(limiter.checkAndIncrement.mock.calls.map(call => call[0]))).toEqual(
      new Set([`host-message-admission:${USER_A}`])
    )
    expect(limiter.checkAndIncrement).toHaveBeenCalledTimes(limit + 2)

    // A different verified subject keeps its own bucket on either route.
    await request(server)
      .post(LEGACY_ROUTE(USER_B, 'host-a'))
      .set('x-rpc-access-token', token(USER_B, ['host-a']))
      .send(BINDING)
      .expect(200)
  })

  it('leaves the shared GET outside admission and charges the strict POST only after a valid body', async () => {
    const { server } = app()
    const jwt = token(USER_A, ['host-a'])
    await request(server)
      .get(`/rpc/access/users/${USER_A}/mcp-hosts/host-a`)
      .set('x-rpc-access-token', jwt)
      .expect(200)
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    await request(server)
      .post(LEGACY_ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', jwt)
      .send({})
      .expect(400)
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    await request(server)
      .post(LEGACY_ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', jwt)
      .send(BINDING)
      .expect(200)
    expect(limiter.checkAndIncrement).toHaveBeenCalledOnce()
    expect(limiter.checkAndIncrement).toHaveBeenCalledWith(
      `host-message-admission:${USER_A}`,
      config.hostMessageRlPerMin
    )
  })

  it('rejects invalid auth, scope, claim, and binding before charging', async () => {
    const { server, gateway, bindingService } = app()
    // Liveness witness: one fully valid bound request proves the limiter, live
    // Host authorization, and the binding are observable in this test.
    await request(server)
      .post(LEGACY_ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', token(USER_A, ['host-a']))
      .send(BINDING)
      .expect(200)
    expect(limiter.checkAndIncrement).toHaveBeenCalledOnce()
    expect(gateway.listResource).toHaveBeenCalledOnce()
    expect(bindingService.bind).toHaveBeenCalledOnce()

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
    await request(server)
      .post(LEGACY_ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', token(USER_B, ['host-a']))
      .send(BINDING)
      .expect(403)
      .expect('x-host-access-denial-reason', 'subject_mismatch')
    await request(server)
      .post(LEGACY_ROUTE(USER_A, 'host-b'))
      .set('x-rpc-access-token', token(USER_A, ['host-a']))
      .send(BINDING)
      .expect(403)
      .expect('x-host-access-denial-reason', 'host_claim_missing')
    await send(server, USER_A, 'host-a', { runId: 'bad' }).expect(400)
    await request(server)
      .post(ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', token(USER_A, ['host-a']))
      .set('content-type', 'application/json')
      .send('{"runId":')
      .expect(400)
    // Every rejected shape above left the witness baseline unchanged.
    expect(limiter.checkAndIncrement).toHaveBeenCalledOnce()
    expect(gateway.listResource).toHaveBeenCalledOnce()
    expect(bindingService.bind).toHaveBeenCalledOnce()
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

  it('denies unbound user and Host selectors before admission or protected work', async () => {
    const subjectCase = app()
    const subjectMismatch = await send(
      subjectCase.server,
      USER_B,
      'host-a',
      {},
      token(USER_A, ['host-a'])
    ).expect(403)
    expect(subjectMismatch.headers['x-host-access-denial-reason']).toBe('subject_mismatch')
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(subjectCase.gateway.listResource).not.toHaveBeenCalled()

    const hostCase = app()
    const hostMismatch = await send(
      hostCase.server,
      USER_A,
      'host-b',
      {},
      token(USER_A, ['host-a'])
    ).expect(403)
    expect(hostMismatch.headers['x-host-access-denial-reason']).toBe('host_claim_missing')
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(hostCase.gateway.listResource).not.toHaveBeenCalled()
  })

  it('keeps deterministic body rejection ahead of the token-bound selectors', async () => {
    const { server, gateway } = app()
    const response = await send(
      server,
      USER_B,
      'host-b',
      { invalid: true },
      token(USER_A, ['host-a'])
    ).expect(400)
    expect(response.body).toEqual({ error: 'invalid_direct_run_binding' })
    expect(response.headers['x-host-access-denial-reason']).toBeUndefined()
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })
})
