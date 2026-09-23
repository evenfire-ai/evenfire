import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { get as httpGet } from 'node:http'
import request from 'supertest'
import { createEntityChangesRouter } from '../src/routes/entityChanges.js'

const authTokenMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
const controlApiClientMock = vi.hoisted(() => ({
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

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/controlApiClient.js', () => controlApiClientMock)

function makeNdjsonStream(line: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

describe('routes/entityChanges', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: 9_999_999_999,
  }

  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    controlApiClientMock.controlApiStreamRequest.mockReset()
  })

  function makeApp() {
    const app = express()
    app.use(createEntityChangesRouter())
    return app
  }

  it('requires an authenticated Desktop session before opening the stream', async () => {
    await request(makeApp()).get('/entity-changes/stream').expect(401)
    expect(controlApiClientMock.controlApiStreamRequest).not.toHaveBeenCalled()
  })

  it('passes opaque upstream NDJSON bytes through without parsing or buffering', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const frame = '{"opaque":"upstream-json-line"}'
    controlApiClientMock.controlApiStreamRequest.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
      }),
      body: makeNdjsonStream(frame),
    })

    const response = await request(makeApp())
      .get('/entity-changes/stream?cursor=d119f895-1ef8-4e73-8f08-f9754919682a')
      .set('authorization', 'Bearer session-token')
      .expect(200)

    expect(response.text.trim()).toBe(frame)
    expect(response.headers['content-type']).toContain('application/x-ndjson')
    expect(response.headers['x-accel-buffering']).toBe('no')
    expect(controlApiClientMock.controlApiStreamRequest).toHaveBeenCalledWith(
      'GET',
      '/external/entity-changes/stream',
      expect.objectContaining({
        query: { cursor: 'd119f895-1ef8-4e73-8f08-f9754919682a' },
        userSessionToken: 'session-token',
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('propagates authorization and cursor errors from control-api', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const error = new controlApiClientMock.ControlApiError(
      'expired cursor',
      410,
      { error: 'resync_required' },
      { 'retry-after': '1' }
    )
    controlApiClientMock.controlApiStreamRequest.mockRejectedValueOnce(error)
    const app = makeApp()
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const status = (err as { status?: number }).status ?? 500
        res.status(status).json({ error: 'unexpected' })
      }
    )

    const response = await request(app)
      .get('/entity-changes/stream?cursor=d119f895-1ef8-4e73-8f08-f9754919682a')
      .set('authorization', 'Bearer session-token')
      .expect(410)
    expect(response.body).toEqual({ error: 'resync_required' })
    expect(response.headers['retry-after']).toBe('1')
  })

  it('preserves upstream server error status without exposing internal response details', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiStreamRequest.mockRejectedValueOnce(
      new controlApiClientMock.ControlApiError(
        'database password must not escape',
        503,
        { error: 'database password must not escape' },
        { 'retry-after': '2' }
      )
    )
    const response = await request(makeApp())
      .get('/entity-changes/stream')
      .set('authorization', 'Bearer session-token')
      .expect(503)
    expect(response.body).toEqual({ error: 'Entity change stream unavailable' })
    expect(response.text).not.toContain('database password')
    expect(response.headers['retry-after']).toBe('2')
  })

  it('cancels the upstream request when the authenticated client disconnects', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    let upstreamSignal: AbortSignal | undefined
    controlApiClientMock.controlApiStreamRequest.mockImplementationOnce(
      (_method: string, _path: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          upstreamSignal = options.signal
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
    )
    const server = makeApp().listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
    const client = httpGet(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: '/entity-changes/stream',
        headers: { authorization: 'Bearer session-token' },
      },
      response => response.resume()
    )
    client.on('error', () => undefined)
    try {
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined())
      client.destroy()
      await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true))
    } finally {
      client.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
