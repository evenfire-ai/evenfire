import { describe, expect, it, vi } from 'vitest'
import express, { type Request, type RequestHandler, type Response } from 'express'
import { EventEmitter } from 'node:events'
import { type Server, createServer } from 'node:http'
import net from 'node:net'
import { LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY } from '../src/middleware/llmProviderAttemptAdmissionLimits.js'
import {
  AuthorizeBodyAdmission,
  AuthorizeWorkInterrupted,
} from '../src/middleware/llmProviderAttemptBodyAdmission.js'

const PRINCIPAL = { sub: 'unit-principal', hostRefs: ['unit-host'] }
const OTHER_PRINCIPAL = { sub: 'other-principal', hostRefs: ['other-host'] }

type FakeRequest = EventEmitter & {
  body?: unknown
  headers?: Record<string, string>
  aborted: boolean
  destroyed: boolean
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  log?: FakeRequestLogger
}

type FakeChildLogger = {
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
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
  request.resume = vi.fn()
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
  const childLogger: FakeChildLogger = { warn: vi.fn(), error: vi.fn() }
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

type LargeBodyOutcome = {
  status: number
  headers: string
  body: string
  bytesQueued: number
  bytesAcknowledged: number
  bytesQueuedAtFirstResponseByte: number | undefined
  ended: boolean
  error: Error | undefined
}

// Writes the head and then the body in chunks, honouring backpressure, while
// reading the response concurrently. It never ends its own side, so a server
// FIN surfaces as `end` and a reset as `error` (EPIPE/ECONNRESET).
async function sendLargeBody(
  port: number,
  head: string,
  totalBytes: number,
  chunkBytes: number,
  closeDeadlineMs: number
): Promise<LargeBodyOutcome> {
  const socket = net.connect(port, '127.0.0.1')
  const chunks: Buffer[] = []
  let bytesQueued = 0
  let bytesAcknowledged = 0
  let bytesQueuedAtFirstResponseByte: number | undefined
  let ended = false
  let error: Error | undefined
  socket.on('data', chunk => {
    bytesQueuedAtFirstResponseByte ??= bytesQueued
    chunks.push(Buffer.from(chunk))
  })
  socket.on('end', () => {
    ended = true
  })
  socket.on('error', err => {
    error = err
  })
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(head)
  const chunk = Buffer.alloc(chunkBytes, 0x20)
  while (bytesQueued < totalBytes && error === undefined && !socket.destroyed) {
    const size = Math.min(chunkBytes, totalBytes - bytesQueued)
    bytesQueued += size
    const flushed = socket.write(chunk.subarray(0, size), err => {
      if (!err) bytesAcknowledged += size
    })
    if (!flushed) {
      await new Promise<void>(resolve => {
        const done = (): void => {
          socket.off('drain', done)
          socket.off('close', done)
          resolve()
        }
        socket.once('drain', done)
        socket.once('close', done)
      })
    }
  }
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`large-body client did not close within ${closeDeadlineMs} ms`)),
          closeDeadlineMs
        )
      }),
    ])
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
    socket.destroy()
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const headerEnd = text.indexOf('\r\n\r\n')
  const headers = headerEnd === -1 ? text : text.slice(0, headerEnd)
  return {
    status: Number(/^HTTP\/1\.1 (\d+)/m.exec(headers)?.[1]),
    headers,
    body: headerEnd === -1 ? '' : text.slice(headerEnd + 4),
    bytesQueued,
    bytesAcknowledged,
    bytesQueuedAtFirstResponseByte,
    ended,
    error,
  }
}

describe('AuthorizeBodyAdmission policy and idempotence', () => {
  it('rejects invalid counts and timer values and freezes the accepted policy', () => {
    const valid = {
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 20,
      workDeadlineMs: 20,
      closeGraceMs: 5,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    }
    const gate = new AuthorizeBodyAdmission(valid)
    expect(() => {
      ;(gate as unknown as { policy: { maxInFlight: number } }).policy.maxInFlight = 99
    }).toThrow(TypeError)
    const first = gate.tryAcquire(PRINCIPAL)
    expect(first).not.toBeNull()
    expect(gate.tryAcquire(PRINCIPAL)).toBeNull()
    first?.()

    expect(() => new AuthorizeBodyAdmission({ ...valid, maxInFlight: 0 })).toThrow(TypeError)
    expect(() => new AuthorizeBodyAdmission({ ...valid, maxInFlight: 1.5 })).toThrow(TypeError)
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new AuthorizeBodyAdmission({ ...valid, maxQueued: value })).toThrow(TypeError)
    }
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new AuthorizeBodyAdmission({ ...valid, maxPerPrincipal: value })).toThrow(
        TypeError
      )
    }
    for (const key of [
      'queueWaitMs',
      'readDeadlineMs',
      'workDeadlineMs',
      'closeGraceMs',
    ] as const) {
      expect(() => new AuthorizeBodyAdmission({ ...valid, [key]: 0 })).toThrow(TypeError)
      expect(() => new AuthorizeBodyAdmission({ ...valid, [key]: 2_147_483_648 })).toThrow(
        TypeError
      )
    }
    // The Host only honours a Retry-After of 1-3600 whole seconds.
    expect(() => new AuthorizeBodyAdmission({ ...valid, retryAfterSeconds: 3600 })).not.toThrow()
    for (const value of [0, 1.5, 3601]) {
      expect(() => new AuthorizeBodyAdmission({ ...valid, retryAfterSeconds: value })).toThrow(
        TypeError
      )
    }
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new AuthorizeBodyAdmission({ ...valid, maxDiscardBodyBytes: value })).toThrow(
        TypeError
      )
    }
  })

  it('an old release cannot free the slot occupied by a newer request', () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    })
    const releaseA = gate.tryAcquire(PRINCIPAL)
    expect(releaseA).not.toBeNull()
    expect(gate.tryAcquire(PRINCIPAL)).toBeNull()
    releaseA?.()
    const releaseB = gate.tryAcquire(PRINCIPAL)
    expect(releaseB).not.toBeNull()
    releaseA?.()
    expect(gate.tryAcquire(PRINCIPAL)).toBeNull()
    releaseB?.()
    const releaseC = gate.tryAcquire(PRINCIPAL)
    expect(releaseC).not.toBeNull()
    releaseC?.()
  })

  it('clears retained request bodies and ignores duplicate parser callbacks', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn<RequestHandler>((_req, _res, next) => {
      _req.body = { retained: true }
      next()
      next(new Error('duplicate callback'))
    })
    const work = vi.fn(async () => undefined)

    await gate.run(req as never, res as never, parser, work, PRINCIPAL)

    expect(work).toHaveBeenCalledOnce()
    expect(req.body).toBeUndefined()
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
  })
})

