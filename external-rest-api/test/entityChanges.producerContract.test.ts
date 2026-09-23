import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  entityChangeStreamPollMs: 250,
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

async function captureControlApiProducerFrame(): Promise<string> {
  producerMocks.readEntityChangeCheckpoint.mockResolvedValue({
    resyncRequired: false,
    cursor: CURSOR,
    scopes: ['gfs'],
  })
  const req = new ProducerRequest()
  const res = new ProducerResponse()
  streamEntityChanges(
    req as unknown as Request,
    res as unknown as Response,
    null,
    async () => true,
    'user'
  )
  await vi.waitFor(() => expect(res.frames.length).toBeGreaterThan(0))
  closeActiveEntityChangeStreams()
  await vi.waitFor(() => expect(res.writableEnded).toBe(true))
  const frame = res.frames
    .map(value => value.trim())
    .find(value => {
      return (JSON.parse(value) as { type?: string }).type === 'scope.invalidated'
    })
  if (!frame) throw new Error('Control API producer did not emit a scope invalidation')
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

  it('emits one Control API frame that survives proxy framing and both client parsers', async () => {
    const producerFrame = await captureControlApiProducerFrame()
    const encoder = new TextEncoder()
    externalControlApi.controlApiStreamRequest.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${producerFrame}\n`))
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
    expect(proxied.text.trim()).toBe(producerFrame)

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
    expect(desktopEvents[1]).toEqual(JSON.parse(producerFrame))

    expect(parseEntityChangeFrame(producerFrame)).toEqual(JSON.parse(producerFrame))
    expect(JSON.stringify(desktopEvents)).not.toContain('file-contents')
  })
})
