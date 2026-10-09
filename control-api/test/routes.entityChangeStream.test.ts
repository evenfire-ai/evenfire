import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Request, Response } from 'express'
import { EventEmitter } from 'node:events'
import { get } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  closeActiveEntityChangeStreams,
  parseRequestedEntityChangeCursor,
  streamEntityChanges,
} from '../src/routes/entityChangeStream.js'

const serviceMock = vi.hoisted(() => ({
  isEntityChangeCursor: vi.fn(),
  readEntityChangeCheckpoint: vi.fn(),
  subscribeEntityChangeFeedWake: vi.fn(),
}))
const configMock = vi.hoisted(() => ({
  entityChangeStreamHeartbeatMs: 20_000,
  entityChangeStreamMaxLifetimeMs: 600_000,
  entityChangeStreamPollMs: 250,
  entityChangeUserVisibilityRefreshMs: 4_000,
  entityChangeStreamMaxConnections: 100,
  entityChangeStreamMaxConnectionsPerPrincipal: 8,
}))

vi.mock('../src/config.js', () => ({ config: configMock }))
vi.mock('../src/services/entityChangeService.js', () => serviceMock)
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

class FakeRequest extends EventEmitter {
  query: Record<string, unknown> = {}
  setTimeout = vi.fn()
}

class FakeResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  destroyed = false
  writableEnded = false
  writableLength = 0
  writeReturns = true
  frames: string[] = []
  status(code: number): this {
    this.statusCode = code
    return this
  }
  setHeader(): this {
    return this
  }
  flushHeaders(): void {
    this.headersSent = true
  }
  write(frame: string): boolean {
    this.frames.push(frame)
    return this.writeReturns
  }
  end(): void {
    this.writableEnded = true
    this.emit('close')
  }
  json(): this {
    return this
  }
}

const CURSOR = 'd119f895-1ef8-4e73-8f08-f9754919682a'

