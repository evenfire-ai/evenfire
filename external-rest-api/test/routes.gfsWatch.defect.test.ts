import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { type Server, createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.js'

vi.mock('../src/authToken.js', () => ({
  verifyToken: (token: string) =>
    token === 'session-u1'
      ? {
          userId: '11111111-1111-4111-8111-111111111111',
          email: 'user@example.invalid',
          teamId: null,
          role: 'member',
          exp: 9_999_999_999,
          sessionContract: 'v1',
        }
      : null,
}))

// A defect inside the watch handlers, after the edge has authenticated the
// request: the client calls fail with errors no handler expects.
const defects = vi.hoisted(() => ({ put: vi.fn(), stream: vi.fn() }))
vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return {
    ...actual,
    controlApiRequestWithStatus: defects.put,
    controlApiStreamRequest: defects.stream,
  }
})

type Outcome = { status: number; headers: Record<string, unknown>; body: string; aborted: boolean }

function call(url: string, method: string, body?: unknown): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      url,
      {
        method,
        headers: {
          authorization: 'Bearer session-u1',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }),
        },
      },
      res => {
        let buf = ''
        let aborted = false
        res.setEncoding('utf8')
        res.on('data', (c: string) => (buf += c))
        res.on('aborted', () => (aborted = true))
        res.on('error', () => (aborted = true))
        res.on('close', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, aborted })
        )
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

describe('GFS watch handler defects', () => {
  let server: Server
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me/gfs/watch`

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server = createServer(createApp())
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    defects.put.mockReset()
    defects.stream.mockReset()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('answers an unexpected failure before the response started with 503 watch_reopen, never 500', async () => {
    defects.put.mockRejectedValue(new RangeError('defect'))
    defects.stream.mockRejectedValue(new RangeError('defect'))
    for (const method of ['GET', 'PUT']) {
      const r = await call(
        url(),
        method,
        method === 'PUT' ? { connId: 'x', seq: 1, keys: [] } : undefined
      )
      expect(
        {
          status: r.status,
          retryAfter: r.headers['retry-after'],
          code: r.headers['x-watch-error'],
        },
        method
      ).toEqual({ status: 503, retryAfter: '2', code: 'watch_reopen' })
      expect(JSON.parse(r.body), method).toEqual({ error: 'watch_reopen' })
    }
  })

  it('treats only a fetch failure as transport; any other TypeError is a logged defect', async () => {
    const defectLog = vi.mocked(console.error)
    const cases: Array<[string, TypeError, boolean]> = [
      ['fetch failed', new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }), false],
      ['defect', new TypeError('x is not a function'), true],
    ]
    for (const [name, error, logged] of cases) {
      defectLog.mockClear()
      defects.stream.mockRejectedValueOnce(error)
      const r = await call(url(), 'GET')
      expect({ status: r.status, code: r.headers['x-watch-error'] }, name).toEqual({
        status: 503,
        code: 'watch_reopen',
      })
      expect(defectLog.mock.calls.length > 0, name).toBe(logged)
    }
  })

  it('cuts the stream when it fails after the headers went out', async () => {
    defects.stream.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n'))
            setTimeout(() => controller.error(new RangeError('defect')), 10)
          },
        }),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
      )
    )
    const r = await call(url(), 'GET')
    expect(r.status).toBe(200)
    expect(r.body).toBe('{"type":"ready"}\n')
    expect(r.aborted).toBe(true)
  })
})
