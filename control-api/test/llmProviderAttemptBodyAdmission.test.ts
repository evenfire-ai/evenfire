import { describe, expect, it, vi } from 'vitest'
import express, { type Request, type RequestHandler, type Response } from 'express'
import { EventEmitter } from 'node:events'
import { type Server, createServer } from 'node:http'
import net from 'node:net'
import {
  AuthorizeBodyAdmission,
  AuthorizeWorkInterrupted,
} from '../src/middleware/llmProviderAttemptBodyAdmission.js'

type FakeRequest = EventEmitter & {
  body?: unknown
  aborted: boolean
  destroyed: boolean
  pause: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  log?: FakeRequestLogger
}

type FakeChildLogger = {
  warn: ReturnType<typeof vi.fn>
}

type FakeRequestLogger = {
  child: ReturnType<typeof vi.fn>
}

type FakeResponse = EventEmitter & {
  destroyed: boolean
  writableEnded: boolean
  writableFinished: boolean
  headersSent: boolean
  statusCode?: number
  body?: unknown
  setHeader: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

function fakeRequest(): FakeRequest {
  const request = new EventEmitter() as FakeRequest
  request.body = undefined
  request.aborted = false
  request.destroyed = false
  request.pause = vi.fn()
  request.destroy = vi.fn(() => {
    request.destroyed = true
    request.aborted = true
    request.emit('close')
  })
  return request
}

function fakeResponse(): FakeResponse {
  const response = new EventEmitter() as FakeResponse
  response.destroyed = false
  response.writableEnded = false
  response.writableFinished = false
  response.headersSent = false
  response.setHeader = vi.fn()
  response.status = vi.fn((code: number) => {
    response.statusCode = code
    return response
  })
  response.json = vi.fn((body: unknown) => {
    response.headersSent = true
    response.body = body
    return response
  })
  return response
}

function fakeRequestLogger(): { logger: FakeRequestLogger; child: FakeChildLogger } {
  const childLogger: FakeChildLogger = { warn: vi.fn() }
  return {
    logger: { child: vi.fn(() => childLogger) },
    child: childLogger,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function withServer(app: express.Express, run: (port: number) => Promise<void>) {
  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await EventEmitter.once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server has no port')
  try {
    await run(address.port)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
}

function readRawResponse(
  port: number,
  payload: string | Buffer
): Promise<{
  status: number
  headers: string
  body: string
}> {
  const socket = net.connect(port)
  const chunks: Buffer[] = []
  const result = new Promise<{
    status: number
    headers: string
    body: string
  }>(resolve => {
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const headerEnd = text.indexOf('\r\n\r\n')
      const headers = text.slice(0, headerEnd)
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/m.exec(headers)?.[1]),
        headers,
        body: text.slice(headerEnd + 4),
      })
    })
  })
  socket.write(payload)
  socket.end()
  return result
}

describe('AuthorizeBodyAdmission policy and idempotence', () => {
  it('rejects invalid counts and timer values and freezes the accepted policy', () => {
    const valid = { maxInFlight: 1, readDeadlineMs: 20, workDeadlineMs: 20, closeGraceMs: 5 }
    const gate = new AuthorizeBodyAdmission(valid)
    expect(() => {
      ;(gate as unknown as { policy: { maxInFlight: number } }).policy.maxInFlight = 99
    }).toThrow(TypeError)
    const first = gate.tryAcquire()
    expect(first).not.toBeNull()
    expect(gate.tryAcquire()).toBeNull()
    first?.()

    expect(() => new AuthorizeBodyAdmission({ ...valid, maxInFlight: 0 })).toThrow(TypeError)
    expect(() => new AuthorizeBodyAdmission({ ...valid, maxInFlight: 1.5 })).toThrow(TypeError)
    for (const key of ['readDeadlineMs', 'workDeadlineMs', 'closeGraceMs'] as const) {
      expect(() => new AuthorizeBodyAdmission({ ...valid, [key]: 0 })).toThrow(TypeError)
      expect(() => new AuthorizeBodyAdmission({ ...valid, [key]: 2_147_483_648 })).toThrow(
        TypeError
      )
    }
  })

  it('an old release cannot free the slot occupied by a newer request', () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
    })
    const releaseA = gate.tryAcquire()
    expect(releaseA).not.toBeNull()
    expect(gate.tryAcquire()).toBeNull()
    releaseA?.()
    const releaseB = gate.tryAcquire()
    expect(releaseB).not.toBeNull()
    releaseA?.()
    expect(gate.tryAcquire()).toBeNull()
    releaseB?.()
    const releaseC = gate.tryAcquire()
    expect(releaseC).not.toBeNull()
    releaseC?.()
  })

  it('clears retained request bodies and ignores duplicate parser callbacks', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn<RequestHandler>((_req, _res, next) => {
      _req.body = { retained: true }
      next()
      next(new Error('duplicate callback'))
    })
    const work = vi.fn(async () => undefined)

    await gate.run(req as never, res as never, parser, work)

    expect(work).toHaveBeenCalledOnce()
    expect(req.body).toBeUndefined()
    expect(gate.tryAcquire()).not.toBeNull()
  })
})

