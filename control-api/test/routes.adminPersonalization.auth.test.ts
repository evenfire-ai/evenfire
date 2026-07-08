import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

describe('admin personalization auth gate', () => {
  it('rejects unauthenticated GET and PUT requests', async () => {
    const app = createApp(new MockGateway('mcp-host') as never)

    const getRes = await request(app).get('/api/v1/admin/hosts/foo/personalization')
    expect(getRes.status).toBe(401)

    const putRes = await request(app)
      .put('/api/v1/admin/hosts/foo/personalization')
      .send({ identity: 'x', resourceVersion: '1' })
    expect(putRes.status).toBe(401)
  })
})
