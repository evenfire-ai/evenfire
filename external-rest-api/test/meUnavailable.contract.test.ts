import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createMeRouter } from '../src/routes/me.js'

const mocks = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
  verifyToken: vi.fn(),
}))

vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return { ...actual, controlApiRequest: mocks.controlApiRequest }
})
vi.mock('../src/authToken.js', () => ({ verifyToken: mocks.verifyToken }))

describe('External REST /me unavailable producer contract', () => {
  beforeEach(() => {
    mocks.controlApiRequest.mockReset()
    mocks.verifyToken.mockReset().mockReturnValue({
      userId: 'synthetic-member-id',
      email: 'member@example.invalid',
      teamId: '',
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('maps a Control API outage to the route 404 consumed by the recovery UI', async () => {
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError(
        'private Control API failure',
        503,
        { error: 'authority_failure' },
        {
          'retry-after': '60',
        }
      )
    )
    const app = express()
    app.use(createMeRouter())

    const response = await request(app)
      .get('/me')
      .set('authorization', 'Bearer synthetic-session-token')

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'User not found' })
    expect(response.headers['retry-after']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/private|authority|synthetic/)
    expect(mocks.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/users/synthetic-member-id/me',
      expect.objectContaining({ userSessionToken: 'synthetic-session-token' })
    )
  })

  it('preserves an authenticated /me response with no active team', async () => {
    mocks.controlApiRequest.mockResolvedValue({
      id: 'synthetic-member-id',
      email: 'member@example.invalid',
      name: 'Member',
      picture: null,
      teamId: null,
      teamName: null,
      role: null,
      profile: { displayName: 'Member', channels: {} },
    })
    const app = express()
    app.use(createMeRouter())

    const response = await request(app)
      .get('/me')
      .set('authorization', 'Bearer synthetic-session-token')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      id: 'synthetic-member-id',
      teamId: null,
      teamName: null,
      role: null,
    })
    expect(mocks.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/users/synthetic-member-id/me',
      expect.objectContaining({ query: { teamId: '' } })
    )
  })
})
