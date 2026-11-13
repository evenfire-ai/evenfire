import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalRestPublicErrorHandler } from '../src/app.js'
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
  value.use(externalRestPublicErrorHandler)
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

  it('forwards capabilities with the same user session', async () => {
    mocks.controlApiRequest.mockResolvedValueOnce({ actionContextV2: false })
    await request(app())
      .get('/me/access/capabilities')
      .set('authorization', 'Bearer session-token')
      .expect(200, { actionContextV2: false })
    expect(mocks.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(mocks.controlApiRequest).toHaveBeenLastCalledWith(
      'GET',
      '/external/access/capabilities',
      { userSessionToken: 'session-token' }
    )
  })

  it('serves capabilities without an edge rate limit', async () => {
    const server = app()
    mocks.controlApiRequest.mockResolvedValue({ actionContextV2: false })
    for (let index = 0; index < 11; index += 1) {
      await request(server)
        .get('/me/access/capabilities')
        .set('authorization', 'Bearer session-token')
        .expect(200)
    }
    expect(mocks.controlApiRequest).toHaveBeenCalledTimes(11)
  })

  it('rejects a request without a valid session before forwarding', async () => {
    mocks.verifyToken.mockReturnValue(null)
    const response = await request(app())
      .get('/me/access/capabilities')
      .set('authorization', 'Bearer invalid-session')
    expect(mocks.verifyToken).toHaveBeenCalled()
    expect(response.status).toBe(401)
    expect(mocks.controlApiRequest).not.toHaveBeenCalled()
  })

  // M-10: Control API errors reach the edge's public error handler through
  // next(error), which relays Control API's own status and body.
  it('forwards a Control API error status and body unchanged', async () => {
    const body = {
      error: {
        code: 'authority_unavailable',
        message: 'Access capability state is temporarily unavailable.',
        correlationId: 'safe-id',
        retryable: true,
      },
    }
    mocks.controlApiRequest.mockRejectedValue(new ControlApiError('upstream', 503, body))

    const response = await request(app())
      .get('/me/access/capabilities')
      .set('authorization', 'Bearer session-token')

    expect(mocks.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(503)
    expect(response.body).toEqual(body)
  })
})
