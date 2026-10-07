import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { connect as connectTcp } from 'node:net'
import type { GrokLlmProxyConfig } from '../src/config.js'
import {
  VISUAL_PER_HOST_MAX_ADMITTED,
  VISUAL_STREAM_LIMITS,
  visualStreamGate,
} from '../src/requestLimits.js'
import { createProxyApps } from '../src/server.js'

type ObservedRead = {
  req: Request
  res: Response
  nativeSettled: boolean
  returned: boolean
  error: unknown
  finishes: number
  endCalls: number
  suppressedCloseBackstops: number
}

const parserBarrier = vi.hoisted(() => {
  let release!: () => void
  let completion: Promise<void>
  const reads: ObservedRead[] = []
  const reset = () => {
    reads.splice(0)
    completion = new Promise<void>(resolve => {
      release = resolve
    })
  }
  reset()
  return {
    reads,
    reset,
    get completion() {
      return completion
    },
    get settledCount() {
      return reads.filter(read => read.nativeSettled).length
    },
    release() {
      release()
    },
  }
})

vi.mock('express', async () => {
  const actual = await vi.importActual<typeof import('express')>('express')
  const actualDefault = (actual as unknown as { default: typeof express }).default
  const mockedDefault = Object.assign(
    (...args: Parameters<typeof express>) => actualDefault(...args),
    {
      json: (options?: Parameters<typeof actual.json>[0]) => {
        const parser = actualDefault.json(options)
        return (req: Request, res: Response, next: NextFunction) => {
          // Observe the native visual reader. Ordinary JSON parsing stays native
          // too, but must not count as starting the next visual reader.
          const read: ObservedRead | undefined =
            options?.limit === 8192
              ? {
                  req,
                  res,
                  nativeSettled: false,
                  returned: false,
                  error: undefined,
                  finishes: 0,
                  endCalls: 0,
                  suppressedCloseBackstops: 0,
                }
              : undefined
          if (read) {
            parserBarrier.reads.push(read)
            if (req.headers['x-visual-hold-response-close'] === '1') {
              // Controlled fault injection for the direct-release witness:
              // production may not register its response-close backstop, so a
              // released slot can only have come from the route's eager path.
              const originalOnce = res.once.bind(res)
              res.once = ((event: string, listener: (...args: unknown[]) => void) => {
                if (event === 'close') {
                  read.suppressedCloseBackstops += 1
                  return res
                }
                return originalOnce(event, listener as never)
              }) as Response['once']
            }
            res.once('finish', () => {
              read.finishes += 1
            })
            if (req.headers['x-visual-never-finish'] === '1') {
              // Fault injection: no finish/close is produced by writing 408.
              // The production close backstop must independently stop raw-body.
              res.end = (() => {
                read.endCalls += 1
                return res
              }) as Response['end']
            }
          }
          parser(req, res, (err: unknown) => {
            if (read) {
              read.nativeSettled = true
              read.error = err
            }
            const finish = () => {
              next(err)
              if (read) read.returned = true
            }
            if (req.headers['x-visual-parser-hold'] === '1') {
              void parserBarrier.completion.then(finish)
            } else {
              finish()
            }
          })
        }
      },
    }
  )
  return { ...actual, default: mockedDefault, json: mockedDefault.json }
})

const COMPLETIONS_PATH = '/internal/runtime/v1/grok/completions'
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function config(): GrokLlmProxyConfig {
  return {
    runtimePort: 0,
    adminPort: 0,
    probePort: 0,
    maxBodyBytes: 4096,
    maxVisualBodyBytes: 8192,
    maxStreamDurationMs: 1_800_000,
    maxDeadlineMs: 1_800_000,
    upstreamIdleTimeoutMs: 600_000,
    heartbeatIntervalMs: 15_000,
    jwtIssuer: 'control-api',
    jwtPublicKey: publicKey,
    executionEnabled: true,
    controlApiBaseUrl: '',
    controlApiServiceName: 'grok-llm-proxy',
    controlApiServiceToken: '',
  }
}

function platformToken(): string {
  return jwt.sign(
    {
      sub: 'default/research-host',
      hostRefs: ['research-host'],
      workflowControlScopes: ['llm:grok:execute'],
      scope: 'workflow:approval:request',
    },
    privateKey,
    { algorithm: 'RS256', issuer: 'control-api', audience: 'workflow-approvals', expiresIn: 60 }
  )
}

