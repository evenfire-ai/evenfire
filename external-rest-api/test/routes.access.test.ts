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

  it('limits catalog per authenticated user while capabilities remain unrestricted', async () => {
    const server = app()
    mocks.controlApiRequest.mockResolvedValue({ items: [] })
    for (let index = 0; index < 10; index += 1) {
      await request(server)
        .get('/me/access/catalog')
        .set('authorization', 'Bearer session-token')
        .expect(200)
    }
    const rejected = await request(server)
      .get('/me/access/catalog')
      .set('authorization', 'Bearer session-token')
      .expect(429)
    expect(rejected.headers['x-ratelimit-limit']).toBe('10')
    expect(mocks.controlApiRequest).toHaveBeenCalledTimes(10)

    for (let index = 0; index < 11; index += 1) {
      await request(server)
        .get('/me/access/capabilities')
        .set('authorization', 'Bearer session-token')
        .expect(200)
    }
    mocks.verifyToken.mockReturnValue({
      userId: 'user-2',
      email: 'other@example.test',
      role: 'member',
    })
    await request(server)
      .get('/me/access/catalog')
      .set('authorization', 'Bearer other-session')
      .expect(200)
    expect(mocks.controlApiRequest).toHaveBeenCalledTimes(22)
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
      .set('x-correlation-id', 'request-fallback')
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

  it('uses the request correlation when a sanitized upstream error has none', async () => {
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError('upstream', 503, {
        error: {
          code: 'authority_unavailable',
          message: 'SQL /secret/path',
          retryable: true,
        },
      })
    )

    const response = await request(app())
      .get('/me/access/capabilities')
      .set('authorization', 'Bearer session-token')
      .set('x-correlation-id', 'access_ID-42')
      .expect(503)

    expect(response.body.error.correlationId).toBe('access_ID-42')
  })

  it('preserves safe retry guidance for a locally sanitized access limit', async () => {
    mocks.controlApiRequest.mockRejectedValue(
      new ControlApiError(
        'rate limited',
        429,
        {
          error: {
            code: 'rate_limited',
            details: { retryAfterSeconds: 17, bucket: 'secret-bucket' },
          },
        },
        {
          'retry-after': '17',
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1900000000',
          'x-internal-bucket': 'secret-bucket',
        }
      )
    )

    const response = await request(app())
      .get('/me/access/catalog')
      .set('authorization', 'Bearer session-token')

    expect(response.status).toBe(429)
    expect(response.body.error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      details: { retryAfterSeconds: 17 },
    })
    expect(response.headers['retry-after']).toBe('17')
    expect(response.headers['x-ratelimit-limit']).toBe('10')
    expect(response.headers['x-ratelimit-remaining']).toBe('0')
    expect(response.headers['x-ratelimit-reset']).toBe('1900000000')
    expect(response.headers['x-internal-bucket']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('secret-bucket')
  })
})
