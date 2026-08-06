import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

const AUTH_PROXY_TOKEN = 'dev-auth-proxy-token'

describe('internal auth callback routes', () => {
  it('rejects unauthenticated callback forwarding', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const res = await request(app).get(
      '/api/v1/internal/auth-callback/identity-provider-callback/microsoft?code=C&state=S'
    )

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('rejects service tokens that are not for auth-proxy', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const res = await request(app)
      .get('/api/v1/internal/auth-callback/identity-provider-callback/microsoft?code=C&state=S')
      .set('Authorization', 'Bearer dev-webhook-proxy-token')
      .set('x-service-token', 'webhook-proxy')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('runs callback validation after the auth-proxy service gate passes', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const res = await request(app)
      .get('/api/v1/internal/auth-callback/identity-provider-callback/microsoft')
      .set('Authorization', `Bearer ${AUTH_PROXY_TOKEN}`)
      .set('x-service-token', 'auth-proxy')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'missing_code_or_state' })
  })
})