function platformTokenForOtherPrincipal(): string {
  return jwt.sign(
    {
      sub: 'default/other-host',
      hostRefs: ['research-host'],
      workflowControlScopes: ['llm:grok:execute'],
      scope: 'workflow:approval:request',
    },
    privateKey,
    { algorithm: 'RS256', issuer: 'control-api', audience: 'workflow-approvals', expiresIn: 60 }
  )
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(label)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const sockets = new Set<ReturnType<typeof connectTcp>>()

function stalledVisualBody(
  port: number,
  declared: number,
  holdParser = false,
  extraHeaders = '',
  prefix = '{"executionTicket":'
): { socket: ReturnType<typeof connectTcp>; response: Promise<number> } {
  let owner: ReturnType<typeof connectTcp> | undefined
  const response = new Promise<number>((resolve, reject) => {
    owner = connectTcp(port, '127.0.0.1', () => {
      owner?.write(
        `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${platformToken()}\r\n` +
          `Content-Type: application/json\r\n` +
          (holdParser ? 'X-Visual-Parser-Hold: 1\r\n' : '') +
          extraHeaders +
          `Content-Length: ${declared}\r\n` +
          `\r\n` +
          prefix
      )
    })
    sockets.add(owner)
    owner.once('close', () => sockets.delete(owner!))
    owner.setTimeout(5_000, () => {
      owner?.destroy()
      reject(new Error('the stalled visual body produced no response'))
    })
    const chunks: Buffer[] = []
    owner.on('data', data => {
      chunks.push(data)
      const match = /^HTTP\/1\.1 (\d+)/.exec(Buffer.concat(chunks).toString('utf8'))
      if (match) resolve(Number(match[1]))
    })
    owner.on('error', err => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
    })
  })
  return { socket: owner!, response }
}

function invalidTicketBody(): string {
  const content = 'x'.repeat(5000)
  return JSON.stringify({
    executionTicket: 'invalid-ticket',
    requestHash: 'a'.repeat(64),
    request: {
      schemaVersion: 'grok-completion-request.v2',
      requestId: 'req-visual-ownership',
      idempotencyKey: 'idem-visual-ownership',
      provider: 'grok-subscription',
      model: 'grok-4.6',
      messages: [{ role: 'user', content }],
    },
  })
}

function postVisualRaw(
  port: number,
  body: string,
  holdParser = false
): { socket: ReturnType<typeof connectTcp>; response: Promise<number> } {
  let owner: ReturnType<typeof connectTcp> | undefined
  const response = new Promise<number>((resolve, reject) => {
    owner = connectTcp(port, '127.0.0.1', () => {
      owner?.write(
        `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${platformToken()}\r\n` +
          `Content-Type: application/json\r\n` +
          (holdParser ? 'X-Visual-Parser-Hold: 1\r\n' : '') +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `\r\n` +
          body
      )
    })
    sockets.add(owner)
    owner.once('close', () => sockets.delete(owner!))
    owner.setTimeout(5_000, () => {
      owner?.destroy()
      reject(new Error('the visual request produced no response'))
    })
    const chunks: Buffer[] = []
    owner.on('data', data => {
      chunks.push(data)
      const match = /^HTTP\/1\.1 (\d+)/.exec(Buffer.concat(chunks).toString('utf8'))
      if (match) resolve(Number(match[1]))
    })
    owner.on('error', err => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
    })
  })
  return { socket: owner!, response }
}

async function postVisualStatus(port: number, body: string): Promise<number> {
  const request = postVisualRaw(port, body)
  const status = await request.response
  request.socket.destroy()
  return status
}

