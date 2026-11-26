import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_CLAIM_TYPE,
  HOST_EDGE_ASSERTION_HEADER,
  HOST_EDGE_ASSERTION_JWT_TYPE,
} from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import {
  createRpcHostStatusStreamRouter,
  resetHostStatusStreamRuntimeForTests,
} from '../src/routes/rpcHostStatusStream.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  forwardHostStatus: vi.fn(),
  // The route does `error instanceof UpstreamHostError` to classify
  // upstream auth failures (consecutive-401 → emit auth-expired). When
  // forwardHostStatus is mocked to reject, the catch block reaches into
  // the (mocked) module to read this class — vi.mock must mirror it or
  // the unhandled-rejection above triggers.
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
vi.mock('../src/authToken.js', () => authTokenMock)
// The route checks the held edge assertion's expiry before each poll with the
// real helper.
vi.mock('../src/services/mcpProxyService.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/mcpProxyService.js')>(
    '../src/services/mcpProxyService.js'
  )
  return { ...serviceMock, isHeldEdgeAssertionNearExpiry: actual.isHeldEdgeAssertionNearExpiry }
})

// An edge assertion signed the way control-api signs it (RS256, the assertion
// JWT type, the Host runtime audience), with `exp` 300 s ahead, so a poll runs.
const EDGE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })

function signedEdgeAssertionHeaders(): Record<string, string> {
  const now = Math.floor(Date.now() / 1000)
  const assertion = jwt.sign(
    {
      typ: HOST_EDGE_ASSERTION_CLAIM_TYPE,
      v: 1,
      iss: 'control-api',
      sub: 'user-1',
      host: `${config.hostNamespace}/agent2`,
      jti: randomUUID(),
      iat: now,
      exp: now + 300,
      teamId: 'team-1',
      scopes: ['host:status:read'],
    },
    EDGE_KEYS.privateKey,
    {
      algorithm: 'RS256',
      audience: HOST_EDGE_ASSERTION_AUDIENCE,
      header: { alg: 'RS256', typ: HOST_EDGE_ASSERTION_JWT_TYPE },
    }
  )
  return { [HOST_EDGE_ASSERTION_HEADER]: assertion }
}

const defaultStreamConfig = {
  streamMaxConcurrent: config.streamMaxConcurrent,
  streamMaxPerUser: config.streamMaxPerUser,
  streamMaxPerUserHost: config.streamMaxPerUserHost,
  streamMaxLifetimeMs: config.streamMaxLifetimeMs,
  streamIntervalMs: config.streamIntervalMs,
  streamKeepaliveMs: config.streamKeepaliveMs,
  streamIdleTimeoutMs: config.streamIdleTimeoutMs,
}

describe('routes/rpcHostStatusStream', () => {
  beforeEach(() => {
    resetHostStatusStreamRuntimeForTests()
    authTokenMock.verifyRpcToken.mockReset()
    serviceMock.resolveHostConnectionForUser.mockReset()
    serviceMock.forwardHostStatus.mockReset()
    Object.assign(config, defaultStreamConfig)
  })

  function makeApp() {
    const app = express()
    app.use(createRpcHostStatusStreamRouter())
    return app
  }

  it('rejects host status stream without token', async () => {
    const app = makeApp()
    await request(app).get('/rpc/hosts/agent2/status/stream').expect(401)
  })

  it('rejects host status stream without host:status:read scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['mcp:servers:list'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/status/stream')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('rejects host status stream for unauthorized host', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      denied: true,
      code: 'host_access_denied',
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/nope/status/stream')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('rejects host status stream for empty hostRef', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/%20/status/stream')
      .set('authorization', 'Bearer token')
      .expect(400)
  })

  it('rejects host status stream for wildcard hostRef', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/%2A/status/stream')
      .set('authorization', 'Bearer token')
      .expect(400)
  })

  it('returns 429 when global stream limit is exceeded', async () => {
    config.streamMaxConcurrent = 0
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
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
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/status/stream')
      .set('authorization', 'Bearer token')
      .expect(429)
  })

  it('returns 429 when per-user stream limit is exceeded', async () => {
    config.streamMaxConcurrent = 1000
    config.streamMaxPerUser = 0
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
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
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/status/stream')
      .set('authorization', 'Bearer token')
      .expect(429)
  })

  it('stream emits sanitized error payload without internal details', async () => {
    config.streamMaxLifetimeMs = 40
    config.streamIntervalMs = 5
    config.streamKeepaliveMs = 5
    config.streamIdleTimeoutMs = 15
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
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
      headers: signedEdgeAssertionHeaders(),
    })
    serviceMock.forwardHostStatus.mockRejectedValue(
      new Error('fetch failed for http://internal.service.local/token=secret')
    )
    const app = makeApp()
    const response = await request(app)
      .get('/rpc/hosts/agent2/status/stream')
      .set('authorization', 'Bearer token')
      .expect(200)
    // Witness: the error event comes from the rejected poll.
    expect(serviceMock.forwardHostStatus).toHaveBeenCalled()
    expect(response.text).toContain('event: error')
    expect(response.text).toContain('Status temporarily unavailable')
    expect(response.text).not.toContain('internal.service.local')
    expect(response.text).not.toContain('token=secret')
  })

  it('rejects stream requests carrying a request body', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/status/stream')
      .set('authorization', 'Bearer token')
      .set('content-type', 'application/json')
      .set('content-length', '2')
      .send('{}')
      .expect(400)
  })

  it('stream emits open/status/closed events only for successful poll flow', async () => {
    config.streamMaxLifetimeMs = 30
    config.streamIntervalMs = 5
    config.streamKeepaliveMs = 5
    config.streamIdleTimeoutMs = 100
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
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
      headers: signedEdgeAssertionHeaders(),
    })
    serviceMock.forwardHostStatus.mockResolvedValue({
      hostRef: 'agent2',
      agent: {
        state: 'idle',
        currentTaskId: null,
        tasksProcessed: 1,
        tasksSucceeded: 1,
        tasksFailed: 0,
        uptime: 10,
      },
      queue: { pending: 0, processing: 0, completed: 1, failed: 0 },
      cronJobs: 0,
      pendingApprovalsCount: 0,
      observedAt: '2026-03-11T00:00:00.000Z',
    })
    const app = makeApp()
    const response = await request(app)
      .get('/rpc/hosts/agent2/status/stream')
      .set('authorization', 'Bearer token')
      .expect(200)
    expect(response.text).toContain('event: open')
    expect(response.text).toContain('event: status')
    expect(response.text).toContain('event: closed')
    expect(response.text).not.toContain('event: message')
  })
})
