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
  listener: null as (EventEmitter & { release: () => void }) | null,
  pendingEvents: [] as unknown[],
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
  handleExternalSessionBackendFailure: vi.fn(),
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

function approvalUpdated(index: number) {
  return {
    eventType: 'approval.updated',
    id: `event-${index}`,
    cursor: `cursor-${index}`,
    approvalRequestId: `approval-${index}`,
    status: 'approved',
  }
}

describe('external notification stream authority checks per heartbeat', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    streamState.listener = null
    streamState.pendingEvents = []
    streamState.observer.mockResolvedValue({ status: 'current' })
    streamState.listActive.mockResolvedValue([])
    streamState.newestCursor.mockReturnValue(null)
    // Every flush, whether triggered by a notification or by a heartbeat,
    // drains the events queued so far.
    streamState.listEvents.mockImplementation(async () => streamState.pendingEvents.splice(0))
    streamState.openListener.mockImplementation(async () => {
      const listener = new EventEmitter() as EventEmitter & { release: () => void }
      listener.release = vi.fn()
      streamState.listener = listener
      return listener
    })
  })

  it('observes authority only at startup and once per heartbeat, then closes on the next heartbeat after denial', async () => {
    const responsePromise = request(makeApp()).get('/external/notifications/stream')
    let responseResult: { status: number; text: string } | undefined
    void responsePromise.then(response => {
      responseResult = { status: response.status, text: response.text }
    })
    await vi.waitFor(() =>
      expect(streamState.listActive, JSON.stringify(responseResult)).toHaveBeenCalledOnce()
    )

    for (const index of [1, 2, 3]) {
      streamState.pendingEvents.push(approvalUpdated(index))
      streamState.listener!.emit('notification')
      await vi.waitFor(() => expect(streamState.pendingEvents).toHaveLength(0))
    }

    streamState.observer.mockResolvedValue({
      status: 'denied',
      reason: 'v2_session_revoked_or_changed',
    })
    const response = await responsePromise

    expect(response.status).toBe(200)
    const frames = response.text
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as { type: string; id?: string; reason?: string })
    const eventIds = frames
      .filter(frame => frame.type === 'approval.updated')
      .map(frame => frame.id)
    expect(eventIds).toEqual(['event-1', 'event-2', 'event-3'])
    // Witness: the denial is observed by the next heartbeat, which writes the
    // closing frame and ends the stream.
    expect(frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'session_expired' })
    const heartbeatFrames = frames.filter(frame => frame.type === 'heartbeat').length
    // Three startup observations (before headers, before and after the
    // snapshot read), one per heartbeat that wrote a frame, and one for the
    // heartbeat that closed the stream. Delivering the three events adds none.
    expect(streamState.observer).toHaveBeenCalledTimes(3 + heartbeatFrames + 1)
  })
})