describe('AuthorizeBodyAdmission FIFO and verified-principal share', () => {
  function queuedGate(
    overrides: Partial<ConstructorParameters<typeof AuthorizeBodyAdmission>[0]> = {}
  ) {
    return new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 2,
      maxPerPrincipal: 2,
      queueWaitMs: 1000,
      readDeadlineMs: 1000,
      workDeadlineMs: 1000,
      closeGraceMs: 5,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
      ...overrides,
    })
  }

  it('pauses a healthy overlap before parsing and runs it exactly once after the full unit is released', async () => {
    const gate = queuedGate()
    const holder = gate.tryAcquire(PRINCIPAL)
    const req = fakeRequest()
    const res = fakeResponse()
    const parse = vi.fn<RequestHandler>((request, _response, next) => {
      request.body = { queued: true }
      next()
    })
    const work = vi.fn(async () => undefined)
    const waiting = gate.run(req as never, res as never, parse, work, OTHER_PRINCIPAL)

    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 1, principals: 2 })
    expect(req.pause).toHaveBeenCalledOnce()
    expect(req.resume).not.toHaveBeenCalled()
    expect(req.body).toBeUndefined()
    expect(parse).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()

    holder?.()
    // The grant is charged before the continuation can install its parser.
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
    expect(gate.tryAcquire(PRINCIPAL)).toBeNull()
    await waiting
    expect(parse).toHaveBeenCalledOnce()
    expect(work).toHaveBeenCalledOnce()
    expect(req.body).toBeUndefined()
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('never lets an arrival leapfrog the FIFO and refuses a full queue without parsing or retaining the body', async () => {
    const gate = queuedGate()
    const holder = gate.tryAcquire(PRINCIPAL)
    const order: string[] = []
    const finishB = deferred()
    const finishC = deferred()
    const startedB = deferred()
    const startedC = deferred()
    const parse = vi.fn<RequestHandler>((_request, _response, next) => next())
    const reqB = fakeRequest()
    const resB = fakeResponse()
    const b = gate.run(
      reqB as never,
      resB as never,
      parse,
      async () => {
        order.push('b')
        startedB.resolve()
        await finishB.promise
      },
      OTHER_PRINCIPAL
    )
    const reqC = fakeRequest()
    const resC = fakeResponse()
    const c = gate.run(
      reqC as never,
      resC as never,
      parse,
      async () => {
        order.push('c')
        startedC.resolve()
        await finishC.promise
      },
      { sub: 'third', hostRefs: ['third-host'] }
    )
    const fullReq = fakeRequest()
    const fullRes = fakeResponse()
    const fullParser = vi.fn()
    const refused = gate.run(
      fullReq as never,
      fullRes as never,
      fullParser,
      async () => undefined,
      {
        sub: 'fourth',
        hostRefs: ['fourth-host'],
      }
    )
    // The refusal discards the body to its end before it answers.
    expect(fullRes.setHeader).toHaveBeenCalledWith('Retry-After', '1')
    expect(fullReq.resume).toHaveBeenCalledOnce()
    expect(fullRes.body).toBeUndefined()
    fullReq.emit('data', Buffer.from('{"discarded":true}'))
    expect(fullRes.body).toBeUndefined()
    fullReq.emit('end')
    expect(fullRes.body).toEqual({ error: 'authorize_capacity_exceeded' })
    expect(fullReq.body).toBeUndefined()
    expect(fullParser).not.toHaveBeenCalled()
    await refused
    fullRes.emit('finish')

    holder?.()
    const reqD = fakeRequest()
    const resD = fakeResponse()
    const d = gate.run(
      reqD as never,
      resD as never,
      parse,
      async () => {
        order.push('d')
      },
      { sub: 'fourth', hostRefs: ['fourth-host'] }
    )
    await startedB.promise
    expect(order).toEqual(['b'])
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 2, principals: 3 })
    finishB.resolve()
    await startedC.promise
    expect(order).toEqual(['b', 'c'])
    finishC.resolve()
    await Promise.all([b, c, d])
    expect(order).toEqual(['b', 'c', 'd'])
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  })

  it('charges running plus queued to canonical verified sub and hostRefs, independent of body and provider', async () => {
    const gate = queuedGate()
    const binding = { sub: 'same-sub', hostRefs: ['host-b', 'host-a'] }
    const holder = gate.tryAcquire(binding)
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn<RequestHandler>((_request, _response, next) => next())
    const waiting = gate.run(req as never, res as never, parser, async () => undefined, {
      sub: 'same-sub',
      hostRefs: ['host-a', 'host-b', 'host-a'],
    })
    const rejectedReq = fakeRequest()
    rejectedReq.body = { hostRef: 'forged-other-host', provider: 'grok-subscription' }
    const rejectedRes = fakeResponse()
    const rejectedParser = vi.fn()
    const rejected = gate.run(
      rejectedReq as never,
      rejectedRes as never,
      rejectedParser,
      async () => undefined,
      { sub: 'same-sub', hostRefs: ['host-b', 'host-a'] }
    )
    // principal_share invites the Host's single retry like every capacity refusal.
    expect(rejectedRes.setHeader).toHaveBeenCalledWith('Retry-After', '1')
    expect(rejectedReq.resume).toHaveBeenCalledOnce()
    expect(rejectedRes.body).toBeUndefined()
    rejectedReq.emit('end')
    expect(rejectedRes.body).toEqual({ error: 'authorize_capacity_exceeded' })
    expect(rejectedParser).not.toHaveBeenCalled()
    await rejected
    rejectedRes.emit('finish')

    // A different signed subject has a distinct share despite identical refs.
    const distinctReq = fakeRequest()
    const distinctRes = fakeResponse()
    const distinct = gate.run(
      distinctReq as never,
      distinctRes as never,
      parser,
      async () => undefined,
      { sub: 'different-sub', hostRefs: ['host-a', 'host-b'] }
    )
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 2, principals: 2 })
    holder?.()
    await Promise.all([waiting, distinct])
    const recovered = gate.tryAcquire(binding)
    expect(recovered).not.toBeNull()
    recovered?.()
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  })

  it('gives the same signed subject on a different Host set its own share', async () => {
    const gate = queuedGate()
    const holder = gate.tryAcquire({ sub: 'same-sub', hostRefs: ['host-a'] })
    expect(holder).not.toBeNull()
    const parser = vi.fn<RequestHandler>((_request, _response, next) => next())
    const sameHost = gate.run(
      fakeRequest() as never,
      fakeResponse() as never,
      parser,
      async () => undefined,
      {
        sub: 'same-sub',
        hostRefs: ['host-a'],
      }
    )
    // host-a now holds its two positions; host-b must still be queued, not refused.
    const otherHostRes = fakeResponse()
    const otherHost = gate.run(
      fakeRequest() as never,
      otherHostRes as never,
      parser,
      async () => undefined,
      {
        sub: 'same-sub',
        hostRefs: ['host-b'],
      }
    )
    expect(otherHostRes.body).toBeUndefined()
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 2, principals: 2 })
    holder?.()
    await Promise.all([sameHost, otherHost])
    expect(parser).toHaveBeenCalledTimes(2)
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  })

  it.each(['aborted', 'close'] as const)(
    'removes a queued %s once, cleans its wait hooks and serves the next request',
    async event => {
      vi.useFakeTimers()
      try {
        const gate = queuedGate()
        const holder = gate.tryAcquire(PRINCIPAL)
        const req = fakeRequest()
        const res = fakeResponse()
        const parser = vi.fn<RequestHandler>((_request, _response, next) => next())
        const work = vi.fn(async () => undefined)
        const aborted = gate.run(req as never, res as never, parser, work, OTHER_PRINCIPAL)
        const emitter = event === 'aborted' ? req : res
        emitter.emit(event)
        emitter.emit(event)
        await aborted

        expect(req.destroy).toHaveBeenCalledOnce()
        expect(parser).not.toHaveBeenCalled()
        expect(work).not.toHaveBeenCalled()
        expect(res.status).not.toHaveBeenCalled()
        expect(req.listenerCount('aborted')).toBe(0)
        expect(res.listenerCount('close')).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })

        const next = gate.run(
          fakeRequest() as never,
          fakeResponse() as never,
          parser,
          work,
          OTHER_PRINCIPAL
        )
        holder?.()
        await next
        expect(parser).toHaveBeenCalledOnce()
        expect(work).toHaveBeenCalledOnce()
        expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('expires a queued request with a finite unread-body backstop and ignores the late expiry callback after recovery', async () => {
    vi.useFakeTimers()
    const clock = vi.spyOn(globalThis, 'setTimeout')
    try {
      const gate = queuedGate({ queueWaitMs: 20 })
      const holder = gate.tryAcquire(PRINCIPAL)
      const req = fakeRequest()
      const res = fakeResponse()
      const parser = vi.fn<RequestHandler>((_request, _response, next) => next())
      const work = vi.fn(async () => undefined)
      const expired = gate.run(req as never, res as never, parser, work, OTHER_PRINCIPAL)
      const expiry = clock.mock.calls.find(([, delay]) => delay === 20)?.[0]
      expect(expiry).toBeTypeOf('function')
      await vi.advanceTimersByTimeAsync(20)
      await expired
      // The queue hooks are gone; the refusal's discard reader replaced them.
      expect(req.resume).toHaveBeenCalledOnce()
      expect(req.listenerCount('data')).toBe(1)
      expect(req.listenerCount('aborted')).toBe(1)
      expect(res.body).toBeUndefined()
      expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
      // The body never ends: the read deadline (1000 ms) is its finite backstop.
      await vi.advanceTimersByTimeAsync(999)
      expect(res.body).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(parser).not.toHaveBeenCalled()
      expect(work).not.toHaveBeenCalled()
      expect(req.destroy).not.toHaveBeenCalled()
      expect(req.listenerCount('data')).toBe(0)
      expect(req.listenerCount('aborted')).toBe(0)
      // Response finish never arrives: closeGrace (5 ms) closes the socket.
      await vi.advanceTimersByTimeAsync(5)
      expect(req.destroy).toHaveBeenCalledOnce()
      expect(res.listenerCount('finish')).toBe(0)
      expect(res.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      const next = gate.run(
        fakeRequest() as never,
        fakeResponse() as never,
        parser,
        work,
        OTHER_PRINCIPAL
      )
      holder?.()
      await next
      if (typeof expiry !== 'function') throw new Error('queue expiry callback was not installed')
      expiry()
      res.emit('close')
      req.emit('aborted')
      expect(req.destroy).toHaveBeenCalledOnce()
      expect(work).toHaveBeenCalledOnce()
      expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      clock.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not revive an expired FIFO head when its timer is delayed until after a release', async () => {
    vi.useFakeTimers()
    try {
      const gate = queuedGate({ queueWaitMs: 20 })
      const holder = gate.tryAcquire(PRINCIPAL)
      const req = fakeRequest()
      const res = fakeResponse()
      const parser = vi.fn<RequestHandler>((_request, _response, next) => next())
      const waiting = gate.run(
        req as never,
        res as never,
        parser,
        async () => undefined,
        OTHER_PRINCIPAL
      )
      const monotonic = vi
        .spyOn(globalThis.performance, 'now')
        .mockReturnValue(Number.MAX_SAFE_INTEGER)
      try {
        holder?.()
        await waiting
        expect(req.resume).toHaveBeenCalledOnce()
        expect(res.body).toBeUndefined()
        req.emit('end')
        expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
        expect(parser).not.toHaveBeenCalled()
        expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
        res.emit('finish')
        // A body read to its end is not destroyed; Connection: close ends it.
        expect(req.destroy).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        monotonic.mockRestore()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a grant-to-parser disconnect without starting a reader or leaking a principal share', async () => {
    const gate = queuedGate()
    const holder = gate.tryAcquire(PRINCIPAL)
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn()
    const work = vi.fn(async () => undefined)
    const waiting = gate.run(req as never, res as never, parser, work, OTHER_PRINCIPAL)
    holder?.()
    res.destroyed = true
    res.emit('close')
    await waiting
    expect(parser).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
    expect(req.resume).not.toHaveBeenCalled()
    expect(req.destroy).toHaveBeenCalledOnce()
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  })

  it('keeps a queued reader paused after parser transport close until the actual parser callback unwinds', async () => {
    const gate = queuedGate()
    const req = fakeRequest()
    const res = fakeResponse()
    const parserStarted = deferred()
    let finishParser!: (error?: unknown) => void
    const parser: RequestHandler = (request, _response, next) => {
      request.body = { retainedByParser: true }
      finishParser = next
      parserStarted.resolve()
    }
    const parserError = Object.assign(new Error('closed parser'), { type: 'request.aborted' })
    const activeWork = vi.fn(async () => undefined)
    const active = gate
      .run(req as never, res as never, parser, activeWork, PRINCIPAL)
      .catch(error => error)
    await parserStarted.promise
    const queuedReq = fakeRequest()
    const queuedRes = fakeResponse()
    const queuedParser = vi.fn<RequestHandler>((_request, _response, next) => next())
    const queuedWork = vi.fn(async () => undefined)
    const queued = gate.run(
      queuedReq as never,
      queuedRes as never,
      queuedParser,
      queuedWork,
      OTHER_PRINCIPAL
    )
    res.emit('close')
    expect(req.destroy).toHaveBeenCalledOnce()
    expect(req.body).toEqual({ retainedByParser: true })
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 1, principals: 2 })
    expect(queuedParser).not.toHaveBeenCalled()
    expect(queuedReq.resume).not.toHaveBeenCalled()
    finishParser(parserError)
    expect(await active).toBe(parserError)
    await queued
    finishParser(new Error('late duplicate callback'))
    expect(activeWork).not.toHaveBeenCalled()
    expect(req.body).toBeUndefined()
    expect(queuedParser).toHaveBeenCalledOnce()
    expect(queuedWork).toHaveBeenCalledOnce()
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  })

  it('keeps queued readers paused through active abort and only grants after actual work cleanup', async () => {
    const gate = queuedGate()
    const req = fakeRequest()
    const res = fakeResponse()
    const parse = vi.fn<RequestHandler>((_request, _response, next) => next())
    const activeStarted = deferred()
    const abortObserved = deferred()
    const permitCleanup = deferred()
    const active = gate
      .run(
        req as never,
        res as never,
        parse,
        async signal => {
          activeStarted.resolve()
          await new Promise<void>(resolve =>
            signal.addEventListener(
              'abort',
              () => {
                abortObserved.resolve()
                resolve()
              },
              { once: true }
            )
          )
          await permitCleanup.promise
          signal.throwIfAborted()
        },
        PRINCIPAL
      )
      .catch(error => error)
    await activeStarted.promise
    const queuedReq = fakeRequest()
    const queuedRes = fakeResponse()
    const queuedParse = vi.fn<RequestHandler>((_request, _response, next) => next())
    const queuedWork = vi.fn(async () => undefined)
    const queued = gate.run(
      queuedReq as never,
      queuedRes as never,
      queuedParse,
      queuedWork,
      OTHER_PRINCIPAL
    )
    res.emit('close')
    await abortObserved.promise
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 1, principals: 2 })
    expect(queuedParse).not.toHaveBeenCalled()
    expect(queuedWork).not.toHaveBeenCalled()
    expect(queuedReq.resume).not.toHaveBeenCalled()
    permitCleanup.resolve()
    const interrupted = await active
    expect(interrupted).toBeInstanceOf(AuthorizeWorkInterrupted)
    expect(interrupted.code).toBe('authorize_aborted')
    await queued
    expect(queuedWork).toHaveBeenCalledOnce()
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  })
})

