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

describe('external notification preference dev parity', () => {
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
      backendAvailable: true,
    })
  })

  it('preserves uncharged preference get behavior', async () => {
    await request(makeApp()).get('/external/me/notification-preferences').expect(200)
    expect(preferencesMock.getUserNotificationPreferences).toHaveBeenCalled()
    expect(rateLimitMock.checkAndIncrement).not.toHaveBeenCalled()
  })

  it('preserves uncharged preference put behavior', async () => {
    await request(makeApp())
      .put('/external/me/notification-preferences')
      .send({ preferredMedium: 'email' })
      .expect(200)
    expect(preferencesMock.upsertUserNotificationPreferences).toHaveBeenCalled()
    expect(rateLimitMock.checkAndIncrement).not.toHaveBeenCalled()
  })
})
