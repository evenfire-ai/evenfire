import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import {
  notificationStreamEventsFilteredTotal,
  notificationStreamEventsSentTotal,
} from '../src/observability/metrics.js'
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
  return {
    ...actual,
    config: {
      ...actual.config,
      // No heartbeat can fire during the test, so only a wake-up can deliver.
      notificationStreamHeartbeatMs: 600_000,
      notificationStreamMaxLifetimeMs: 1_500,
    },
  }
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

// Witness that the post-snapshot catch-up flush finished: its empty read
// counts one filtered event before the flush returns.
function emptyReads(): number {
  return vi
    .mocked(notificationStreamEventsFilteredTotal.inc)
    .mock.calls.filter(
      ([labels]) => (labels as { reason?: string } | undefined)?.reason === 'no_new_active_events'
    ).length
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('external notification stream wake-ups during an in-flight flush', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    streamState.listener = null
    streamState.pendingEvents = []
    streamState.observer.mockResolvedValue({ status: 'current' })
    streamState.listActive.mockResolvedValue([])
    streamState.newestCursor.mockReturnValue(null)
    streamState.listEvents.mockImplementation(async () => streamState.pendingEvents.splice(0))
    streamState.openListener.mockImplementation(async () => {
      const listener = new EventEmitter() as EventEmitter & { release: () => void }
      listener.release = vi.fn()
      streamState.listener = listener
      return listener
    })
  })

  it('delivers an event whose wake-up arrives while the previous batch waits for authority', async () => {
    const { responsePromise, result } = openStream()
    await vi.waitFor(() =>
      expect(streamState.listActive, JSON.stringify(result.response)).toHaveBeenCalledOnce()
    )
    // The post-snapshot catch-up flush has read nothing and returned, so the
    // next wake-up starts a flush of its own.
    await vi.waitFor(() => expect(emptyReads()).toBe(1))
    const readsBeforeFirstWakeUp = streamState.listEvents.mock.calls.length
    expect(readsBeforeFirstWakeUp).toBe(1)
    // Three startup observations: before headers, before and after the
    // snapshot read.
    expect(streamState.observer).toHaveBeenCalledTimes(3)

    const batchObservation = deferred<{ status: 'current' }>()
    streamState.observer.mockImplementationOnce(() => batchObservation.promise)
    streamState.pendingEvents.push(approvalUpdated(1))
    streamState.listener!.emit('notification')
    // Witness that flush 1 has read event-1 and is parked in the per-batch
    // authority observation.
    await vi.waitFor(() => expect(streamState.observer).toHaveBeenCalledTimes(4))
    expect(streamState.listEvents.mock.calls.length).toBe(readsBeforeFirstWakeUp + 1)

    // event-2 is committed after flush 1 read, and its wake-up arrives while
    // flush 1 is still in flight.
    streamState.pendingEvents.push(approvalUpdated(2))
    streamState.listener!.emit('notification')
    batchObservation.resolve({ status: 'current' })

    // Both events are written long before the 1.5 s lifetime ends the stream.
    await vi.waitFor(() => expect(writtenApprovalUpdates()).toBe(2), { timeout: 1_000 })

    const response = await responsePromise
    expect(response.status).toBe(200)
    const frames = parseFrames(response.text)
    expect(
      frames.filter(frame => frame.type === 'approval.updated').map(frame => frame.id)
    ).toEqual(['event-1', 'event-2'])
    expect(frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'max_lifetime' })
    expect(frames.filter(frame => frame.type === 'heartbeat')).toHaveLength(0)
    // Counted from the first wake-up: the parked flush plus exactly one re-run
    // for the wake-up recorded while it was in flight (3 reads in total with
    // the post-snapshot catch-up).
    expect(streamState.listEvents.mock.calls.length - readsBeforeFirstWakeUp).toBe(2)
    expect(streamState.listEvents).toHaveBeenCalledTimes(3)
  })
})