describe('AuthorizeBodyAdmission production queue wait', () => {
  const PRODUCTION = LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY

  it('derives the queue wait from the read and work deadlines a healthy holder can use', () => {
    expect(PRODUCTION.queueWaitMs).toBe(PRODUCTION.readDeadlineMs + PRODUCTION.workDeadlineMs)
    expect(PRODUCTION.queueWaitMs).toBe(40_000)
  })

  function queueBehindHolder() {
    const gate = new AuthorizeBodyAdmission(PRODUCTION)
    const holder = gate.tryAcquire(PRINCIPAL)
    expect(holder).not.toBeNull()
    const req = fakeRequest()
    const res = fakeResponse()
    const requestLogger = fakeRequestLogger()
    req.log = requestLogger.logger
    const parser = vi.fn<RequestHandler>((request, _response, next) => {
      request.body = { queued: true }
      next()
    })
    const work = vi.fn(async () => undefined)
    const waiting = gate.run(req as never, res as never, parser, work, OTHER_PRINCIPAL)
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 1, principals: 2 })
    return { gate, holder: holder!, req, res, requestLogger, parser, work, waiting }
  }

  it('refuses the queued request with queue_wait exactly at 40000 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const queued = queueBehindHolder()
      vi.advanceTimersByTime(PRODUCTION.queueWaitMs - 1)
      expect(queued.gate.snapshot()).toEqual({ inFlight: 1, queued: 1, principals: 2 })
      expect(queued.res.status).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      await queued.waiting
      expect(queued.req.resume).toHaveBeenCalledOnce()
      expect(queued.res.status).not.toHaveBeenCalled()
      queued.req.emit('end')
      expect(queued.res.statusCode).toBe(503)
      expect(queued.res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(queued.requestLogger.child.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'llm_provider_attempt_admission_refused',
          refusal: 'queue_wait',
          queueWaitMs: 40_000,
        }),
        'authorize admission refused before body read'
      )
      expect(queued.parser).not.toHaveBeenCalled()
      expect(queued.work).not.toHaveBeenCalled()
      expect(queued.gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
      queued.holder()
      expect(queued.gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('grants the queued request when the holder releases at 39999 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const queued = queueBehindHolder()
      vi.advanceTimersByTime(PRODUCTION.queueWaitMs - 1)
      queued.holder()
      await queued.waiting
      expect(queued.parser).toHaveBeenCalledOnce()
      expect(queued.work).toHaveBeenCalledOnce()
      expect(queued.res.status).not.toHaveBeenCalled()
      expect(queued.requestLogger.child.warn).not.toHaveBeenCalled()
      expect(queued.gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AuthorizeBodyAdmission uncharged path', () => {
  it('runs the parser and work without taking a unit, queueing or touching principal shares', async () => {
    const gate = new AuthorizeBodyAdmission(LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY)
    const holder = gate.tryAcquire(PRINCIPAL)
    const req = fakeRequest()
    const res = fakeResponse()
    const workStarted = deferred()
    const permitWork = deferred()
    const parser = vi.fn<RequestHandler>((request, _response, next) => {
      request.body = { text: true }
      next()
    })
    let bodySeenByWork: unknown
    const running = gate.runUncharged(req as never, res as never, parser, async () => {
      bodySeenByWork = req.body
      workStarted.resolve()
      await permitWork.promise
    })
    await workStarted.promise
    // The unit is held by another request, yet the uncharged request runs.
    expect(bodySeenByWork).toEqual({ text: true })
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
    expect(req.pause).not.toHaveBeenCalled()
    permitWork.resolve()
    await running
    expect(req.body).toBeUndefined()
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
    holder?.()
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  })

  it('keeps the work deadline on the uncharged path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const gate = new AuthorizeBodyAdmission(LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY)
      const req = fakeRequest()
      const res = fakeResponse()
      const parser = vi.fn<RequestHandler>((_request, _response, next) => next())
      const aborted = deferred()
      const running = gate.runUncharged(req as never, res as never, parser, async signal => {
        signal.addEventListener('abort', () => aborted.resolve(), { once: true })
        await aborted.promise
      })
      const outcome = running.catch(error => error)
      await vi.advanceTimersByTimeAsync(LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.workDeadlineMs)
      const error = await outcome
      expect(error).toBeInstanceOf(AuthorizeWorkInterrupted)
      expect((error as AuthorizeWorkInterrupted).code).toBe('authorize_timeout')
      expect(parser).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
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
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn((_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
      next(case_.error)
    })
    const work = vi.fn(async () => undefined)

    await expect(
      gate.run(req as never, res as never, parser as RequestHandler, work, PRINCIPAL)
    ).rejects.toBe(case_.error)

    expect(work).not.toHaveBeenCalled()
    expect(case_.error).not.toHaveProperty('body')
    if (case_.expectedConnectionClose) {
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close')
    } else {
      expect(res.setHeader).not.toHaveBeenCalledWith('Connection', 'close')
    }
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
  })

  it('stops a stalled read through closeGrace even when response finish never arrives', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 15,
      workDeadlineMs: 100,
      closeGraceMs: 5,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    })
    const req = fakeRequest()
    const requestLogger = fakeRequestLogger()
    req.log = requestLogger.logger
    const res = fakeResponse()
    const parser = vi.fn<RequestHandler>((request, _response, next) => {
      request.once('close', next)
    })
    const work = vi.fn(async () => undefined)

    const running = gate.run(req as never, res as never, parser, work, PRINCIPAL)
    await vi.waitFor(() => expect(res.body).toEqual({ error: 'request_timeout' }))
    await running

    expect(req.destroy).toHaveBeenCalledOnce()
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close')
    expect(work).not.toHaveBeenCalled()
    expect(EventEmitter.listenerCount(res, 'close')).toBe(0)
    expect(EventEmitter.listenerCount(res, 'finish')).toBe(0)
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
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

  it('bounds a never-ending, never-finishing capacity refusal at the read deadline without parsing or starting work', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 5,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    })
    const holder = gate.tryAcquire(PRINCIPAL)
    expect(holder).not.toBeNull()
    const req = fakeRequest()
    const requestLogger = fakeRequestLogger()
    req.log = requestLogger.logger
    const res = fakeResponse()
    const parser = vi.fn()
    const work = vi.fn(async () => undefined)

    await gate.run(req as never, res as never, parser as RequestHandler, work, PRINCIPAL)
    // The refusal discards; the body never ends and finish never arrives.
    expect(req.resume).toHaveBeenCalledOnce()
    expect(res.body).toBeUndefined()
    req.emit('data', Buffer.from('partial'))
    await vi.waitFor(() => expect(req.destroy).toHaveBeenCalledOnce())

    // Paused once by the refusal and once more when the discard stops.
    expect(req.pause).toHaveBeenCalledTimes(2)
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close')
    expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
    expect(req.body).toBeUndefined()
    expect(parser).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
    expect(EventEmitter.listenerCount(res, 'close')).toBe(0)
    expect(EventEmitter.listenerCount(res, 'finish')).toBe(0)
    for (const event of ['data', 'end', 'aborted', 'error']) {
      expect(req.listenerCount(event)).toBe(0)
    }
    expect(gate.tryAcquire(PRINCIPAL)).toBeNull()
    expect(req.log?.child).toHaveBeenCalledWith({
      module: 'llm-provider-attempt-body-admission',
    })
    expect(requestLogger.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'llm_provider_attempt_admission_refused',
        reason: 'authorize_capacity_exceeded',
        inFlight: 1,
        maxInFlight: 1,
        maxQueued: 0,
        maxPerPrincipal: 2,
        queueWaitMs: 100,
      }),
      'authorize admission refused before body read'
    )
    expect(requestLogger.child.warn).toHaveBeenCalledWith(
      {
        event: 'llm_provider_attempt_admission_discard_stopped',
        reason: 'read_deadline',
        discardedBytes: Buffer.byteLength('partial'),
        maxDiscardBodyBytes: 1_048_576,
      },
      'authorize capacity refusal closed before the body ended'
    )

    holder?.()
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
  })

  it('uses close during parsing only to stop the reader and never starts work', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 100,
      workDeadlineMs: 100,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    })
    const req = fakeRequest()
    const res = fakeResponse()
    const parser = vi.fn<RequestHandler>((request, _response, next) => {
      request.once('close', next)
    })
    const work = vi.fn(async () => undefined)

    await Promise.all([
      gate.run(req as never, res as never, parser, work, PRINCIPAL),
      Promise.resolve().then(() => res.emit('close')),
    ])

    expect(req.destroy).toHaveBeenCalledOnce()
    expect(work).not.toHaveBeenCalled()
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
  })
})

