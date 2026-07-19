import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../src/routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  listAllowedServersForUser: vi.fn(),
  resolveServerConnectionForUser: vi.fn(),
  resolveHostConnectionForUser: vi.fn(),
  validateRpcRequest: vi.fn(),
  forwardRpcToServer: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  forwardHostActivity: vi.fn(),
  forwardHostStatus: vi.fn(),
  forwardHostHealth: vi.fn(),
}))

const controlApiMock = vi.hoisted(() => ({
  ControlApiHostAccessRejectedError: class ControlApiHostAccessRejectedError extends Error {
    constructor(public readonly status: number) {
      super(`Control API rejected host access (${status})`)
      this.name = 'ControlApiHostAccessRejectedError'
    }
  },
  requestHostWakeFromControlApi: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/mcpProxyService.js', () => serviceMock)
vi.mock('../src/services/controlApiRestService.js', () => controlApiMock)

describe('routes/rpc', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReset()
    serviceMock.listAllowedServersForUser.mockReset()
    serviceMock.resolveServerConnectionForUser.mockReset()
    serviceMock.resolveHostConnectionForUser.mockReset()
    serviceMock.validateRpcRequest.mockReset()
    serviceMock.forwardRpcToServer.mockReset()
    serviceMock.forwardHostMessageToHost.mockReset()
    serviceMock.forwardHostActivity.mockReset()
    serviceMock.forwardHostStatus.mockReset()
    serviceMock.forwardHostHealth.mockReset()
    controlApiMock.requestHostWakeFromControlApi.mockReset()
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createRpcRouter())
    return app
  }

  it('rejects list servers without token', async () => {
    const app = makeApp()
    await request(app).get('/rpc/servers').expect(401)
  })

  it('rejects invoke without mcp:server:invoke scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['mcp:servers:list'],
      hostRefs: ['mongodb-server'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })

    const app = makeApp()
    await request(app)
      .post('/rpc/mongodb-server')
      .set('authorization', 'Bearer token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(403)
  })

  it('returns 400 for invalid JSON-RPC payload', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['mcp:server:invoke'],
      hostRefs: ['mongodb-server'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveServerConnectionForUser.mockResolvedValue({
      name: 'mongodb-server',
      url: 'http://mongodb-server/mcp',
      headers: {},
    })
    serviceMock.validateRpcRequest.mockReturnValue(null)

    const app = makeApp()
    await request(app)
      .post('/rpc/mongodb-server')
      .set('authorization', 'Bearer token')
      .send({ bad: true })
      .expect(400)
      .expect({ error: 'Invalid JSON-RPC request payload' })
  })

  it('forwards invoke and returns JSON-RPC response', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['mcp:servers:list', 'mcp:server:invoke'],
      hostRefs: ['mongodb-server'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveServerConnectionForUser.mockResolvedValue({
      name: 'mongodb-server',
      url: 'http://mongodb-server/mcp',
      headers: {},
    })
    serviceMock.validateRpcRequest.mockReturnValue({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
    serviceMock.forwardRpcToServer.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'listCollections' }] },
    })

    const app = makeApp()
    const response = await request(app)
      .post('/rpc/mongodb-server')
      .set('authorization', 'Bearer token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200)

    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'listCollections' }] },
    })
    expect(serviceMock.resolveServerConnectionForUser).toHaveBeenCalledWith(
      'user-1',
      'mongodb-server',
      'token'
    )
  })

  it('rejects host message invoke without host:message:invoke scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['mcp:server:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hi', channelType: 'rpc', sender: 'desktop-app' })
      .expect(403)
  })

  it('returns 400 when host payload is invalid', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer token')
      .send({ method: 'tools/list' })
      .expect(400)
  })

  it('forwards host message invoke and returns REST response', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
    serviceMock.forwardHostMessageToHost.mockResolvedValue({
      success: true,
      response: 'pong',
    })

    const app = makeApp()
    const response = await request(app)
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer token')
      .send({
        content: 'ping',
        channelType: 'rpc',
        sender: 'desktop-app',
      })
      .expect(200)

    expect(response.body).toEqual({
      success: true,
      response: 'pong',
    })
    expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
      'user-1',
      'agent2',
      'token',
      {
        teamId: 'team-1',
      }
    )
  })

  it('resolves and binds through the canonical host-access call before forwarding a session request', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, response: 'pong' })

    await request(makeApp())
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer rpc-token')
      .set('idempotency-key', 'delivery-1')
      .send({ content: 'ping', threadId: 'session-1' })
      .expect(200)

    expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
      'user-1',
      'agent2',
      'rpc-token',
      {
        teamId: 'team-1',
        directRunBinding: {
          runId: expect.any(String),
          sessionId: 'session-1',
          origin: 'direct_chat',
        },
      }
    )
    expect(serviceMock.resolveHostConnectionForUser.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMock.forwardHostMessageToHost.mock.invocationCallOrder[0]
    )
    const forwarded = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
    expect(forwarded.traceContext).toEqual({
      version: 1,
      runId: expect.any(String),
      sessionId: 'session-1',
      origin: 'direct_chat',
      correlationRefs: expect.any(Array),
    })
    expect(forwarded.traceContext).not.toHaveProperty('userId')
    expect(forwarded.traceContext).not.toHaveProperty('actorHumanSub')
    expect(forwarded.traceContext).not.toHaveProperty('teamId')
  })

  it.each([
    [401, { error: 'Unauthorized' }],
    [403, { error: 'Forbidden: user cannot access this host' }],
    [409, { error: 'Direct run attribution conflict' }],
  ] as const)(
    'preserves a Control API %s from atomic host resolution and never forwards',
    async (status, expectedBody) => {
      authTokenMock.verifyRpcToken.mockReturnValue({
        sub: 'user-1',
        typ: 'user',
        accessScope: 'team',
        teamId: 'team-1',
        scopes: ['host:message:invoke'],
        hostRefs: ['agent2'],
        jti: 'j1',
        iat: 1,
        exp: 9999999999,
      })
      serviceMock.resolveHostConnectionForUser.mockRejectedValue(
        new controlApiMock.ControlApiHostAccessRejectedError(status)
      )

      await request(makeApp())
        .post('/rpc/hosts/agent2/messages')
        .set('authorization', 'Bearer rpc-token')
        .send({ content: 'ping', threadId: 'session-1' })
        .expect(status)
        .expect(expectedBody)

      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    }
  )

  it('preserves the request when the bounded binding write is transiently unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
      attributionBindingStatus: 'unavailable',
    })
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, response: 'pong' })

    await request(makeApp())
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer rpc-token')
      .send({ content: 'ping', threadId: 'session-1' })
      .expect(200)

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    const signal = String(warn.mock.calls[0]?.[0])
    expect(JSON.parse(signal)).toEqual({
      event: 'governed_trace_operational_error',
      scope: 'agent_run',
      reason: 'attribution_binding_unavailable',
    })
    expect(signal).not.toMatch(/user-1|agent2|session-1|ping|rpc-token|runId/)
  })

  // Regression: the `forwardedBody` is an explicit field allow-list, so a new
  // client field is dropped unless threaded through. The R2 "Option A"
  // piggybacked per-session `model` was silently omitted — assert it now
  // survives the hop (trimmed), and that a blank value is omitted entirely.
  it('forwards the piggybacked per-session model (trimmed) to the host', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, response: 'pong' })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'ping', channelType: 'rpc', sender: 'desktop-app', model: '  claude-x  ' })
      .expect(200)

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'claude-x' }),
      expect.anything()
    )
  })

  it('omits the model field when the piggybacked model is blank', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, response: 'pong' })

    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'ping', channelType: 'rpc', sender: 'desktop-app', model: '   ' })
      .expect(200)

    const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1] as Record<
      string,
      unknown
    >
    expect(forwardedBody.model).toBeUndefined()
  })

  it('returns 502 when host message upstream fails', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
    serviceMock.forwardHostMessageToHost.mockRejectedValue(new Error('Upstream host returned 500'))
    const app = makeApp()
    const response = await request(app)
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hello', channelType: 'rpc', sender: 'desktop-app' })
      .expect(502)
    expect(response.body).toEqual({ error: 'Upstream host unavailable' })
  })

  it('forwards host status and returns sanitized payload', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
    serviceMock.forwardHostStatus.mockResolvedValue({
      hostRef: 'agent2',
      agent: {
        state: 'idle',
        currentTaskId: null,
        tasksProcessed: 1,
        tasksSucceeded: 1,
        tasksFailed: 0,
        uptime: 1200,
      },
      queue: { pending: 0, processing: 0, completed: 1, failed: 0 },
      cronJobs: 0,
      pendingApprovalsCount: 0,
      observedAt: '2026-03-10T00:00:00.000Z',
    })
    const app = makeApp()
    const response = await request(app)
      .get('/rpc/hosts/agent2/status')
      .set('authorization', 'Bearer token')
      .expect(200)
    expect(response.body.hostRef).toBe('agent2')
    expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
      'user-1',
      'agent2',
      'token',
      {
        teamId: 'team-1',
      }
    )
  })

  it('rejects host status without host:status:read scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/status')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('rejects host activity without host:activity:read scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/activity')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('rejects host health without host:health:read scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/health')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('returns 403 for unauthorized host on host status', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/not-allowed/status')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('returns 403 for unauthorized host on host health', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:health:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/not-allowed/health')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('returns 403 for unauthorized host on host message invoke', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(null)
    const app = makeApp()
    await request(app)
      .post('/rpc/hosts/not-allowed/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hi', channelType: 'rpc', sender: 'desktop-app' })
      .expect(403)
  })
})
