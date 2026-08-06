import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'

describe('external-rest-api callback surface', () => {
  it('does not expose OAuth callback passthrough routes', async () => {
    const app = createApp()

    await expect(
      request(app).get('/api/v1/oauth-callback/google-gmail?state=STATE&code=CODE')
    ).resolves.toMatchObject({ status: 404 })
    await expect(
      request(app).get('/api/v1/identity-provider-callback/microsoft?state=STATE&code=CODE')
    ).resolves.toMatchObject({ status: 404 })
  })
})