describe('AuthorizeBodyAdmission parser lifecycle', () => {
  it.each([
    {
      name: 'malformed JSON',
      error: Object.assign(new SyntaxError('malformed'), {
        type: 'entity.parse.failed',
        body: 'malformed-body',
      }),
      expectedConnectionClose: false,
    },
    {
      name: 'over-deep structure',
      error: Object.assign(new Error('too deep'), {
        type: 'body.structure.too.deep',
        body: 'deep-body',
      }),
      expectedConnectionClose: false,
    },
    {
      name: 'compressed body',
      error: Object.assign(new Error('gzip'), {
        type: 'encoding.unsupported',
        body: 'compressed-body',
      }),
      expectedConnectionClose: false,
    },
    {
      name: 'payload over limit',
      error: Object.assign(new Error('too large'), {
        type: 'entity.too.large',
        status: 413,
        body: 'oversize-body',
      }),
      expectedConnectionClose: true,
    },
  ])('propagates the $name parser error after removing its raw body', async case_ => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn((_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
      next(case_.error)
    })
    const work = vi.fn(async () => undefined)

    await expect(gate.run(req as never, res as never, parser as RequestHandler, work)).rejects.toBe(
      case_.error
    )

    expect(work).not.toHaveBeenCalled()
    expect(case_.error).not.toHaveProperty('body')
    if (case_.expectedConnectionClose) {
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close')
    } else {
      expect(res.setHeader).not.toHaveBeenCalledWith('Connection', 'close')
    }
    expect(gate.tryAcquire()).not.toBeNull()
  })

  it('stops a stalled read through closeGrace even when response finish never arrives', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 15,
      workDeadlineMs: 100,
      closeGraceMs: 5,
    })
    const req = fakeRequest()
    const requestLogger = fakeRequestLogger()
    req.log = requestLogger.logger
    const res = fakeResponse()
    const parser = vi.fn<RequestHandler>((request, _response, next) => {
      request.once('close', next)
    })
    const work = vi.fn(async () => undefined)

    const running = gate.run(req as never, res as never, parser, work)
    await vi.waitFor(() => expect(res.body).toEqual({ error: 'request_timeout' }))
    await running

    expect(req.destroy).toHaveBeenCalledOnce()
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close')
    expect(work).not.toHaveBeenCalled()
    expect(EventEmitter.listenerCount(res, 'close')).toBe(0)
    expect(EventEmitter.listenerCount(res, 'finish')).toBe(0)
    expect(gate.tryAcquire()).not.toBeNull()
    expect(req.log?.child).toHaveBeenCalledWith({
      module: 'llm-provider-attempt-body-admission',
    })
    expect(requestLogger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'llm_provider_attempt_body_refused',
        reason: 'read_deadline',
        closeGraceMs: 5,
      }),
      'authorize body read deadline exceeded'
    )
  })

  it('bounds a never-finishing capacity refusal without reading or starting work', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 5,
    })
    const holder = gate.tryAcquire()
    expect(holder).not.toBeNull()
    const req = fakeRequest()
    const requestLogger = fakeRequestLogger()
    req.log = requestLogger.logger
    const res = fakeResponse()
    const parser = vi.fn()
    const work = vi.fn(async () => undefined)

    await gate.run(req as never, res as never, parser as RequestHandler, work)
    await vi.waitFor(() => expect(req.destroy).toHaveBeenCalledOnce())

    expect(req.pause).toHaveBeenCalledOnce()
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close')
    expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
    expect(parser).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
    expect(EventEmitter.listenerCount(res, 'close')).toBe(0)
    expect(EventEmitter.listenerCount(res, 'finish')).toBe(0)
    expect(gate.tryAcquire()).toBeNull()
    expect(req.log?.child).toHaveBeenCalledWith({
      module: 'llm-provider-attempt-body-admission',
    })
    expect(requestLogger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'llm_provider_attempt_admission_refused',
        reason: 'authorize_capacity_exceeded',
        inFlight: 1,
        maxInFlight: 1,
      }),
      'authorize admission refused before body read'
    )

    holder?.()
    expect(gate.tryAcquire()).not.toBeNull()
  })

  it('uses close during parsing only to stop the reader and never starts work', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn<RequestHandler>((request, _response, next) => {
      request.once('close', next)
    })
    const work = vi.fn(async () => undefined)

    await Promise.all([
      gate.run(req as never, res as never, parser, work),
      Promise.resolve().then(() => res.emit('close')),
    ])

    expect(req.destroy).toHaveBeenCalledOnce()
    expect(work).not.toHaveBeenCalled()
    expect(gate.tryAcquire()).not.toBeNull()
  })
})