describe('routes/entityChangeStream', () => {
  beforeEach(() => {
    configMock.entityChangeStreamMaxConnections = 100
    configMock.entityChangeStreamMaxConnectionsPerPrincipal = 8
    serviceMock.isEntityChangeCursor.mockImplementation((value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
    serviceMock.readEntityChangeCheckpoint.mockReset()
    serviceMock.subscribeEntityChangeFeedWake.mockReset()
    serviceMock.subscribeEntityChangeFeedWake.mockReturnValue(vi.fn())
  })

  it('validates requested UUID cursors and represents an absent cursor as a full resync', () => {
    expect(parseRequestedEntityChangeCursor({ query: {} } as Request)).toBeNull()
    expect(parseRequestedEntityChangeCursor({ query: { cursor: CURSOR } } as Request)).toBe(CURSOR)
    expect(parseRequestedEntityChangeCursor({ query: { cursor: 'bad' } } as Request)).toBe(false)
  })

  it('authorizes before sending streaming headers', async () => {
    const req = new FakeRequest()
    const res = new FakeResponse()
    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      null,
      async () => false,
      'user'
    )
    await vi.waitFor(() => expect(res.statusCode).toBe(401))
    expect(res.headersSent).toBe(false)
    expect(res.frames).toEqual([])
  })

  it('does not acquire a feed connection when the client disconnects during authorization', async () => {
    let finishAuthorization: (authorized: boolean) => void = () => undefined
    const authorization = new Promise<boolean>(resolve => {
      finishAuthorization = resolve
    })
    const req = new FakeRequest()
    const res = new FakeResponse()
    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      null,
      () => authorization,
      'user'
    )
    req.emit('aborted')
    finishAuthorization(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(serviceMock.subscribeEntityChangeFeedWake).not.toHaveBeenCalled()
    expect(res.headersSent).toBe(false)
  })

  it('bounds admitted streams per authenticated principal and per process', async () => {
    configMock.entityChangeStreamMaxConnections = 2
    configMock.entityChangeStreamMaxConnectionsPerPrincipal = 1
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: [],
    })
    const start = (principalId: string) => {
      const req = new FakeRequest()
      const res = new FakeResponse()
      streamEntityChanges(
        req as unknown as Request,
        res as unknown as Response,
        null,
        async () => true,
        'user',
        principalId
      )
      return { req, res }
    }

    const first = start('user-1')
    await vi.waitFor(() => expect(first.res.headersSent).toBe(true))
    const samePrincipal = start('user-1')
    await vi.waitFor(() => expect(samePrincipal.res.statusCode).toBe(429))
    expect(samePrincipal.res.headersSent).toBe(false)

    const secondPrincipal = start('user-2')
    await vi.waitFor(() => expect(secondPrincipal.res.headersSent).toBe(true))
    const overProcessLimit = start('user-3')
    await vi.waitFor(() => expect(overProcessLimit.res.statusCode).toBe(429))
    expect(overProcessLimit.res.headersSent).toBe(false)
    closeActiveEntityChangeStreams()
    await vi.waitFor(() =>
      expect(first.res.writableEnded && secondPrincipal.res.writableEnded).toBe(true)
    )
  })

  it('sends only coarse invalidations and closes cleanly on server shutdown', async () => {
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: true,
      cursor: CURSOR,
      scopes: ['gfs', 'authorization'],
    })
    const req = new FakeRequest()
    const res = new FakeResponse()
    let authorizationChecks = 0
    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      null,
      async () => {
        authorizationChecks += 1
        return true
      },
      'operator'
    )
    await vi.waitFor(() => expect(res.frames.length).toBeGreaterThan(0))
    closeActiveEntityChangeStreams()
    await vi.waitFor(() => expect(res.writableEnded).toBe(true))
    expect(res.frames.join('')).toContain('"type":"resync_required"')
    expect(res.frames.join('')).toContain('"type":"stream.closing"')
    expect(res.frames.join('')).not.toContain('resource-id')
    expect(authorizationChecks).toBeGreaterThanOrEqual(2)
    expect(serviceMock.subscribeEntityChangeFeedWake).toHaveBeenCalledOnce()
  })

  it('keeps user checkpoints independent of hidden mutations and refreshes on a fixed cadence', async () => {
    vi.useFakeTimers()
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs', 'authorization'],
    })
    const req = new FakeRequest()
    const res = new FakeResponse()
    const start = Date.now()
    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      async () => true,
      'user',
      'user-1'
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(res.frames.map(frame => JSON.parse(frame))).toEqual([
      {
        schemaVersion: 1,
        type: 'resync_required',
        cursor: '00000000-0000-0000-0000-000000000000',
        scopes: ['gfs', 'authorization'],
      },
    ])
    expect(serviceMock.readEntityChangeCheckpoint).not.toHaveBeenCalled()
    expect(serviceMock.subscribeEntityChangeFeedWake).not.toHaveBeenCalled()

    const expectedPeriodicFrame = {
      schemaVersion: 1,
      type: 'scope.invalidated',
      cursor: '00000000-0000-0000-0000-000000000000',
      scopes: ['gfs', 'authorization'],
    }
    const checkpointScenarios = [
      { resyncRequired: false, cursor: CURSOR, scopes: ['gfs'] },
      {
        resyncRequired: false,
        cursor: '0f961d2e-4c95-4ea7-a47d-79f8d4b0da07',
        scopes: ['authorization'],
      },
      { resyncRequired: true, cursor: CURSOR, scopes: ['gfs', 'authorization'] },
    ]
    for (const checkpoint of checkpointScenarios) {
      serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
        ...checkpoint,
      })
      await vi.advanceTimersByTimeAsync(configMock.entityChangeUserVisibilityRefreshMs)
      expect(JSON.parse(res.frames.at(-1)!)).toEqual(expectedPeriodicFrame)
    }
    expect(Date.now() - start).toBe(configMock.entityChangeUserVisibilityRefreshMs * 3)
    expect(serviceMock.readEntityChangeCheckpoint).not.toHaveBeenCalled()
    closeActiveEntityChangeStreams()
    await vi.advanceTimersByTimeAsync(0)

    const reconnectReq = new FakeRequest()
    const reconnectRes = new FakeResponse()
    streamEntityChanges(
      reconnectReq as unknown as Request,
      reconnectRes as unknown as Response,
      CURSOR,
      async () => true,
      'user',
      'user-1'
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(reconnectRes.frames[0]!)).toEqual({
      schemaVersion: 1,
      type: 'resync_required',
      cursor: '00000000-0000-0000-0000-000000000000',
      scopes: ['gfs', 'authorization'],
    })
    expect(serviceMock.readEntityChangeCheckpoint).not.toHaveBeenCalled()
    closeActiveEntityChangeStreams()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })

  it('closes an established user stream when post-frame currentness is revoked', async () => {
    vi.useFakeTimers()
    const req = new FakeRequest()
    const res = new FakeResponse()
    const isAuthorized = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      isAuthorized,
      'user',
      'user-1'
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(res.frames.map(frame => JSON.parse(frame))).toEqual([
      {
        schemaVersion: 1,
        type: 'resync_required',
        cursor: '00000000-0000-0000-0000-000000000000',
        scopes: ['gfs', 'authorization'],
      },
      {
        schemaVersion: 1,
        type: 'stream.closing',
        cursor: '00000000-0000-0000-0000-000000000000',
        reason: 'session_expired',
      },
    ])
    expect(res.writableEnded).toBe(true)
    expect(isAuthorized).toHaveBeenCalledTimes(3)
    expect(serviceMock.readEntityChangeCheckpoint).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('rechecks user currentness after a backpressure wait before allowing the poll to continue', async () => {
    vi.useFakeTimers()
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs'],
    })
    const req = new FakeRequest()
    const res = new FakeResponse()
    res.writeReturns = false
    const isAuthorized = vi
      .fn()
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'denied', reason: 'revoked' })

    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      isAuthorized,
      'user',
      'user-backpressure'
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(res.frames.map(frame => JSON.parse(frame))).toEqual([
        {
          schemaVersion: 1,
          type: 'resync_required',
          cursor: '00000000-0000-0000-0000-000000000000',
          scopes: ['gfs', 'authorization'],
        },
      ])
      res.once('drain', () => {
        res.writeReturns = true
      })
      res.emit('drain')
      await vi.advanceTimersByTimeAsync(0)

      expect(res.frames.map(frame => JSON.parse(frame))).toEqual([
        {
          schemaVersion: 1,
          type: 'resync_required',
          cursor: '00000000-0000-0000-0000-000000000000',
          scopes: ['gfs', 'authorization'],
        },
        {
          schemaVersion: 1,
          type: 'stream.closing',
          cursor: '00000000-0000-0000-0000-000000000000',
          reason: 'session_expired',
        },
      ])
      expect(res.writableEnded).toBe(true)
      expect(isAuthorized).toHaveBeenCalledTimes(3)
    } finally {
      closeActiveEntityChangeStreams()
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('holds the user cursor during authority outage after backpressure and resumes after recovery', async () => {
    vi.useFakeTimers()
    const req = new FakeRequest()
    const res = new FakeResponse()
    res.writeReturns = false
    const isAuthorized = vi
      .fn()
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'current' })
      .mockResolvedValueOnce({ status: 'unavailable', error: new Error('database unavailable') })
      .mockResolvedValue({ status: 'current' })

    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      isAuthorized,
      'user',
      'user-outage'
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(res.frames).toHaveLength(1)
      res.once('drain', () => {
        res.writeReturns = true
      })
      res.emit('drain')
      await vi.advanceTimersByTimeAsync(0)

      expect(res.frames.map(frame => JSON.parse(frame))).toEqual([
        {
          schemaVersion: 1,
          type: 'resync_required',
          cursor: '00000000-0000-0000-0000-000000000000',
          scopes: ['gfs', 'authorization'],
        },
      ])
      await vi.advanceTimersByTimeAsync(configMock.entityChangeUserVisibilityRefreshMs)
      expect(res.frames.map(frame => JSON.parse(frame))).toEqual([
        {
          schemaVersion: 1,
          type: 'resync_required',
          cursor: '00000000-0000-0000-0000-000000000000',
          scopes: ['gfs', 'authorization'],
        },
        {
          schemaVersion: 1,
          type: 'resync_required',
          cursor: '00000000-0000-0000-0000-000000000000',
          scopes: ['gfs', 'authorization'],
        },
      ])
      expect(res.frames.join('')).not.toContain(CURSOR)
      expect(res.writableEnded).toBe(false)
    } finally {
      closeActiveEntityChangeStreams()
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('rechecks authorization before delivering an established operator invalidation', async () => {
    vi.useFakeTimers()
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs'],
    })
    const req = new FakeRequest()
    const res = new FakeResponse()
    const isAuthorized = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      isAuthorized,
      'operator'
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(res.frames.map(frame => JSON.parse(frame))).toEqual([
      {
        schemaVersion: 1,
        type: 'stream.closing',
        cursor: CURSOR,
        reason: 'session_expired',
      },
    ])
    expect(res.writableEnded).toBe(true)
    expect(res.frames.join('')).not.toContain('scope.invalidated')
    expect(serviceMock.subscribeEntityChangeFeedWake).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('does not deliver a checkpoint when authorization throws and retries after recovery', async () => {
    vi.useFakeTimers()
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs'],
    })
    const req = new FakeRequest()
    const res = new FakeResponse()
    let wakeFeed: (() => void) | undefined
    serviceMock.subscribeEntityChangeFeedWake.mockImplementation((wake: () => void) => {
      wakeFeed = wake
      return vi.fn()
    })
    const isAuthorized = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('authorization backend unavailable'))
      .mockResolvedValue(true)

    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      isAuthorized,
      'operator'
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(res.frames).toEqual([])

    for (let attempt = 0; attempt < 3; attempt += 1) {
      wakeFeed?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(isAuthorized).toHaveBeenCalledTimes(2)
    expect(res.frames).toEqual([])

    await vi.advanceTimersByTimeAsync(configMock.entityChangeStreamPollMs)
    expect(isAuthorized).toHaveBeenCalledTimes(3)
    expect(res.frames.map(frame => JSON.parse(frame))).toContainEqual({
      schemaVersion: 1,
      type: 'scope.invalidated',
      cursor: CURSOR,
      scopes: ['gfs'],
    })
    closeActiveEntityChangeStreams()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })

  it('times out a slow consumer and releases its principal connection slot', async () => {
    vi.useFakeTimers()
    configMock.entityChangeStreamMaxConnections = 1
    configMock.entityChangeStreamMaxConnectionsPerPrincipal = 1
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs'],
    })
    const start = (writeReturns: boolean) => {
      const req = new FakeRequest()
      const res = new FakeResponse()
      res.writeReturns = writeReturns
      streamEntityChanges(
        req as unknown as Request,
        res as unknown as Response,
        CURSOR,
        async () => true,
        'operator',
        'operator-1'
      )
      return { req, res }
    }

    const slow = start(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(slow.res.frames).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(slow.res.frames).toHaveLength(2)
    const stillOccupied = start(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(stillOccupied.res.statusCode).toBe(429)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(slow.res.writableEnded).toBe(true)
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: [],
    })
    const afterRelease = start(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(afterRelease.res.headersSent).toBe(true)
    closeActiveEntityChangeStreams()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })

  it('closes before writing when the buffered response is already over the byte limit', async () => {
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs'],
    })
    const req = new FakeRequest()
    const res = new FakeResponse()
    res.writableLength = 64 * 1024

    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      async () => true,
      'operator',
      'operator-buffer-limit'
    )

    try {
      await vi.waitFor(() => expect(res.writableEnded).toBe(true))
      expect(res.frames).toEqual([])
      expect(serviceMock.readEntityChangeCheckpoint).toHaveBeenCalledOnce()
    } finally {
      closeActiveEntityChangeStreams()
    }
  })

  it('emits an operator heartbeat on the configured cadence without a feed change', async () => {
    vi.useFakeTimers()
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: [],
    })
    const req = new FakeRequest()
    const res = new FakeResponse()

    streamEntityChanges(
      req as unknown as Request,
      res as unknown as Response,
      CURSOR,
      async () => true,
      'operator',
      'operator-heartbeat'
    )

    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(res.frames).toEqual([])
      await vi.advanceTimersByTimeAsync(configMock.entityChangeStreamHeartbeatMs)

      expect(res.frames.map(frame => JSON.parse(frame))).toContainEqual(
        expect.objectContaining({
          schemaVersion: 1,
          type: 'heartbeat',
          cursor: CURSOR,
          observedAt: expect.any(String),
        })
      )
    } finally {
      closeActiveEntityChangeStreams()
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('closes the HTTP response after a timed-out slow-consumer write', async () => {
    configMock.entityChangeStreamMaxConnections = 1
    configMock.entityChangeStreamMaxConnectionsPerPrincipal = 1
    serviceMock.readEntityChangeCheckpoint.mockResolvedValue({
      resyncRequired: false,
      cursor: CURSOR,
      scopes: ['gfs'],
    })

    const app = express()
    app.get('/entity-changes', (req, res) => {
      const write = res.write.bind(res)
      let simulateBackpressure = true
      res.write = ((...args: Parameters<typeof res.write>) => {
        const accepted = write(...args)
        if (simulateBackpressure) {
          simulateBackpressure = false
          return false
        }
        return accepted
      }) as typeof res.write

      streamEntityChanges(
        req as unknown as Request,
        res as unknown as Response,
        CURSOR,
        async () => true,
        'operator',
        'operator-socket'
      )
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address() as AddressInfo

    try {
      const completedResponse = new Promise<{
        complete: boolean
        lines: string[]
        statusCode: number | undefined
      }>((resolve, reject) => {
        const request = get(
          `http://127.0.0.1:${address.port}/entity-changes`,
          (response: import('node:http').IncomingMessage) => {
            response.setEncoding('utf8')
            let body = ''
            response.on('data', chunk => {
              body += chunk
            })
            response.on('end', () => {
              resolve({
                complete: response.complete,
                lines: body.trim().split('\n').filter(Boolean),
                statusCode: response.statusCode,
              })
            })
            response.on('error', reject)
          }
        )
        request.on('error', reject)
      })

      const result = await completedResponse
      expect(result.statusCode).toBe(200)
      expect(result.complete).toBe(true)
      expect(result.lines.map(line => JSON.parse(line))).toContainEqual({
        schemaVersion: 1,
        type: 'stream.closing',
        cursor: CURSOR,
        reason: 'slow_consumer',
      })
    } finally {
      closeActiveEntityChangeStreams()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
