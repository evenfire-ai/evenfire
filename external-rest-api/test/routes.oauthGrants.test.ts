import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createOauthGrantsRouter } from '../src/routes/oauthGrants.js'

const authTokenMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  listOauthGrants: vi.fn(),
  revokeOauthGrant: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/oauthGrantsService.js', () => serviceMock)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createOauthGrantsRouter())
  return app
}

describe('routes/oauthGrants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: 9_999_999_999,
    })
  })

  it('uses the request correlation when a sanitized upstream error has none', async () => {
    serviceMock.listOauthGrants.mockRejectedValueOnce(
      new ControlApiError('private upstream detail', 403, { error: { code: 'forbidden' } })
    )

    const response = await request(makeApp())
      .get('/oauth/grants')
      .set('authorization', 'Bearer session-token')
      .set('x-correlation-id', 'oauth_grants_ID-42')
      .expect(403)

    expect(response.body.error.correlationId).toBe('oauth_grants_ID-42')
  })
})
