import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createNotificationsRouter } from '../src/routes/notifications.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const controlApiClientMock = vi.hoisted(() => ({
  controlApiStreamRequest: vi.fn(),
  controlApiRequest: vi.fn(),
  ControlApiError: class ControlApiError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/controlApiClient.js', () => controlApiClientMock)

function ndjsonStream(line: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

describe('routes/notifications', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: 9999999999,
  }

  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    controlApiClientMock.controlApiStreamRequest.mockReset()
    controlApiClientMock.controlApiRequest.mockReset()
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createNotificationsRouter())
    return app
  }

  it('requires authentication for the Desktop notification stream', async () => {
    await request(makeApp()).get('/notifications/stream').expect(401)
    expect(controlApiClientMock.controlApiStreamRequest).not.toHaveBeenCalled()
  })

  it('forwards the session-bound notification stream through control-api', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiStreamRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: ndjsonStream(
        JSON.stringify({
          type: 'notification.snapshot',
          items: [],
          cursor: null,
          observedAt: '2026-05-20T10:00:00.000Z',
        })
      ),
    })

    const response = await request(makeApp())
      .get('/notifications/stream')
      .set('authorization', 'Bearer user-session-token')
      .expect(200)

    expect(response.text.trim()).toContain('"notification.snapshot"')
    expect(response.headers['x-accel-buffering']).toBe('no')
    expect(controlApiClientMock.controlApiStreamRequest).toHaveBeenCalledWith(
      'GET',
      '/external/notifications/stream',
      expect.objectContaining({
        userSessionToken: 'user-session-token',
      })
    )
  })

  it('requires authentication for notification ack', async () => {
    await request(makeApp()).post('/notifications/notif-1/ack').expect(401)
    expect(controlApiClientMock.controlApiRequest).not.toHaveBeenCalled()
  })

  it('forwards desktop notification ack through control-api', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiRequest.mockResolvedValueOnce({
      ok: true,
      status: 'acked',
    })

    const response = await request(makeApp())
      .post('/notifications/notif-1/ack')
      .set('authorization', 'Bearer user-session-token')
      .expect(200)

    expect(response.body).toEqual({ ok: true, status: 'acked' })
    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/notifications/notif-1/ack',
      expect.objectContaining({
        userSessionToken: 'user-session-token',
      })
    )
  })

  it('forwards notification preference reads through control-api', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiRequest.mockResolvedValueOnce({
      preferredMedium: 'telegram',
      channelFallbackEnabled: true,
      verifiedMedia: ['telegram'],
    })

    const response = await request(makeApp())
      .get('/me/notification-preferences')
      .set('authorization', 'Bearer user-session-token')
      .expect(200)

    expect(response.body).toEqual({
      preferredMedium: 'telegram',
      channelFallbackEnabled: true,
      verifiedMedia: ['telegram'],
    })
    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/me/notification-preferences',
      expect.objectContaining({
        userSessionToken: 'user-session-token',
      })
    )
  })

  it('sanitizes partial preference PUT validation errors from control-api', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiRequest.mockRejectedValueOnce(
      new controlApiClientMock.ControlApiError('invalid_channel_fallback_enabled', 400, {
        error: 'invalid_channel_fallback_enabled',
      })
    )

    const response = await request(makeApp())
      .put('/me/notification-preferences')
      .set('authorization', 'Bearer user-session-token')
      .send({ preferredMedium: 'telegram' })
      .expect(400)

    expect(response.body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request is not valid.',
        correlationId: expect.any(String),
        retryable: false,
      },
    })
    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'PUT',
      '/external/me/notification-preferences',
      expect.objectContaining({
        userSessionToken: 'user-session-token',
        body: { preferredMedium: 'telegram' },
      })
    )
  })

  it('forwards notification preference updates through control-api', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiRequest.mockResolvedValueOnce({
      preferredMedium: 'slack',
      channelFallbackEnabled: false,
      verifiedMedia: ['slack'],
    })

    const response = await request(makeApp())
      .put('/me/notification-preferences')
      .set('authorization', 'Bearer user-session-token')
      .send({ preferredMedium: 'slack', channelFallbackEnabled: false })
      .expect(200)

    expect(response.body).toEqual({
      preferredMedium: 'slack',
      channelFallbackEnabled: false,
      verifiedMedia: ['slack'],
    })
    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'PUT',
      '/external/me/notification-preferences',
      expect.objectContaining({
        userSessionToken: 'user-session-token',
        body: { preferredMedium: 'slack', channelFallbackEnabled: false },
      })
    )
  })
})
