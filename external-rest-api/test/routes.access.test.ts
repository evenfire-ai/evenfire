import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createAccessRouter } from '../src/routes/access.js'

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  controlApiRequest: vi.fn(),
}))

vi.mock('../src/authToken.js', () => ({ verifyToken: mocks.verifyToken }))
vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return { ...actual, controlApiRequest: mocks.controlApiRequest }
})

function app() {
  const value = express()
  value.use(express.json())
  value.use(createAccessRouter())
  return value
}

describe('public access-contract forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyToken.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.test',
      teamId: null,
      role: 'member',
      exp: 2_000_000_000,
    })
  })

  it('forwards capabilities and catalog query fields with the same user session', async () => {
    mocks.controlApiRequest.mockResolvedValueOnce({ catalogServed: false })
    await request(app())
      .get('/me/access/capabilities')
      .set('authorization', 'Bearer session-token')
      .expect(200, { catalogServed: false })
    expect(mocks.controlApiRequest).toHaveBeenLastCalledWith(
      'GET',
      '/external/access/capabilities',
      { userSessionToken: 'session-token' }
    )

    mocks.controlApiRequest.mockResolvedValueOnce({ items: [] })
    await request(app())
      .get('/me/access/catalog?families=team%2Chost&limit=25&cursor=c3.value.signature')
      .set('authorization', 'Bearer session-token')
      .expect(200, { items: [] })
    expect(mocks.controlApiRequest).toHaveBeenLastCalledWith(
      'GET',
      '/external/access/catalog',
      expect.objectContaining({
        userSessionToken: 'session-token',
        query: {
          families: 'team,host',
          limit: '25',
          cursor: 'c3.value.signature',
        },
      })
    )
  })

  it('forwards resolve bodies without interpreting action identity', async () => {
    const body = {
      requiredCapability: 'team.read',
      resource: { environmentId: 'env', type: 'team', logicalId: 'team-1' },
    }
    mocks.controlApiRequest.mockResolvedValue({ status: 'allowed' })
    await request(app())
      .post('/me/access/resolve')
      .set('authorization', 'Bearer session-token')
      .send(body)
      .expect(200, { status: 'allowed' })
    expect(mocks.controlApiRequest).toHaveBeenCalledWith('POST', '/external/access/resolve', {
      userSessionToken: 'session-token',
      body,
    })
  })

  it('rebuilds a bounded public error instead of forwarding upstream fields', async () => {
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError('upstream', 503, {
        error: {
          code: 'authority_unavailable',
          message: 'SQL /secret/path',
          correlationId: 'safe-id',
          retryable: true,
          details: { internal: 'secret' },
        },
      })
    )
    const response = await request(app())
      .get('/me/access/capabilities')
      .set('authorization', 'Bearer session-token')
    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: {
        code: 'authority_unavailable',
        message: 'Authorization is temporarily unavailable.',
        correlationId: 'safe-id',
        retryable: true,
      },
    })
  })
})
