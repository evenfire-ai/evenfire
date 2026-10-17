import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

/**
 * The OAuth callback configuration read by the Marketplace install form lives behind
 * requireAuthForControlUI like every other /admin route. routes.oauthProviders.test.ts
 * mounts the router alone and cannot see that boundary; this suite pins it with the
 * real middleware in place.
 */
describe('GET /api/v1/admin/oauth/callback auth boundary', () => {
  it('rejects an unauthenticated read with 401', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const res = await request(app).get('/api/v1/admin/oauth/callback')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })
})