describe('AuthorizeBodyAdmission work cancellation', () => {
  it('preserves typed authorize_timeout after real signal-aware work settles', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 100,
      workDeadlineMs: 15,
      closeGraceMs: 10,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn((_req: unknown, _res: unknown, next: () => void) => next())
    const work = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )

    const error = await gate
      .run(req as never, res as never, parser as RequestHandler, work)
      .catch(err => err)

    expect(error).toBeInstanceOf(AuthorizeWorkInterrupted)
    expect((error as AuthorizeWorkInterrupted).code).toBe('authorize_timeout')
    expect(EventEmitter.listenerCount(res, 'close')).toBe(0)
    expect(gate.tryAcquire()).not.toBeNull()
  })

  it('does not free a work owner on client close until signal-aware work unwinds', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 1000,
      workDeadlineMs: 5000,
      closeGraceMs: 10,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn((_req: unknown, _res: unknown, next: () => void) => next())
    const workStarted = deferred()
    const closeObserved = deferred()
    const allowWorkUnwind = deferred()
    const workSettled = deferred<AuthorizeWorkInterrupted>()
    const work = vi.fn(async (signal: AbortSignal) => {
      workStarted.resolve()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          async () => {
            closeObserved.resolve()
            await allowWorkUnwind.promise
            reject(signal.reason)
          },
          { once: true }
        )
      })
    })

    const running = gate
      .run(req as never, res as never, parser as RequestHandler, signal =>
        work(signal).catch((err: AuthorizeWorkInterrupted) => {
          workSettled.resolve(err)
          throw err
        })
      )
      .catch(error => error)
    await workStarted.promise
    res.emit('close')
    await closeObserved.promise

    expect(gate.tryAcquire()).toBeNull()
    allowWorkUnwind.resolve()
    const error = (await Promise.all([running, workSettled.promise]))[1]
    expect(error.code).toBe('authorize_aborted')
    expect(req.body).toBeUndefined()
    expect(gate.tryAcquire()).not.toBeNull()
  })
})

