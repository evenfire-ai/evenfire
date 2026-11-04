import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import { notificationStreamEventsSentTotal } from '../src/observability/metrics.js'
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

type StreamFrame = { type: string; id?: string; reason?: string }

function parseFrames(text: string): StreamFrame[] {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as StreamFrame)
}

// Witness that a batch reached the response: the route counts every written
// approval.updated frame on the sent-events metric.
function writtenApprovalUpdates(): number {
  return vi
    .mocked(notificationStreamEventsSentTotal.inc)
    .mock.calls.filter(
      ([labels]) =>
        (labels as { event_type?: string } | undefined)?.event_type === 'approval.updated'
    ).length
}

function openStream() {
  const responsePromise = request(makeApp()).get('/external/notifications/stream')
  const result: { response?: { status: number; text: string } } = {}
  void responsePromise.then(response => {
    result.response = { status: response.status, text: response.text }
  })
  return { responsePromise, result }
}

describe('external notification stream authority checks per heartbeat and per batch', () => {
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

  it('observes authority at startup, once per heartbeat and once per non-empty batch, then closes on the next heartbeat after denial', async () => {
    const { responsePromise, result } = openStream()
    await vi.waitFor(() =>
      expect(streamState.listActive, JSON.stringify(result.response)).toHaveBeenCalledOnce()
    )

    for (const index of [1, 2, 3]) {
      streamState.pendingEvents.push(approvalUpdated(index))
      streamState.listener!.emit('notification')
      // Wait for the write, not only for the read: the batch observation runs
      // between them, and the next event must start a batch of its own.
      await vi.waitFor(() => expect(writtenApprovalUpdates()).toBe(index))
    }

    streamState.observer.mockResolvedValue({
      status: 'denied',
      reason: 'v2_session_revoked_or_changed',
    })
    const response = await responsePromise

    expect(response.status).toBe(200)
    const frames = parseFrames(response.text)
    const eventIds = frames
      .filter(frame => frame.type === 'approval.updated')
      .map(frame => frame.id)
    expect(eventIds).toEqual(['event-1', 'event-2', 'event-3'])
    // Witness: the denial is observed by the next heartbeat, which writes the
    // closing frame and ends the stream.
    expect(frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'session_expired' })
    const heartbeatFrames = frames.filter(frame => frame.type === 'heartbeat').length
    // Three startup observations (before headers, before and after the
    // snapshot read), one per heartbeat that wrote a frame, one for the
    // heartbeat that closed the stream, and one per non-empty batch (three
    // single-event batches).
    expect(streamState.observer).toHaveBeenCalledTimes(3 + heartbeatFrames + 1 + 3)
  })

  it('observes authority once for a batch of several events, not once per event', async () => {
    const { responsePromise, result } = openStream()
    await vi.waitFor(() =>
      expect(streamState.listActive, JSON.stringify(result.response)).toHaveBeenCalledOnce()
    )

    streamState.pendingEvents.push(approvalUpdated(1), approvalUpdated(2), approvalUpdated(3))
    streamState.listener!.emit('notification')
    await vi.waitFor(() => expect(writtenApprovalUpdates()).toBe(3))

    streamState.observer.mockResolvedValue({
      status: 'denied',
      reason: 'v2_session_revoked_or_changed',
    })
    const response = await responsePromise

    const frames = parseFrames(response.text)
    expect(
      frames.filter(frame => frame.type === 'approval.updated').map(frame => frame.id)
    ).toEqual(['event-1', 'event-2', 'event-3'])
    expect(frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'session_expired' })
    const heartbeatFrames = frames.filter(frame => frame.type === 'heartbeat').length
    // One observation covers the whole three-event batch.
    expect(streamState.observer).toHaveBeenCalledTimes(3 + heartbeatFrames + 1 + 1)
  })

  it('makes no authority observation for a wake-up whose read finds no events', async () => {
    const { responsePromise, result } = openStream()
    await vi.waitFor(() =>
      expect(streamState.listActive, JSON.stringify(result.response)).toHaveBeenCalledOnce()
    )

    for (let wakeUp = 0; wakeUp < 3; wakeUp += 1) {
      const readsBefore = streamState.listEvents.mock.calls.length
      streamState.listener!.emit('notification')
      await vi.waitFor(() =>
        expect(streamState.listEvents.mock.calls.length).toBeGreaterThan(readsBefore)
      )
    }

    streamState.observer.mockResolvedValue({
      status: 'denied',
      reason: 'v2_session_revoked_or_changed',
    })
    const response = await responsePromise

    const frames = parseFrames(response.text)
    expect(frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'session_expired' })
    // Witness: the empty reads did happen (the post-snapshot catch-up plus at
    // least the three wake-ups).
    expect(streamState.listEvents.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(frames.some(frame => frame.type === 'approval.updated')).toBe(false)
    const heartbeatFrames = frames.filter(frame => frame.type === 'heartbeat').length
    // Startup, heartbeats and the closing heartbeat only: empty reads add none.
    expect(streamState.observer).toHaveBeenCalledTimes(3 + heartbeatFrames + 1)
  })
})
