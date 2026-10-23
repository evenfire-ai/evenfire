import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import { createExternalNotificationsRouter } from '../src/routes/external/notifications.routes.js'

const streamState = vi.hoisted(() => ({
  observer: vi.fn(),
  listActive: vi.fn(),
  listEvents: vi.fn(),
  newestCursor: vi.fn(),
  openListener: vi.fn(),
  scheduleShadow: vi.fn(),
  backendFailure: vi.fn(),
}))

vi.mock('../src/middleware/externalClientIdentity.js', () => ({
  createExternalClientRateLimiters: () => [
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  ],
}))
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    const externalReq = req as express.Request & Record<string, unknown>
    externalReq.externalAuth = { userId: 'user-1' }
    externalReq.externalSessionAuthority = { contract: 'v2', userId: 'user-1' }
    externalReq.externalSessionAuthentication = {
      status: 'authenticated',
      contract: 'v2',
      claims: { userId: 'user-1' },
      tokenClaims: { sub: 'user-1', sid: 'sid-1', jti: 'jti-1', sv: 1, exp: 4_000_000_000 },
      authorityContext: {
        contract: 'v2',
        userId: 'user-1',
        sid: 'sid-1',
        jti: 'jti-1',
        sessionVersion: 1,
      },
      policy: {},
    }
    next()
  },
  handleExternalSessionBackendFailure: (
    _error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    streamState.backendFailure()
    res.setHeader('Retry-After', '2')
    res.setHeader('Cache-Control', 'no-store')
    res.status(503).json({ error: 'session_backend_unavailable', retryAfterSeconds: 2 })
  },
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/middleware/mcpHostHttpMetrics.js', () => ({
  mcpHostHttpMetrics:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}))
vi.mock('../src/observability/metrics.js', () => {
  const metric = { inc: vi.fn(), dec: vi.fn(), observe: vi.fn() }
  return {
    notificationStreamConnectionsActive: metric,
    notificationStreamDisconnectsTotal: metric,
    notificationStreamEventsFilteredTotal: metric,
    notificationStreamEventsSentTotal: metric,
    notificationStreamSnapshotSize: metric,
  }
})
vi.mock('../src/services/access/accessCatalogShadow.js', () => ({
  scheduleAccessCatalogShadow: streamState.scheduleShadow,
}))
vi.mock('../src/services/auth/externalSessionCurrentnessObserver.js', () => ({
  observeExternalSessionCurrentness: streamState.observer,
}))
vi.mock('../src/services/notificationAckService.js', () => ({
  acknowledgeDesktopNotificationDelivery: vi.fn(),
}))
vi.mock('../src/services/notificationStreamService.js', () => ({
  listActiveApprovalNotificationsForUser: streamState.listActive,
  listNotificationStreamEventsForUser: streamState.listEvents,
  newestNotificationCursor: streamState.newestCursor,
  openNotificationQueueListener: streamState.openListener,
  parseNotificationCursor: (value: string) => ({ createdAt: value, id: 'event-1' }),
}))
vi.mock('../src/services/userNotificationPreferencesService.js', () => ({
  getUserNotificationPreferences: vi.fn(),
  upsertUserNotificationPreferences: vi.fn(),
}))

function makeApp() {
  const app = express()
  app.use(createExternalNotificationsRouter())
  return app
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('external notification stream currentness', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    streamState.observer.mockResolvedValue({ status: 'current' })
    streamState.listActive.mockResolvedValue([])
    streamState.listEvents.mockResolvedValue([])
    streamState.newestCursor.mockReturnValue(null)
    streamState.openListener.mockImplementation(async () => {
      const listener = new EventEmitter() as EventEmitter & { release: () => void }
      listener.release = vi.fn()
      return listener
    })
    streamState.backendFailure.mockReset()
  })

  it('returns the established bounded backend-unavailable response before headers', async () => {
    streamState.observer.mockResolvedValueOnce({
      status: 'unavailable',
      error: new Error('database unavailable'),
    })

    const response = await request(makeApp()).get('/external/notifications/stream')

    expect(response.status, response.text).toBe(503)
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ error: 'session_backend_unavailable', retryAfterSeconds: 2 })
    expect(streamState.listActive).not.toHaveBeenCalled()
    expect(streamState.backendFailure).toHaveBeenCalledOnce()
  })

  it('drops an awaited notification batch when original authority is revoked', async () => {
    const batch = deferred<unknown[]>()
    streamState.observer
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'denied', reason: 'v2_session_revoked_or_changed' })
    streamState.listEvents.mockReturnValueOnce(batch.promise)

    const responsePromise = request(makeApp()).get('/external/notifications/stream')
    let responseResult: { status: number; text: string } | undefined
    void responsePromise.then(response => {
      responseResult = { status: response.status, text: response.text }
    })
    await vi.waitFor(() =>
      expect(streamState.listActive, JSON.stringify(responseResult)).toHaveBeenCalledOnce()
    )
    await vi.waitFor(() => expect(streamState.listEvents).toHaveBeenCalledOnce())
    batch.resolve([
      {
        eventType: 'approval.updated',
        id: 'private-event-id',
        cursor: 'private-cursor',
        approvalRequestId: 'private-approval-id',
        status: 'approved',
      },
    ])
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(response.text).toContain('stream.closing')
    expect(response.text).toContain('session_expired')
    expect(response.text).not.toContain('private-event-id')
    expect(response.text).not.toContain('private-cursor')
    expect(response.text).not.toContain('private-approval-id')
  })

  it('ends without protected data or cursor when authority becomes unavailable after headers', async () => {
    const batch = deferred<unknown[]>()
    streamState.observer
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'unavailable', error: new Error('database unavailable') })
    streamState.listEvents.mockReturnValueOnce(batch.promise)

    const responsePromise = request(makeApp()).get('/external/notifications/stream')
    let responseResult: { status: number; text: string } | undefined
    void responsePromise.then(response => {
      responseResult = { status: response.status, text: response.text }
    })
    await vi.waitFor(() =>
      expect(streamState.listActive, JSON.stringify(responseResult)).toHaveBeenCalledOnce()
    )
    await vi.waitFor(() => expect(streamState.listEvents).toHaveBeenCalledOnce())
    batch.resolve([
      {
        eventType: 'approval.updated',
        id: 'private-event-id',
        cursor: 'private-cursor',
        approvalRequestId: 'private-approval-id',
        status: 'approved',
      },
    ])
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(response.text).toContain('notification.snapshot')
    expect(response.text).not.toContain('private-event-id')
    expect(response.text).not.toContain('private-cursor')
    expect(response.text).not.toContain('session_backend_unavailable')
  })

  it('closes and cleans up when a post-header currentness read fails unexpectedly', async () => {
    streamState.observer
      .mockResolvedValueOnce({ status: 'current' })
      .mockRejectedValueOnce(new Error('unexpected observer failure'))

    const response = await request(makeApp()).get('/external/notifications/stream')

    expect(response.status).toBe(200)
    expect(response.text).toBe('')
    expect(streamState.listActive).not.toHaveBeenCalled()
  })
})
