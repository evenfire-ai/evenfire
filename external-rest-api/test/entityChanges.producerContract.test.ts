import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import express from 'express'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import {
  closeActiveEntityChangeStreams,
  streamEntityChanges,
} from '../../control-api/src/routes/entityChangeStream.js'
import { parseEntityChangeFrame } from '../../control-ui/lib/entityChangeStream.js'
import { AuthClient } from '../../desktop-app/src/authClient.js'
import { createEntityChangesRouter } from '../src/routes/entityChanges.js'

const producerMocks = vi.hoisted(() => ({
  isEntityChangeCursor: vi.fn(),
  readEntityChangeCheckpoint: vi.fn(),
  subscribeEntityChangeFeedWake: vi.fn(),
}))
const producerConfig = vi.hoisted(() => ({
  entityChangeStreamHeartbeatMs: 20_000,
  entityChangeStreamMaxLifetimeMs: 600_000,
  entityChangeStreamPollMs: 1000,
  entityChangeUserVisibilityRefreshMs: 4000,
  entityChangeStreamMaxConnections: 256,
  entityChangeStreamMaxConnectionsPerPrincipal: 8,
}))
const producerMetrics = vi.hoisted(() => ({
  entityChangeStreamConnectionsActive: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamDisconnectsTotal: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamFramesSentTotal: { inc: vi.fn(), dec: vi.fn() },
  entityChangeStreamResyncRequiredTotal: { inc: vi.fn(), dec: vi.fn() },
}))
const externalAuth = vi.hoisted(() => ({ verifyToken: vi.fn() }))
const externalControlApi = vi.hoisted(() => ({
  controlApiStreamRequest: vi.fn(),
  ControlApiError: class ControlApiError extends Error {
    status: number
    body: unknown
    headers: Record<string, string>
    constructor(message: string, status: number, body: unknown, headers = {}) {
      super(message)
      this.status = status
      this.body = body
      this.headers = headers
    }
  },
}))

vi.mock('../../control-api/src/config.js', () => ({ config: producerConfig }))
vi.mock('../../control-api/src/services/entityChangeService.js', () => producerMocks)
vi.mock('../../control-api/src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../../control-api/src/observability/metrics.js', () => producerMetrics)
vi.mock('../src/authToken.js', () => externalAuth)
vi.mock('../src/controlApiClient.js', () => externalControlApi)
vi.mock('../../desktop-app/src/config.js', () => ({
  config: { externalRestApiBaseUrl: 'http://rest', requestTimeoutMs: 60_000 },
}))

const CURSOR = 'd119f895-1ef8-4e73-8f08-f9754919682a'
const NEXT_CURSOR = '7a823ef5-ef6b-44d2-9dc2-b13862be831f'

class ProducerRequest extends EventEmitter {
  query: Record<string, unknown> = {}
  setTimeout = vi.fn()
}

