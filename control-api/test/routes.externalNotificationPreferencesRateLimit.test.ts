import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalNotificationsRouter } from '../src/routes/external/notifications.routes.js'

const preferencesMock = vi.hoisted(() => ({
  getUserNotificationPreferences: vi.fn(),
  upsertUserNotificationPreferences: vi.fn(),
}))
const rateLimitMock = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/services/userNotificationPreferencesService.js', () => preferencesMock)
vi.mock('../src/services/rateLimiterService.js', () => rateLimitMock)
vi.mock('../src/middleware/mcpHostHttpMetrics.js', () => ({
  mcpHostHttpMetrics:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
      userId: 'user-1',
    }
    next()
  },
}))

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalNotificationsRouter())
  return app
}

describe('external notification preference rate limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    preferencesMock.getUserNotificationPreferences.mockResolvedValue({ preferredMedium: null })
    preferencesMock.upsertUserNotificationPreferences.mockResolvedValue({ preferredMedium: null })
    rateLimitMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
  })

  it('rate limits preference reads before loading user preferences', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 31,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const response = await request(makeApp()).get('/external/me/notification-preferences')

    expect(response.status).toBe(429)
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_notification_preference_read:user:user-1',
      30
    )
    expect(preferencesMock.getUserNotificationPreferences).not.toHaveBeenCalled()
  })

  it('rate limits preference mutations before persisting user preferences', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 11,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const response = await request(makeApp())
      .put('/external/me/notification-preferences')
      .send({ preferredMedium: 'email' })

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBeDefined()
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_notification_preference_mutation:user:user-1',
      10
    )
    expect(preferencesMock.upsertUserNotificationPreferences).not.toHaveBeenCalled()
  })
})
