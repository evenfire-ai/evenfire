import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

describe('OIDC Profile UI foundation service boundary', () => {
  it('does not expose the protocol bridge as a public Control API route', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const response = await request(app).get('/api/v1/external/oidc/profile-flow/configuration')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
  })
})
