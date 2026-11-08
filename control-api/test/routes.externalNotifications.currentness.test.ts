import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import { config } from '../src/config.js'
import { createExternalNotificationsRouter } from '../src/routes/external/notifications.routes.js'

const streamState = vi.hoisted(() => ({
  observer: vi.fn(),
  listActive: vi.fn(),
  listEvents: vi.fn(),
  newestCursor: vi.fn(),
  openListener: vi.fn(),
  backendFailure: vi.fn(),
  listener: null as (EventEmitter & { release: () => void }) | null,
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

type StreamFrame = { type: string; id?: string; reason?: string }

function parseFrames(text: string): StreamFrame[] {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as StreamFrame)
}

function batchEvent() {
  return {
    eventType: 'approval.updated',
    id: 'batch-event-id',
    cursor: 'batch-cursor',
    approvalRequestId: 'batch-approval-id',
    status: 'approved',
  }
}

function openStream() {
  const responsePromise = request(makeApp()).get('/external/notifications/stream')
  const result: { response?: { status: number; text: string } } = {}
  void responsePromise.then(response => {
    result.response = { status: response.status, text: response.text }
  })
  return { responsePromise, result }
}

// Lets every pending microtask run: a resolved batch is observed and written
// (or withheld) entirely in microtasks.
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

// Heartbeats are driven by hand so that the observation order is exact: the
// first observation after the three startup ones is the batch observation.
// vi.waitFor advances fake timers on every poll, so these tests wait with
// waitUntil instead.
function useManualHeartbeats() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
}

async function waitUntil(condition: () => boolean, describeState: () => string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${describeState()}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const current = { status: 'current' } as const
const denied = { status: 'denied', reason: 'v2_session_revoked_or_changed' } as const

describe('external notification stream currentness', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    streamState.observer.mockResolvedValue({ status: 'current' })
    streamState.listActive.mockResolvedValue([])
    streamState.listEvents.mockResolvedValue([])
    streamState.newestCursor.mockReturnValue(null)
    streamState.listener = null
    streamState.openListener.mockImplementation(async () => {
      const listener = new EventEmitter() as EventEmitter & { release: () => void }
      listener.release = vi.fn()
      streamState.listener = listener
      return listener
    })
    streamState.backendFailure.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('withholds a batch whose post-read observation is denied and closes with session_expired', async () => {
    useManualHeartbeats()
    const batch = deferred<unknown[]>()
    streamState.observer
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(denied)
    streamState.listEvents.mockReturnValueOnce(batch.promise)

    const { responsePromise, result } = openStream()
    await waitUntil(
      () => streamState.listEvents.mock.calls.length > 0,
      () => JSON.stringify(result.response)
    )
    // The read itself is not preceded by an observation of its own.
    expect(streamState.observer).toHaveBeenCalledTimes(3)
    batch.resolve([batchEvent()])
    await settle()
    // A later heartbeat would close the stream too; it must find nothing left
    // to do, because the batch observation already closed it.
    vi.advanceTimersByTime(config.notificationStreamHeartbeatMs)
    const response = await responsePromise

    expect(response.status).toBe(200)
    const frames = parseFrames(response.text)
    expect(frames.map(frame => frame.type)).toEqual(['notification.snapshot', 'stream.closing'])
    expect(frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'session_expired' })
    expect(response.text).not.toContain('batch-event-id')
    // Witnesses: the batch was read once and observed once, after the read.
    expect(streamState.listEvents).toHaveBeenCalledOnce()
    expect(streamState.observer).toHaveBeenCalledTimes(4)
  })

  it('withholds a batch and ends without a frame when its post-read observation is unavailable', async () => {
    useManualHeartbeats()
    const batch = deferred<unknown[]>()
    streamState.observer
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValue({ status: 'unavailable', error: new Error('database unavailable') })
    streamState.listEvents.mockReturnValueOnce(batch.promise)

    const { responsePromise, result } = openStream()
    await waitUntil(
      () => streamState.listEvents.mock.calls.length > 0,
      () => JSON.stringify(result.response)
    )
    batch.resolve([batchEvent()])
    await settle()
    vi.advanceTimersByTime(config.notificationStreamHeartbeatMs)
    const response = await responsePromise

    expect(response.status).toBe(200)
    // The stream ends after the snapshot: no batch, closing frame, heartbeat or
    // backend error body.
    const frames = parseFrames(response.text)
    expect(frames.map(frame => frame.type)).toEqual(['notification.snapshot'])
    expect(response.text).not.toContain('batch-event-id')
    expect(response.text).not.toContain('session_backend_unavailable')
    // Witnesses: the batch was read once and observed once, after the read.
    expect(streamState.listEvents).toHaveBeenCalledOnce()
    expect(streamState.observer).toHaveBeenCalledTimes(4)
  })

  it('writes an in-flight batch whose observation is current and closes on the next heartbeat after a revocation', async () => {
    useManualHeartbeats()
    const batch = deferred<unknown[]>()
    // Three startup observations and the batch observation are current; the
    // next heartbeat observes the revocation. This is the accepted window: a
    // revocation that commits after the batch observation.
    streamState.observer
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(denied)
    streamState.listEvents.mockReturnValueOnce(batch.promise)

    const { responsePromise, result } = openStream()
    await waitUntil(
      () => streamState.listEvents.mock.calls.length > 0,
      () => JSON.stringify(result.response)
    )
    batch.resolve([batchEvent()])
    await settle()
    // The batch was observed (current) before any heartbeat ran.
    expect(streamState.observer).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(config.notificationStreamHeartbeatMs)
    const response = await responsePromise

    expect(response.status).toBe(200)
    const frames = parseFrames(response.text)
    expect(frames.map(frame => frame.type)).toEqual([
      'notification.snapshot',
      'approval.updated',
      'stream.closing',
    ])
    expect(frames[1]).toMatchObject({ id: 'batch-event-id' })
    expect(frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'session_expired' })
    // Three startup observations, the batch observation and the heartbeat.
    expect(streamState.observer).toHaveBeenCalledTimes(5)
  })

  it('reads and writes nothing for a notification that arrives before the snapshot frame', async () => {
    useManualHeartbeats()
    const snapshot = deferred<unknown[]>()
    streamState.listActive.mockReturnValueOnce(snapshot.promise)
    streamState.listEvents.mockResolvedValueOnce([batchEvent()]).mockResolvedValue([])
    streamState.observer
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(denied)

    const { responsePromise, result } = openStream()
    await waitUntil(
      () => streamState.listActive.mock.calls.length > 0,
      () => JSON.stringify(result.response)
    )
    streamState.listener!.emit('notification')
    await settle()
    // Witness: startup is parked at the snapshot read, with the listener live.
    expect(streamState.listActive).toHaveBeenCalledOnce()
    expect(streamState.listener!.listenerCount('notification')).toBe(1)
    expect(streamState.listEvents).not.toHaveBeenCalled()

    snapshot.resolve([])
    await waitUntil(
      () => streamState.listEvents.mock.calls.length > 0,
      () => JSON.stringify(result.response)
    )
    await settle()
    // Three startup observations and the catch-up batch's observation.
    expect(streamState.observer).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(config.notificationStreamHeartbeatMs)
    const response = await responsePromise

    expect(response.status).toBe(200)
    // The event queued during startup is delivered by the catch-up after the
    // snapshot frame, never before it.
    const frames = parseFrames(response.text)
    expect(frames.map(frame => frame.type)).toEqual([
      'notification.snapshot',
      'approval.updated',
      'stream.closing',
    ])
    expect(frames[1]).toMatchObject({ id: 'batch-event-id' })
    expect(streamState.observer).toHaveBeenCalledTimes(5)
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
