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
  backendFailure: vi.fn(),
}))

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return { ...actual, config: { ...actual.config, notificationStreamHeartbeatMs: 20 } }
})
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

  it("answers dev's flat 401 when the original authority is denied", async () => {
    streamState.observer.mockResolvedValueOnce({
      status: 'denied',
      reason: 'v2_session_revoked_or_changed',
    })

    const response = await request(makeApp()).get('/external/notifications/stream')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    // Witness: authority was observed, but no listener was ever opened.
    expect(streamState.observer).toHaveBeenCalledOnce()
    expect(streamState.openListener).not.toHaveBeenCalled()
  })

  it('writes an in-flight batch and closes on the next heartbeat when original authority is revoked', async () => {
    const batch = deferred<unknown[]>()
    const heartbeatAuthority = deferred<unknown>()
    // Three startup observations are current; every heartbeat observation
    // waits until the test decides the authority.
    streamState.observer
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockImplementation(() => heartbeatAuthority.promise)
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
        id: 'batch-event-id',
        cursor: 'batch-cursor',
        approvalRequestId: 'batch-approval-id',
        status: 'approved',
      },
    ])
    await vi.waitFor(() => expect(streamState.observer.mock.calls.length).toBeGreaterThan(3))
    heartbeatAuthority.resolve({ status: 'denied', reason: 'v2_session_revoked_or_changed' })
    const response = await responsePromise

    expect(response.status).toBe(200)
    // The batch read before the revocation is written; the stream then closes
    // on the next heartbeat, which observes the revocation.
    expect(response.text).toContain('batch-event-id')
    expect(response.text).toContain('stream.closing')
    expect(response.text).toContain('session_expired')
    expect(response.text.indexOf('batch-event-id')).toBeLessThan(
      response.text.indexOf('stream.closing')
    )
    expect(response.text).not.toContain('"type":"heartbeat"')
  })

  it('writes an in-flight batch and ends on the next heartbeat when authority becomes unavailable after headers', async () => {
    const batch = deferred<unknown[]>()
    const heartbeatAuthority = deferred<unknown>()
    streamState.observer
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockImplementation(() => heartbeatAuthority.promise)
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
        id: 'batch-event-id',
        cursor: 'batch-cursor',
        approvalRequestId: 'batch-approval-id',
        status: 'approved',
      },
    ])
    await vi.waitFor(() => expect(streamState.observer.mock.calls.length).toBeGreaterThan(3))
    heartbeatAuthority.resolve({ status: 'unavailable', error: new Error('database unavailable') })
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(response.text).toContain('notification.snapshot')
    // The batch read before the outage is written; the next heartbeat ends the
    // stream without a closing frame, heartbeat or backend error body.
    expect(response.text).toContain('batch-event-id')
    const frames = response.text
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as { type: string })
    expect(frames.at(-1)?.type).toBe('approval.updated')
    expect(response.text).not.toContain('stream.closing')
    expect(response.text).not.toContain('"type":"heartbeat"')
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