describe('AuthorizeBodyAdmission HTTP fixture', () => {
  it('preserves chunked JSON and releases after work completes', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 1000,
      workDeadlineMs: 1000,
      closeGraceMs: 10,
    })
    const parser = express.json({ limit: '1kb', inflate: false })
    const work = vi.fn(async (req: express.Request, res: Response, _signal: AbortSignal) => {
      res.status(200).json({ body: req.body })
    })
    const app = express()
    app.post('/test', (req, res, next) => {
      void gate.run(req, res, parser, signal => work(req, res, signal)).catch(next)
    })

    await withServer(app, async port => {
      const body = JSON.stringify({ chunked: true })
      const response = await readRawResponse(
        port,
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          'Transfer-Encoding: chunked\r\n\r\n' +
          `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`
      )
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ body: { chunked: true } })
    })

    expect(work).toHaveBeenCalledOnce()
    expect(gate.tryAcquire()).not.toBeNull()
  })

  it('refuses an over-cap request before parsing and keeps a disconnected work owner charged', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 1000,
      workDeadlineMs: 5000,
      closeGraceMs: 10,
    })
    const parser = express.json({ limit: '1kb', inflate: false })
    const workStarted = deferred()
    const closeObserved = deferred()
    const allowWorkUnwind = deferred()
    const workSettled = deferred<AuthorizeWorkInterrupted>()
    let mode: 'hold' | 'success' = 'hold'
    const work = vi.fn(async (req: express.Request, res: Response, signal: AbortSignal) => {
      if (mode === 'success') {
        res.status(200).json({ ok: true })
        return
      }
      workStarted.resolve()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          async () => {
            closeObserved.resolve()
            await allowWorkUnwind.promise
            reject(signal.reason)
          },
          { once: true }
        )
      })
    })
    const app = express()
    app.post('/test', (req, res, next) => {
      void gate
        .run(req, res, parser, signal =>
          work(req, res, signal).catch((err: AuthorizeWorkInterrupted) => {
            workSettled.resolve(err)
            throw err
          })
        )
        .catch(next)
    })

    await withServer(app, async port => {
      const firstBody = JSON.stringify({ held: true })
      const first = net.connect(port)
      first.write(
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(firstBody)}\r\n\r\n${firstBody}`
      )
      await workStarted.promise

      const refused = await readRawResponse(
        port,
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 2\r\n\r\n{}'
      )
      expect(refused.status).toBe(503)
      expect(JSON.parse(refused.body)).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(refused.headers.toLowerCase()).toContain('connection: close')
      expect(work).toHaveBeenCalledOnce()

      first.destroy()
      await closeObserved.promise
      const stillHeld = await readRawResponse(
        port,
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 2\r\n\r\n{}'
      )
      expect(stillHeld.status).toBe(503)

      allowWorkUnwind.resolve()
      const settled = await workSettled.promise
      expect(settled.code).toBe('authorize_aborted')
      mode = 'success'

      const recovered = await readRawResponse(
        port,
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 2\r\n\r\n{}'
      )
      expect(recovered.status).toBe(200)
      expect(JSON.parse(recovered.body)).toEqual({ ok: true })
    })
  })

  it('releases only after the real body-parser callback follows a destroyed stalled request', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      readDeadlineMs: 5000,
      workDeadlineMs: 1000,
      closeGraceMs: 10,
    })
    const parser = express.json({ limit: '1kb', inflate: false })
    const parserStarted = deferred()
    const wrappedParser: RequestHandler = (req, res, next) => {
      parserStarted.resolve()
      parser(req, res, next)
    }
    const work = vi.fn(async (_req: express.Request, res: Response, _signal: AbortSignal) => {
      res.status(200).json({ ok: true })
    })
    const app = express()
    app.post('/test', (req, res, next) => {
      void gate.run(req, res, wrappedParser, signal => work(req, res, signal)).catch(next)
    })

    await withServer(app, async port => {
      const stalled = net.connect(port)
      stalled.write(
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 100\r\n\r\n{"partial":'
      )
      await parserStarted.promise
      expect(gate.snapshot().inFlight).toBe(1)
      stalled.destroy()

      await vi.waitFor(() => expect(gate.snapshot().inFlight).toBe(0))
      const recovered = await readRawResponse(
        port,
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 2\r\n\r\n{}'
      )
      expect(recovered.status).toBe(200)
      expect(JSON.parse(recovered.body)).toEqual({ ok: true })
    })

    expect(work).toHaveBeenCalledOnce()
  })
})
