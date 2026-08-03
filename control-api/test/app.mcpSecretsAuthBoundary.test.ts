import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

/**
 * Credential rotation (issue #223) writes Secrets in the mcp-server namespace.
 * The route lives behind requireAuthForControlUI like every other /admin route;
 * this suite pins that boundary from the outside, with the real middleware in
 * place — routes.mcpSecrets.test.ts mounts the router alone and therefore
 * cannot see it.
 */
describe('PUT /api/v1/admin/mcp-secrets/:name auth boundary', () => {
  it('rejects an unauthenticated rotation with 401', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const res = await request(app)
      .put('/api/v1/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 'rotated-value' } })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })
})
