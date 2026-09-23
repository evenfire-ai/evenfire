import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { EventEmitter } from 'node:events'
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
    return true
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
})