describe('AuthorizeBodyAdmission work cancellation', () => {
  it('preserves typed authorize_timeout after real signal-aware work settles', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 100,
      workDeadlineMs: 15,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
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
      .run(req as never, res as never, parser as RequestHandler, work, PRINCIPAL)
      .catch(err => err)

    expect(error).toBeInstanceOf(AuthorizeWorkInterrupted)
    expect((error as AuthorizeWorkInterrupted).code).toBe('authorize_timeout')
    expect(EventEmitter.listenerCount(res, 'close')).toBe(0)
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
  })

  it('does not free a work owner on client close until signal-aware work unwinds', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 1000,
      workDeadlineMs: 5000,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
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
      .run(
        req as never,
        res as never,
        parser as RequestHandler,
        signal =>
          work(signal).catch((err: AuthorizeWorkInterrupted) => {
            workSettled.resolve(err)
            throw err
          }),
        PRINCIPAL
      )
      .catch(error => error)
    await workStarted.promise
    res.emit('close')
    await closeObserved.promise

    expect(gate.tryAcquire(PRINCIPAL)).toBeNull()
    allowWorkUnwind.resolve()
    const error = (await Promise.all([running, workSettled.promise]))[1]
    expect(error.code).toBe('authorize_aborted')
    expect(req.body).toBeUndefined()
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
  })
})

