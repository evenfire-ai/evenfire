import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { pool } from '../src/db.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import { MockGateway } from './mockGateway.js'

const rateLimiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
vi.mock('../src/services/rateLimiterService.js', () => rateLimiter)

function signHccInternalControl(): string {
  return jwt.sign(
    { iss: 'hcc', aud: 'control-api', sub: 'hcc-provisioner' },
    config.internalControlJwtHccHmacSecret,
    { algorithm: 'HS256', expiresIn: 60, jwtid: 'hcc-health-transition-test' }
  )
}

describe('app router wiring', () => {
  beforeEach(() => {
    rateLimiter.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves health and not-found routes', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const healthRes = await request(app).get('/health').expect(200)
    expect(healthRes.body).toMatchObject({
      status: 'ok',
      namespace: 'mcp-server',
    })

    await request(app).get('/does-not-exist').expect(404)
  })

  it('accepts JSON bodies above the former 1 MiB parser limit', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    const payload = 'x'.repeat(1024 * 1024 + 64 * 1024)

    await request(app).post('/does-not-exist').send({ payload }).expect(404)
  })

  it('returns 413 when an operator GFS proxy JSON body exceeds the configured parser limit', async () => {
    const previousLimit = config.jsonBodyLimit
    config.jsonBodyLimit = '1kb'
    try {
      const app = createApp(new MockGateway('mcp-server') as never)
      const payload = 'x'.repeat(2048)

      await request(app)
        .post('/api/v1/gfs/proxy/v1/resources/root/children')
        .send({ payload })
        .expect(413)
    } finally {
      config.jsonBodyLimit = previousLimit
    }
  })

  it('uses the dedicated 512 KiB parser for internal tracing submissions', async () => {
    const previousLimit = config.jsonBodyLimit
    config.jsonBodyLimit = '1kb'
    try {
      const app = createApp(new MockGateway('mcp-server') as never)
      const { token } = issueMcpHostAccessJwt('sandbox-recipes', 'trace-parser-test', [
        'trace-parser-host',
      ])
      const validSizedBody = {
        events: [
          {
            eventType: 'run_start',
            sourceEventId: 'start-1',
            occurredAt: '2026-07-11T00:00:00.000Z',
          },
        ],
        padding: 'x'.repeat(2 * 1024),
      }

      // This reaches tracing auth instead of being rejected by the unrelated
      // global 1 KiB parser. The missing credential is the expected boundary.
      await request(app)
        .post('/api/v1/internal/tracing/agent-run-events')
        .send(validSizedBody)
        .expect(403)

      await request(app)
        .post('/api/v1/internal/tracing/agent-run-events')
        .auth(token, { type: 'bearer' })
        .send({ events: [{ payload: 'x'.repeat(512 * 1024) }] })
        .expect(413)

      await request(app)
        .post('/api/v1/internal/tracing/agent-run-events/')
        .auth(token, { type: 'bearer' })
        .send({ events: [{ payload: 'x'.repeat(512 * 1024) }] })
        .expect(413)
    } finally {
      config.jsonBodyLimit = previousLimit
    }
  })

  it('uses the dedicated 2 KiB parser for canonical Host resolve-and-bind requests', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    const rpcToken = signRpcAccessToken({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      role: 'member',
      scopes: ['host:message:invoke'],
      hostRefs: ['host-a'],
      jti: 'app-host-binding-body-limit',
    })

    await request(app)
      .post('/api/v1/rpc/access/users/user-1/mcp-hosts/host-a')
      .set('authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .set('x-rpc-access-token', rpcToken)
      .send({
        runId: '00000000-0000-4000-8000-000000000123',
        sessionId: 'x'.repeat(3_000),
        origin: 'direct_chat',
      })
      .expect(413)

    await request(app)
      .post('/API/V1/RPC/ACCESS/USERS/user-1/MCP-HOSTS/host-a')
      .set('authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .set('x-rpc-access-token', rpcToken)
      .send({
        runId: '00000000-0000-4000-8000-000000000123',
        sessionId: 'x'.repeat(3_000),
        origin: 'direct_chat',
      })
      .expect(413)
  })

  it('rejects an HCC health transition when no server-verifiable Host binding source exists', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const response = await request(app)
      .post('/api/v1/internal/tracing/infrastructure-telemetry-events')
      .set('Authorization', `Bearer ${signHccInternalControl()}`)
      .send({
        events: [
          {
            sourceEventId: 'health-transition-1',
            occurredAt: '2026-07-11T10:00:00.000Z',
            telemetryType: 'health_transition',
          },
        ],
      })
      .expect(403)

    expect(response.body.error).toBe(
      'HCC telemetry rejected: no server-verifiable Host reference exists.'
    )
  })

  it('enforces internal auth for internal routes', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app).get('/api/v1/external/users/u1/teams').expect(401)
  })

  it('pins /external routes to the external-rest-api service identity', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    const payload = {
      role: 'member',
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      authGeneration: 1,
    }
    const currentToken = signExternalSessionToken(payload)

    await request(app)
      .post('/api/v1/external/auth/session-token')
      .set('authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send(payload)
      .expect(401)

    vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({
        rows: [
          {
            id: payload.userId,
            lifecycle_state: 'active',
            lifecycle_version: 1,
            valid_after: null,
            token_revoked: false,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ role: payload.role, lifecycle_version: 1 }],
        rowCount: 1,
      })

    const res = await request(app)
      .post('/api/v1/external/auth/session-token')
      .set('authorization', 'Bearer dev-external-rest-api-token')
      .set('x-service-token', 'external-rest-api')
      .set('x-user-session-token', currentToken)
      .send(payload)
      .expect(200)
    expect(res.body.token).toBeTruthy()
  })

  it('enforces UI auth for control-ui routes', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app).get('/api/v1/admin/hosts').expect(401)
    await request(app).get('/api/v1/admin/users').expect(401)
    await request(app).get('/api/v1/admin/tracing/operations').expect(401)
  })
})
