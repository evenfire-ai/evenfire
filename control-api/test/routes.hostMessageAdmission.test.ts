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

describe('Host-message resolution parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    directory.getUserAgents.mockImplementation(async (userId: string) => ({
      userId,
      agentNames: ['host-a', 'host-b'],
    }))
    directory.getCurrentTeam.mockResolvedValue({ id: 'team-a', role: 'member' })
    directory.getTeamAgents.mockResolvedValue({ agentNames: ['host-a', 'host-b'] })
  })

  it('authorizes more than 60 mixed ordinary and bound sends without a limiter', async () => {
    const { server, gateway, bindingService } = app()
    const jwt = token(USER_A, ['host-a', 'host-b'])
    let charges = 0
    limiter.checkAndIncrement.mockImplementation(async (_key: string, maximum: number) => {
      charges += 1
      return {
        allowed: charges <= maximum,
        remaining: Math.max(0, maximum - charges),
        resetMs: Date.now() + 60_000,
        windowStartMs: Date.now(),
        count: charges,
        backendAvailable: true,
      }
    })
    for (let index = 0; index < 66; index += 1) {
      const host = index % 2 ? 'host-b' : 'host-a'
      const binding = { ...BINDING, sessionId: `session-${index}` }
      if (index % 3 === 0) {
        await request(server)
          .post(LEGACY_ROUTE(USER_A, host))
          .set('x-rpc-access-token', jwt)
          .send(binding)
          .expect(200)
      } else {
        await send(server, USER_A, host, index % 3 === 1 ? binding : {}, jwt).expect(200)
      }
    }
    expect(gateway.listResource).toHaveBeenCalledTimes(66)
    expect(bindingService.bind).toHaveBeenCalledTimes(44)
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
  })

  it('rejects invalid auth, scope, claim, and binding before protected work', async () => {
    const { server, gateway, bindingService } = app()
    // A valid request proves the Host authorization and binding are observable.
    await request(server)
      .post(LEGACY_ROUTE(USER_A, 'host-a'))
      .set('x-rpc-access-token', token(USER_A, ['host-a']))
      .send(BINDING)
      .expect(200)
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
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
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(gateway.listResource).toHaveBeenCalledOnce()
    expect(bindingService.bind).toHaveBeenCalledOnce()
  })

  it('denies a missing live grant without a limiter call', async () => {
    const { server, gateway } = app()
    directory.getUserAgents.mockResolvedValue({ userId: USER_A, agentNames: [] })
    directory.getTeamAgents.mockResolvedValue({ agentNames: [] })
    await send(server, USER_A, 'host-a', {}).expect(403)
    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it('denies unbound user and Host selectors before protected work', async () => {
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