describe('AuthorizeBodyAdmission capacity refusal discard', () => {
  const CLOSE_GRACE_MS = 5
  const READ_DEADLINE_MS = 100
  const REQUEST_EVENTS = ['data', 'end', 'aborted', 'error'] as const
  const STOPPED_MESSAGE = 'authorize capacity refusal closed before the body ended'

  function refusingGate(maxDiscardBodyBytes = 1_048_576) {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: READ_DEADLINE_MS,
      workDeadlineMs: 100,
      closeGraceMs: CLOSE_GRACE_MS,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes,
    })
    const holder = gate.tryAcquire(PRINCIPAL)
    expect(holder).not.toBeNull()
    return { gate, holder: holder! }
  }

  function refusalFixture(headers?: Record<string, string>) {
    const req = fakeRequest()
    if (headers) req.headers = headers
    const requestLogger = fakeRequestLogger()
    req.log = requestLogger.logger
    const res = fakeResponse()
    const parser = vi.fn()
    const work = vi.fn(async () => undefined)
    return { req, res, parser, work, warn: requestLogger.child.warn }
  }

  // Runs a queue_full refusal and checks what every capacity refusal does at
  // once: close-and-retry headers and the refusal log, before any answer.
  async function refuse(gate: AuthorizeBodyAdmission, headers?: Record<string, string>) {
    const fixture = refusalFixture(headers)
    await gate.run(
      fixture.req as never,
      fixture.res as never,
      fixture.parser as RequestHandler,
      fixture.work,
      OTHER_PRINCIPAL
    )
    expect(fixture.res.setHeader).toHaveBeenCalledWith('Connection', 'close')
    expect(fixture.res.setHeader).toHaveBeenCalledWith('Retry-After', '1')
    expect(fixture.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'llm_provider_attempt_admission_refused',
        reason: 'authorize_capacity_exceeded',
        refusal: 'queue_full',
      }),
      'authorize admission refused before body read'
    )
    return fixture
  }

  function discardStoppedLogs(warn: ReturnType<typeof vi.fn>) {
    return warn.mock.calls.filter(
      ([fields]) =>
        (fields as { event?: unknown } | undefined)?.event ===
        'llm_provider_attempt_admission_discard_stopped'
    )
  }

  function finishResponse(res: FakeResponse) {
    res.writableEnded = true
    res.writableFinished = true
    res.emit('finish')
  }

  function expectNothingRetained(fixture: ReturnType<typeof refusalFixture>) {
    expect(fixture.req.body).toBeUndefined()
    expect(fixture.parser).not.toHaveBeenCalled()
    expect(fixture.work).not.toHaveBeenCalled()
  }

  it('answers only after the discarded body ends and does not destroy a fully read request on finish', async () => {
    vi.useFakeTimers()
    try {
      const { gate, holder } = refusingGate()
      const fixture = await refuse(gate)
      const { req, res } = fixture
      expect(req.resume).toHaveBeenCalledOnce()
      expect(req.listenerCount('data')).toBe(1)
      req.emit('data', Buffer.alloc(1024))
      req.emit('data', Buffer.alloc(2048))
      expect(res.status).not.toHaveBeenCalled()
      expect(res.body).toBeUndefined()

      req.emit('end')
      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(res.json).toHaveBeenCalledOnce()
      expectNothingRetained(fixture)
      expect(discardStoppedLogs(fixture.warn)).toEqual([])
      for (const event of REQUEST_EVENTS) expect(req.listenerCount(event)).toBe(0)
      // The refusal took no unit: only the holder is charged.
      expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
      // Only the closeGrace backstop is pending, cleared by finish.
      expect(res.listenerCount('finish')).toBe(1)
      expect(vi.getTimerCount()).toBe(1)

      finishResponse(res)
      res.emit('close')
      expect(res.listenerCount('finish')).toBe(0)
      expect(res.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS * 10)
      expect(req.destroy).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledOnce()

      holder()
      expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('destroys a fully discarded refusal through closeGrace when response finish never arrives', async () => {
    vi.useFakeTimers()
    try {
      const { gate } = refusingGate()
      const fixture = await refuse(gate)
      const { req, res } = fixture
      req.emit('data', Buffer.from('{}'))
      req.emit('end')
      expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS - 1)
      expect(req.destroy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(req.destroy).toHaveBeenCalledOnce()
      expect(res.listenerCount('finish')).toBe(0)
      expect(res.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(discardStoppedLogs(fixture.warn)).toEqual([])
      expectNothingRetained(fixture)
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a body of exactly maxDiscardBodyBytes and answers on end', async () => {
    const { gate } = refusingGate(10)
    const fixture = await refuse(gate)
    fixture.req.emit('data', Buffer.alloc(4))
    fixture.req.emit('data', Buffer.alloc(6))
    expect(fixture.res.body).toBeUndefined()
    fixture.req.emit('end')
    expect(fixture.res.body).toEqual({ error: 'authorize_capacity_exceeded' })
    expect(discardStoppedLogs(fixture.warn)).toEqual([])
    finishResponse(fixture.res)
    expect(fixture.req.destroy).not.toHaveBeenCalled()
  })

  it('answers at once and closes when the discarded bytes exceed maxDiscardBodyBytes', async () => {
    vi.useFakeTimers()
    try {
      const { gate } = refusingGate(10)
      const fixture = await refuse(gate)
      const { req, res } = fixture
      req.emit('data', Buffer.alloc(6))
      expect(res.body).toBeUndefined()
      req.emit('data', Buffer.alloc(5))

      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      // Paused by the refusal and again when the discard stops.
      expect(req.pause).toHaveBeenCalledTimes(2)
      for (const event of REQUEST_EVENTS) expect(req.listenerCount(event)).toBe(0)
      expect(discardStoppedLogs(fixture.warn)).toEqual([
        [
          {
            event: 'llm_provider_attempt_admission_discard_stopped',
            reason: 'discard_limit',
            discardedBytes: 11,
            maxDiscardBodyBytes: 10,
          },
          STOPPED_MESSAGE,
        ],
      ])
      expect(req.destroy).not.toHaveBeenCalled()
      finishResponse(res)
      expect(req.destroy).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      req.emit('data', Buffer.alloc(1))
      req.emit('end')
      expect(res.json).toHaveBeenCalledOnce()
      expectNothingRetained(fixture)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers from headers alone and closes when Content-Length declares more than maxDiscardBodyBytes', async () => {
    vi.useFakeTimers()
    try {
      const { gate } = refusingGate(10)
      const fixture = await refuse(gate, { 'content-length': '11' })
      const { req, res } = fixture
      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(req.resume).not.toHaveBeenCalled()
      for (const event of REQUEST_EVENTS) expect(req.listenerCount(event)).toBe(0)
      expect(discardStoppedLogs(fixture.warn)).toEqual([
        [
          {
            event: 'llm_provider_attempt_admission_discard_stopped',
            reason: 'declared_length',
            discardedBytes: 0,
            maxDiscardBodyBytes: 10,
          },
          STOPPED_MESSAGE,
        ],
      ])
      expect(req.destroy).not.toHaveBeenCalled()
      finishResponse(res)
      expect(req.destroy).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      expectNothingRetained(fixture)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['10', '0x20', '1e3', '11 '])(
    'discards instead of trusting Content-Length %j that is at the cap or not plain digits',
    async declared => {
      const { gate } = refusingGate(10)
      const fixture = await refuse(gate, { 'content-length': declared })
      expect(fixture.req.resume).toHaveBeenCalledOnce()
      expect(fixture.res.body).toBeUndefined()
      fixture.req.emit('end')
      expect(fixture.res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(discardStoppedLogs(fixture.warn)).toEqual([])
      finishResponse(fixture.res)
    }
  )

  it('propagates a synchronous refusal write error on the declared-length path and closes the socket', async () => {
    vi.useFakeTimers()
    try {
      const { gate } = refusingGate(10)
      const fixture = refusalFixture({ 'content-length': '11' })
      const writeError = new Error('refusal write failed')
      fixture.res.json.mockImplementation(() => {
        throw writeError
      })
      await expect(
        gate.run(
          fixture.req as never,
          fixture.res as never,
          fixture.parser as RequestHandler,
          fixture.work,
          OTHER_PRINCIPAL
        )
      ).rejects.toBe(writeError)
      expect(fixture.res.json).toHaveBeenCalledOnce()
      expect(fixture.req.destroy).toHaveBeenCalledOnce()
      expect(discardStoppedLogs(fixture.warn)).toHaveLength(1)
      expect(fixture.res.listenerCount('finish')).toBe(0)
      expect(fixture.res.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expectNothingRetained(fixture)
      expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers at the read deadline and closes when the discarded body never ends', async () => {
    vi.useFakeTimers()
    try {
      const { gate } = refusingGate()
      const fixture = await refuse(gate)
      const { req, res } = fixture
      req.emit('data', Buffer.alloc(3))
      await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1)
      expect(res.status).not.toHaveBeenCalled()
      expect(req.listenerCount('data')).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(req.pause).toHaveBeenCalledTimes(2)
      for (const event of REQUEST_EVENTS) expect(req.listenerCount(event)).toBe(0)
      expect(discardStoppedLogs(fixture.warn)).toEqual([
        [
          {
            event: 'llm_provider_attempt_admission_discard_stopped',
            reason: 'read_deadline',
            discardedBytes: 3,
            maxDiscardBodyBytes: 1_048_576,
          },
          STOPPED_MESSAGE,
        ],
      ])
      expect(req.destroy).not.toHaveBeenCalled()
      finishResponse(res)
      expect(req.destroy).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      req.emit('end')
      expect(res.json).toHaveBeenCalledOnce()
      expectNothingRetained(fixture)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { source: 'request', event: 'aborted' },
    { source: 'request', event: 'error' },
    { source: 'response', event: 'close' },
  ] as const)(
    'destroys the request without answering when the $source emits $event during the discard',
    async ({ source, event }) => {
      vi.useFakeTimers()
      try {
        const { gate } = refusingGate()
        const fixture = await refuse(gate)
        const { req, res } = fixture
        // Liveness: the discard reader is installed and consuming.
        expect(req.resume).toHaveBeenCalledOnce()
        expect(req.listenerCount('data')).toBe(1)
        req.emit('data', Buffer.alloc(4))
        expect(vi.getTimerCount()).toBe(1)

        if (source === 'request') {
          req.emit(event, ...(event === 'error' ? [new Error('client reset')] : []))
        } else {
          res.emit(event)
        }

        expect(req.destroy).toHaveBeenCalledOnce()
        expect(res.status).not.toHaveBeenCalled()
        expect(res.json).not.toHaveBeenCalled()
        expect(discardStoppedLogs(fixture.warn)).toEqual([])
        for (const name of REQUEST_EVENTS) expect(req.listenerCount(name)).toBe(0)
        expect(res.listenerCount('close')).toBe(0)
        expect(res.listenerCount('finish')).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        req.emit('end')
        await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS * 2)
        expect(res.json).not.toHaveBeenCalled()
        expect(req.destroy).toHaveBeenCalledOnce()
        expectNothingRetained(fixture)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})

describe('AuthorizeBodyAdmission HTTP fixture', () => {
  it('preserves chunked JSON and releases after work completes', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 1000,
      workDeadlineMs: 1000,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
    })
    const parser = express.json({ limit: '1kb', inflate: false })
    const work = vi.fn(async (req: express.Request, res: Response, _signal: AbortSignal) => {
      res.status(200).json({ body: req.body })
    })
    const app = express()
    app.post('/test', (req, res, next) => {
      void gate.run(req, res, parser, signal => work(req, res, signal), PRINCIPAL).catch(next)
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
    expect(gate.tryAcquire(PRINCIPAL)).not.toBeNull()
  })

  it('refuses an over-cap request before parsing and keeps a disconnected work owner charged', async () => {
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 1000,
      workDeadlineMs: 5000,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
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
        .run(
          req,
          res,
          parser,
          signal =>
            work(req, res, signal).catch((err: AuthorizeWorkInterrupted) => {
              workSettled.resolve(err)
              throw err
            }),
          PRINCIPAL
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
      expect(refused.headers.toLowerCase()).toMatch(/\r\nretry-after: 1(\r\n|$)/)
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
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 5000,
      workDeadlineMs: 1000,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 1_048_576,
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
      void gate
        .run(req, res, wrappedParser, signal => work(req, res, signal), PRINCIPAL)
        .catch(next)
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

  // A gateway such as nginx writes the whole buffered body before it reads the
  // answer. The refusal must let that write complete and end the connection
  // with FIN; a reset would turn the retryable 503 into a gateway 502.
  it('lets a refused client write its whole large body, then answers 503 with Retry-After and closes with FIN', async () => {
    const BODY_BYTES = 8 * 1024 * 1024
    const CHUNK_BYTES = 64 * 1024
    const gate = new AuthorizeBodyAdmission({
      maxInFlight: 1,
      maxQueued: 0,
      maxPerPrincipal: 2,
      queueWaitMs: 100,
      readDeadlineMs: 10_000,
      workDeadlineMs: 1000,
      closeGraceMs: 10,
      retryAfterSeconds: 1,
      maxDiscardBodyBytes: 16 * 1024 * 1024,
    })
    const holder = gate.tryAcquire(PRINCIPAL)
    expect(holder).not.toBeNull()
    const parser = vi.fn<RequestHandler>()
    const work = vi.fn(async () => undefined)
    const refusedRequests: express.Request[] = []
    const app = express()
    app.post('/test', (req, res, next) => {
      refusedRequests.push(req)
      void gate.run(req, res, parser, work, OTHER_PRINCIPAL).catch(next)
    })

    await withServer(app, async port => {
      const outcome = await sendLargeBody(
        port,
        'POST /test HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${BODY_BYTES}\r\n\r\n`,
        BODY_BYTES,
        CHUNK_BYTES,
        10_000
      )
      expect(outcome.error).toBeUndefined()
      expect(outcome.bytesQueued).toBe(BODY_BYTES)
      expect(outcome.bytesAcknowledged).toBe(BODY_BYTES)
      // The answer only follows the last body byte.
      expect(outcome.bytesQueuedAtFirstResponseByte).toBe(BODY_BYTES)
      expect(outcome.ended).toBe(true)
      expect(outcome.status).toBe(503)
      expect(JSON.parse(outcome.body)).toEqual({ error: 'authorize_capacity_exceeded' })
      expect(outcome.headers.toLowerCase()).toContain('\r\nconnection: close')
      expect(outcome.headers.toLowerCase()).toMatch(/\r\nretry-after: 1(\r\n|$)/)
    })

    expect(refusedRequests).toHaveLength(1)
    expect(refusedRequests[0].body).toBeUndefined()
    expect(parser).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
    expect(gate.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
    holder?.()
    expect(gate.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
  }, 20_000)
})