function openVisualKeepAlive(port: number): {
  send: (body: string) => Promise<number>
  destroy: () => void
} {
  let owner: ReturnType<typeof connectTcp> | undefined
  let wire = ''
  const statusWaiters: Array<(status: number) => void> = []
  owner = connectTcp(port, '127.0.0.1')
  sockets.add(owner)
  owner.once('close', () => sockets.delete(owner!))
  owner.setTimeout(5_000, () => {
    owner?.destroy()
    for (const resolve of statusWaiters.splice(0)) resolve(-1)
  })
  owner.on('data', data => {
    wire += data.toString('utf8')
    for (;;) {
      const match = /HTTP\/1\.1 (\d{3})/.exec(wire)
      if (!match) return
      wire = wire.slice(match.index + match[0].length)
      statusWaiters.shift()?.(Number(match[1]))
    }
  })
  return {
    send(body: string) {
      return new Promise<number>((resolve, reject) => {
        statusWaiters.push(resolve)
        owner?.once('error', reject)
        owner?.write(
          `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Authorization: Bearer ${platformToken()}\r\n` +
            `Content-Type: application/json\r\n` +
            `X-Visual-Hold-Response-Close: 1\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `\r\n${body}`
        )
      })
    },
    destroy: () => owner?.destroy(),
  }
}

describe('grok visual body read ownership', () => {
  const servers: Array<ReturnType<typeof createProxyApps>> = []
  const listeners: Array<ReturnType<typeof createServer>> = []

  beforeEach(() => parserBarrier.reset())

  afterEach(async () => {
    parserBarrier.release()
    vi.restoreAllMocks()
    for (const socket of sockets) socket.destroy()
    await Promise.all(
      listeners
        .splice(0)
        .map(
          listener =>
            new Promise<void>((resolve, reject) =>
              listener.close(err => (err ? reject(err) : resolve()))
            )
        )
    )
    await Promise.all(servers.splice(0).map(server => server.close()))
    await waitFor(
      () => visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
      'the visual gate did not drain after the ownership test'
    )
  })

  it('keeps the visual slot and principal share until the timed-out parser terminates', async () => {
    const apps = createProxyApps(config(), {
      bodyReadDeadlineMs: 200,
      visualReadCloseGraceMs: 10,
    })
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const readers = Array.from({ length: VISUAL_PER_HOST_MAX_ADMITTED }, () =>
      stalledVisualBody(address.port, 5000, true)
    )
    await waitFor(
      () =>
        visualStreamGate.snapshot().running + visualStreamGate.snapshot().queued ===
        VISUAL_PER_HOST_MAX_ADMITTED,
      'the stalled visual bodies did not fill the principal share'
    )
    const statuses = await Promise.all(
      readers.slice(0, VISUAL_STREAM_LIMITS.maxConcurrentStreams).map(reader => reader.response)
    )
    expect(statuses).toEqual(
      Array.from({ length: VISUAL_STREAM_LIMITS.maxConcurrentStreams }, () => 408)
    )
    expect(visualStreamGate.snapshot().running + visualStreamGate.snapshot().queued).toBe(
      VISUAL_PER_HOST_MAX_ADMITTED
    )

    const shareRefusal = await postVisualStatus(address.port, invalidTicketBody())
    expect(shareRefusal).toBe(503)
    // A different principal can queue, but the reader must not start until the
    // existing parser callbacks finish. This observes reader entry, not merely
    // the absence of an HTTP response from the next request.
    const nextSocket = connectTcp(address.port, '127.0.0.1')
    sockets.add(nextSocket)
    nextSocket.once('close', () => sockets.delete(nextSocket))
    const nextStatus = new Promise<number>((resolve, reject) => {
      nextSocket.once('connect', () => {
        const body = invalidTicketBody()
        nextSocket.write(
          `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${address.port}\r\n` +
            `Authorization: Bearer ${platformTokenForOtherPrincipal()}\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
        )
      })
      nextSocket.on('data', data => {
        const match = /^HTTP\/1\.1 (\d+)/.exec(data.toString('utf8'))
        if (match) resolve(Number(match[1]))
      })
      nextSocket.once('error', reject)
    })
    await waitFor(
      () =>
        visualStreamGate.snapshot().queued ===
        VISUAL_PER_HOST_MAX_ADMITTED - VISUAL_STREAM_LIMITS.maxConcurrentStreams + 1,
      'the next principal did not queue behind the retained parsers'
    )
    expect(parserBarrier.reads).toHaveLength(VISUAL_STREAM_LIMITS.maxConcurrentStreams)

    for (const reader of readers) {
      reader.response.catch(() => undefined)
      reader.socket.destroy()
    }
    await waitFor(
      () => parserBarrier.settledCount === VISUAL_STREAM_LIMITS.maxConcurrentStreams,
      'the held parsers did not terminate'
    )
    expect(visualStreamGate.snapshot().running).toBe(VISUAL_STREAM_LIMITS.maxConcurrentStreams)
    expect(visualStreamGate.snapshot().queued).toBeGreaterThanOrEqual(1)
    expect(parserBarrier.reads).toHaveLength(VISUAL_STREAM_LIMITS.maxConcurrentStreams)
    parserBarrier.release()
    expect(await nextStatus).toBe(403)
    nextSocket.destroy()
    await waitFor(
      () => visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
      'the timed-out visual reader did not terminate and release its admission'
    )
    expect(
      parserBarrier.reads
        .slice(0, VISUAL_STREAM_LIMITS.maxConcurrentStreams)
        .every(read => read.returned && read.req.body === undefined)
    ).toBe(true)
  })

  it('uses the close backstop when the visual client disappears before the deadline', async () => {
    const apps = createProxyApps(config(), {
      bodyReadDeadlineMs: 5_000,
      visualReadCloseGraceMs: 10,
    })
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const stalled = stalledVisualBody(address.port, 5000)
    await waitFor(
      () => visualStreamGate.snapshot().running === 1,
      'the visual body did not take the slot'
    )
    stalled.socket.destroy()
    stalled.response.catch(() => undefined)
    await waitFor(
      () => visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
      'a disconnected visual reader retained its admission after the close backstop'
    )
  })

  it('releases the visual admission after a parser error', async () => {
    const apps = createProxyApps(config())
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const status = await postVisualStatus(address.port, `{"executionTicket":${' '.repeat(5000)}`)
    expect(status).toBe(400)
    await waitFor(
      () => visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
      'a malformed visual body did not release its admission'
    )
  })

  it('transfers a successfully parsed visual body to the route and releases it after the response', async () => {
    const apps = createProxyApps(config())
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const status = await postVisualStatus(address.port, invalidTicketBody())
    expect(status).toBe(403)
    await waitFor(
      () => visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
      'a parsed visual body did not release its admission after the route response'
    )
  })

  it('eagerly releases a refused visual body before its response-close backstop', async () => {
    const apps = createProxyApps(config())
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const client = openVisualKeepAlive(address.port)
    const firstResponse = client.send(invalidTicketBody())
    await waitFor(
      () => parserBarrier.reads.length === 1 && parserBarrier.reads[0]!.returned,
      'the first refused visual route did not reach its direct-release path'
    )
    const firstRead = parserBarrier.reads[0]!
    expect(await firstResponse).toBe(403)
    expect(firstRead.nativeSettled).toBe(true)
    expect(firstRead.error).toBeUndefined()
    expect(firstRead.suppressedCloseBackstops).toBe(1)
    expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })

    const secondResponse = client.send(invalidTicketBody())
    expect(await secondResponse).toBe(403)
    await waitFor(
      () => parserBarrier.reads.length === 2 && parserBarrier.reads.every(read => read.returned),
      'the next eligible visual request was not admitted after direct release'
    )
    expect(parserBarrier.reads[1]!.nativeSettled).toBe(true)
    expect(parserBarrier.reads[1]!.error).toBeUndefined()
    expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    client.destroy()
  })

  it('stops the native reader independently when a non-reading peer never finishes the response', async () => {
    const apps = createProxyApps(config(), { bodyReadDeadlineMs: 40, visualReadCloseGraceMs: 15 })
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const stalled = stalledVisualBody(address.port, 5000, false, 'X-Visual-Never-Finish: 1\r\n')
    stalled.response.catch(() => undefined)
    stalled.socket.pause()
    await waitFor(() => parserBarrier.reads.length === 1, 'the native visual reader did not start')
    const read = parserBarrier.reads[0]!
    await waitFor(() => read.returned, 'the independent close backstop did not terminate raw-body')
    expect(read.endCalls).toBe(1)
    expect(read.finishes).toBe(0)
    expect(read.req.destroyed).toBe(true)
    expect(read.req.body).toBeUndefined()
    expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    expect(await postVisualStatus(address.port, invalidTicketBody())).toBe(403)
  })

  it('clears a late successful native parse after its read deadline without dispatching it', async () => {
    const apps = createProxyApps(config(), { bodyReadDeadlineMs: 40, visualReadCloseGraceMs: 1000 })
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const body = invalidTicketBody()
    const split = 128
    const stalled = stalledVisualBody(
      address.port,
      Buffer.byteLength(body),
      false,
      'X-Visual-Never-Finish: 1\r\n',
      body.slice(0, split)
    )
    stalled.response.catch(() => undefined)
    await waitFor(
      () => parserBarrier.reads[0]?.endCalls === 1,
      'the visual reader never reached its deadline'
    )
    const read = parserBarrier.reads[0]!
    expect(read.nativeSettled).toBe(false)
    expect(visualStreamGate.snapshot().running).toBe(1)
    stalled.socket.write(body.slice(split))
    await waitFor(() => read.returned, 'the late native parser callback did not run')
    expect(read.error).toBeUndefined()
    expect(read.req.body).toBeUndefined()
    expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    stalled.socket.destroy()
    expect(await postVisualStatus(address.port, invalidTicketBody())).toBe(403)
  })

  it('clears the retained parsed body after response close before its callback returns', async () => {
    const apps = createProxyApps(config(), { bodyReadDeadlineMs: 5000, visualReadCloseGraceMs: 15 })
    servers.push(apps)
    const listener = createServer(apps.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const request = postVisualRaw(address.port, invalidTicketBody(), true)
    request.response.catch(() => undefined)
    await waitFor(() => parserBarrier.settledCount === 1, 'the complete body was never parsed')
    const read = parserBarrier.reads[0]!
    expect(read.req.body).toBeDefined()
    expect(read.returned).toBe(false)
    request.socket.destroy()
    await waitFor(() => read.res.destroyed, 'the response did not close')
    expect(visualStreamGate.snapshot().running).toBe(1)
    parserBarrier.release()
    await waitFor(() => read.returned, 'the disconnected parser callback did not run')
    expect(read.req.body).toBeUndefined()
    expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    expect(await postVisualStatus(address.port, invalidTicketBody())).toBe(403)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648])(
    'rejects invalid native reader clocks (%s)',
    value => {
      expect(() => createProxyApps(config(), { bodyReadDeadlineMs: value })).toThrow(RangeError)
      expect(() => createProxyApps(config(), { visualReadCloseGraceMs: value })).toThrow(RangeError)
    }
  )
})