class ProducerResponse extends EventEmitter {
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

async function flushAsyncWork(iterations = 12): Promise<void> {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve()
}

async function startControlApiProducer(
  principalKind: 'user' | 'operator',
  principalId: string
): Promise<{ response: ProducerResponse }> {
  const req = new ProducerRequest()
  const res = new ProducerResponse()
  streamEntityChanges(
    req as unknown as Request,
    res as unknown as Response,
    null,
    async () => true,
    principalKind,
    principalId
  )
  await flushAsyncWork()
  if (!res.headersSent) throw new Error('Control API producer did not start the stream')
  return { response: res }
}

function frameTypes(response: ProducerResponse): string[] {
  return response.frames.map(value => (JSON.parse(value) as { type: string }).type)
}

function frameFrom(response: ProducerResponse, type: string): string {
  const frame = response.frames
    .map(value => value.trim())
    .find(value => (JSON.parse(value) as { type?: string }).type === type)
  if (!frame) throw new Error(`Control API producer did not emit ${type}`)
  return frame
}

describe('Control API entity-change producer contract', () => {
  beforeEach(() => {
    producerMocks.isEntityChangeCursor.mockImplementation((value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
    producerMocks.readEntityChangeCheckpoint.mockReset()
    producerMocks.subscribeEntityChangeFeedWake.mockReset().mockReturnValue(vi.fn())
    externalAuth.verifyToken.mockReset().mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: 9_999_999_999,
    })
    externalControlApi.controlApiStreamRequest.mockReset()
    vi.unstubAllGlobals()
  })

  afterEach(async () => {
    closeActiveEntityChangeStreams()
    await flushAsyncWork()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('proxies user frames at the configured visibility cadence to the Desktop parser', async () => {
    vi.useFakeTimers()
    const producer = await startControlApiProducer('user', 'user-1')
    expect(frameTypes(producer.response)).toEqual(['resync_required'])

    await vi.advanceTimersByTimeAsync(producerConfig.entityChangeUserVisibilityRefreshMs)
    await flushAsyncWork()
    expect(frameTypes(producer.response)).toEqual(['resync_required', 'scope.invalidated'])
    closeActiveEntityChangeStreams()
    await flushAsyncWork()

    const producerFrames = producer.response.frames
    expect(frameTypes(producer.response)).toEqual([
      'resync_required',
      'scope.invalidated',
      'stream.closing',
    ])
    const encoder = new TextEncoder()
    externalControlApi.controlApiStreamRequest.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(producerFrames.join('')))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        }
      )
    )

    const proxied = await request(express().use(createEntityChangesRouter()))
      .get('/entity-changes/stream')
      .set('authorization', 'Bearer session-token')
      .expect(200)
    expect(proxied.text).toBe(producerFrames.join(''))

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`${proxied.text}`, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        })
      )
    )
    const desktopEvents: Array<Record<string, unknown>> = []
    await new AuthClient().openEntityChangeStream(
      'session-token',
      null,
      event => desktopEvents.push(event as unknown as Record<string, unknown>),
      new AbortController().signal
    )
    expect(desktopEvents.map(event => event.type)).toEqual([
      'open',
      'resync_required',
      'scope.invalidated',
      'stream.closing',
    ])
    expect(parseEntityChangeFrame(frameFrom(producer.response, 'scope.invalidated'))).toMatchObject(
      {
        type: 'scope.invalidated',
        scopes: ['gfs', 'authorization'],
      }
    )
    expect(JSON.stringify(desktopEvents)).not.toContain('file-contents')
  })

  it('feeds operator resync, invalidation, heartbeat and closing frames through Control UI parsing', async () => {
    vi.useFakeTimers()
    let checkpoint = {
      resyncRequired: true,
      cursor: CURSOR,
      scopes: [] as Array<'gfs' | 'authorization'>,
    }
    producerMocks.readEntityChangeCheckpoint.mockImplementation(async () => checkpoint)
    let wakeFeed: (() => void) | undefined
    producerMocks.subscribeEntityChangeFeedWake.mockImplementation((wake: () => void) => {
      wakeFeed = wake
      return vi.fn()
    })

    const producer = await startControlApiProducer('operator', 'operator-1')
    expect(frameTypes(producer.response)).toEqual(['resync_required'])
    checkpoint = { resyncRequired: false, cursor: NEXT_CURSOR, scopes: ['gfs'] }
    wakeFeed?.()
    await flushAsyncWork()
    checkpoint = { resyncRequired: false, cursor: NEXT_CURSOR, scopes: [] }
    await vi.advanceTimersByTimeAsync(producerConfig.entityChangeStreamHeartbeatMs)
    await flushAsyncWork()
    closeActiveEntityChangeStreams()
    await flushAsyncWork()

    expect(frameTypes(producer.response)).toEqual([
      'resync_required',
      'scope.invalidated',
      'heartbeat',
      'stream.closing',
    ])
    const controlUiEvents = producer.response.frames
      .map(value => parseEntityChangeFrame(value.trim()))
      .filter((event): event is NonNullable<typeof event> => event !== null)
    expect(controlUiEvents.map(event => event.type)).toEqual([
      'resync_required',
      'scope.invalidated',
      'heartbeat',
      'stream.closing',
    ])
    expect(controlUiEvents[1]).toMatchObject({ type: 'scope.invalidated', scopes: ['gfs'] })
    expect(controlUiEvents[2]).toMatchObject({ type: 'heartbeat', cursor: NEXT_CURSOR })
    expect(controlUiEvents[3]).toMatchObject({
      type: 'stream.closing',
      reason: 'server_shutdown',
    })
  })
})
