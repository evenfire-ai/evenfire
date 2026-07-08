import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { pool } from '../src/db.js'
import { MockGateway } from './mockGateway.js'

describe('app router wiring', () => {
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
    }

    await request(app)
      .post('/api/v1/external/auth/session-token')
      .set('authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send(payload)
      .expect(401)

    vi.spyOn(pool, 'query').mockResolvedValueOnce({ rows: [{}], rowCount: 1 })

    const res = await request(app)
      .post('/api/v1/external/auth/session-token')
      .set('authorization', 'Bearer dev-external-rest-api-token')
      .set('x-service-token', 'external-rest-api')
      .send(payload)
      .expect(200)
    expect(res.body.token).toBeTruthy()
  })

  it('enforces UI auth for control-ui routes', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app).get('/api/v1/admin/hosts').expect(401)
    await request(app).get('/api/v1/admin/users').expect(401)
  })
})
