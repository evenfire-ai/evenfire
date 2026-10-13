import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Request } from 'express'
import { type IncomingMessage, createServer, request as httpRequest } from 'node:http'
import net from 'node:net'
import { LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY } from '../src/middleware/llmProviderAttemptAdmissionLimits.js'
import {
  AuthorizeBodyAdmission,
  AuthorizeWorkInterrupted,
} from '../src/middleware/llmProviderAttemptBodyAdmission.js'
import {
  AUTHORIZE_TEXT_BODY_BYTES,
  selectAuthorizeBudget,
} from '../src/routes/mcp-host/llmProviderAttempts.routes.js'
import * as authorizer from '../src/services/llmProviderAttemptAuthorizer.js'
import * as rateLimiter from '../src/services/rateLimiterService.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return { ...actual, config: { ...actual.config, jsonBodyLimit: '1mb' } }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: vi.fn() },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/observability/metrics.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/metrics.js')>()
  return { ...actual, rateLimitHitsTotal: { inc: vi.fn() } }
})

vi.mock('../src/services/llmProviderAttemptAuthorizer.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/llmProviderAttemptAuthorizer.js')>()
  return { ...actual, authorizeLlmProviderAttempt: vi.fn() }
})

const AUTHORIZE_PATH = '/api/v1/mcp-host/llm/provider-attempts/authorize'
// Synthetic ticket content is only an authorizer response fixture. No ticket
// creation, grant lookup, budget reservation or provider dispatch is mocked as
// successful by these HTTP ownership tests.
const SUCCESS = {
  providerAttemptId: '33333333-3333-4333-8333-333333333333',
  requestHash: 'a'.repeat(64),
  executionTicket: 'unit-test-execution-ticket',
  expiresAt: '2026-10-02T12:00:00.000Z',
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

type Observation = {
  request: IncomingMessage
  bodyDataSubscriptions: number
  readBytesBeforeResponse: number
  // Every body byte delivered to a data listener before the response ended,
  // whether through read() or emitted directly to a flowing stream.
  dataBytesBeforeResponse: number
  responseWritesAfterClose: number
}

type Reply = { status: number; headers: IncomingMessage['headers']; body: string }

function textHeaders(host: string, provider: 'codex' | 'grok' = 'codex'): Record<string, string> {
  const issued = issueMcpHostAccessJwt('default', host, [host], {
    workflowControlScopes: [provider === 'codex' ? 'llm:codex:execute' : 'llm:grok:execute'],
  })
  return { Authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }
}

// The retained-ownership cases compete for the retained-body unit. A small
// body with a declared length takes the uncharged ordinary path, so these
// requests are sent chunked, which selectAuthorizeBudget charges.
function headers(host: string, provider: 'codex' | 'grok' = 'codex'): Record<string, string> {
  return { ...textHeaders(host, provider), 'transfer-encoding': 'chunked' }
}

// Headers-only retained requests declare a length just above the text
// envelope, the smallest declared length that takes the unit.
function declaredRetainedHeaders(
  host: string,
  provider: 'codex' | 'grok' = 'codex'
): Record<string, string> {
  return { ...textHeaders(host, provider), 'content-length': String(AUTHORIZE_TEXT_BODY_BYTES + 1) }
}

// A capacity refusal discards the body before it answers, except for a
// declared length above the discard cap, which it answers from headers alone.
function overDiscardCapHeaders(host: string): Record<string, string> {
  return {
    ...textHeaders(host),
    'content-length': String(LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.maxDiscardBodyBytes + 1),
  }
}

function send(url: string, requestHeaders: Record<string, string>, body?: string) {
  let client!: ReturnType<typeof httpRequest>
  const response = new Promise<Reply>((resolve, reject) => {
    client = httpRequest(url, { method: 'POST', headers: requestHeaders }, res => {
      const chunks: string[] = []
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks.join('') })
      )
    })
    client.on('error', reject)
    client.setTimeout(5_000, () => client.destroy(new Error('HTTP ownership fixture deadline')))
    if (body === undefined) client.flushHeaders()
    else client.end(body)
  })
  return { client, response }
}

async function withApps(
  count: number,
  run: (apps: Array<{ url: string; observations: Observation[] }>) => Promise<void>
) {
  const { createApp } = await import('../src/app.js')
  const servers = Array.from({ length: count }, () => {
    const observations: Observation[] = []
    const app = createApp(new MockGateway() as never)
    const listener = createServer((req, res) => {
      const observed: Observation = {
        request: req,
        bodyDataSubscriptions: 0,
        readBytesBeforeResponse: 0,
        dataBytesBeforeResponse: 0,
        responseWritesAfterClose: 0,
      }
      observations.push(observed)
      const end = res.end
      vi.spyOn(res, 'end').mockImplementation(function (
        this: typeof res,
        ...args: Parameters<typeof res.end>
      ) {
        if (this.destroyed) observed.responseWritesAfterClose += 1
        return end.apply(this, args)
      })
      // Observe read calls and listener installation without adding a data
      // listener or switching the IncomingMessage into flowing mode.
      const read = req.read
      req.read = function (size?: number) {
        const value = read.call(this, size)
        // Node may drain already buffered bytes after response handoff. That
        // native _dump is separate from admitting an application body reader.
        if (Buffer.isBuffer(value) && !res.writableEnded)
          observed.readBytesBeforeResponse += value.length
        return value
      }
      // A flowing stream can emit a chunk without calling read(), so data
      // delivery is counted at emit.
      const emit = req.emit
      req.emit = function (this: typeof req, event: string | symbol, ...args: unknown[]) {
        const [chunk] = args
        if (event === 'data' && !res.writableEnded) {
          observed.dataBytesBeforeResponse += Buffer.isBuffer(chunk)
            ? chunk.length
            : Buffer.byteLength(String(chunk))
        }
        return emit.call(this, event, ...args)
      } as typeof req.emit
      const on = req.on
      vi.spyOn(req, 'on').mockImplementation(function (
        this: typeof req,
        ...[event, listener]: Parameters<typeof req.on>
      ) {
        if (event === 'data') {
          observed.bodyDataSubscriptions += 1
        }
        return on.call(this, event, listener)
      })
      app(req, res)
    }).listen(0)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    return { listener, url: `http://127.0.0.1:${address.port}${AUTHORIZE_PATH}`, observations }
  })
  try {
    await run(servers)
  } finally {
    await Promise.all(
      servers.map(
        ({ listener }) =>
          new Promise<void>((resolve, reject) => {
            listener.closeAllConnections()
            listener.close(err => (err ? reject(err) : resolve()))
          })
      )
    )
  }
}

// The production queue wait outlives a healthy holder (read plus work
// deadline). Cases that observe a queued request being refused shorten only
// that timer, so the refusal arrives within the fixture deadline.
function shortenQueueWait() {
  const nativeSetTimeout = globalThis.setTimeout
  return vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((fn, ms, ...args) =>
      nativeSetTimeout(
        fn,
        ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.queueWaitMs ? 40 : ms,
        ...args
      )
    )
}

function observeHeldOwner() {
  const settled = deferred()
  let admission: AuthorizeBodyAdmission | undefined
  const original = AuthorizeBodyAdmission.prototype.run
  const spy = vi.spyOn(AuthorizeBodyAdmission.prototype, 'run').mockImplementation(async function (
    this: AuthorizeBodyAdmission,
    ...args: Parameters<AuthorizeBodyAdmission['run']>
  ) {
    admission = this
    try {
      return await original.apply(this, args)
    } finally {
      if (args[0].headers['x-admission-case'] === 'held') settled.resolve()
    }
  })
  return {
    settled: settled.promise,
    spy,
    get admission() {
      return admission
    },
  }
}

beforeEach(() => {
  vi.mocked(authorizer.authorizeLlmProviderAttempt).mockReset().mockResolvedValue(SUCCESS)
  vi.mocked(rateLimiter.checkAndIncrement)
    .mockReset()
    .mockResolvedValue({
      allowed: true,
      backendAvailable: true,
      remaining: 59,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })
})

describe('createApp retained authorize-body ownership', () => {
  it('shares the actual production cap across apps and principals and retains disconnected work until unwind', async () => {
    const started = deferred()
    const abortObserved = deferred()
    const permitUnwind = deferred()
    const owner = observeHeldOwner()
    const parse = vi.spyOn(JSON, 'parse')
    const clock = shortenQueueWait()
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
      async (_claims, _body, deps) => {
        started.resolve()
        deps?.signal?.addEventListener('abort', () => abortObserved.resolve(), { once: true })
        await permitUnwind.promise
        deps?.signal?.throwIfAborted()
        return SUCCESS
      }
    )
    try {
      await withApps(2, async ([firstApp, otherApp]) => {
        const first = send(
          firstApp.url,
          { ...headers('admission-first-host'), 'x-admission-case': 'held' },
          '{"held":true}'
        )
        const firstOutcome = first.response.catch(error => error)
        try {
          await started.promise
          const rejectedBody = '{"mustNotParse":true}'
          const blocked = await send(
            otherApp.url,
            {
              ...headers('admission-other-host', 'grok'),
            },
            rejectedBody
          ).response
          expect(blocked.status).toBe(503)
          expect(JSON.parse(blocked.body)).toEqual({ error: 'authorize_capacity_exceeded' })
          expect(blocked.headers.connection).toBe('close')
          expect(blocked.headers['retry-after']).toBe(
            String(LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.retryAfterSeconds)
          )
          // The refusal discards the whole body (one counting listener) before
          // it answers; nothing reaches JSON.parse or the authorizer.
          expect(otherApp.observations[0]).toMatchObject({
            bodyDataSubscriptions: 1,
            dataBytesBeforeResponse: Buffer.byteLength(rejectedBody),
          })
          expect(parse.mock.calls.map(([text]) => text)).not.toContain(rejectedBody)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()

          // A declared body above the discard cap is refused from headers
          // alone. An owner that first read that body would stall this request.
          const headersOnly = await send(
            otherApp.url,
            overDiscardCapHeaders('admission-headers-only-host')
          ).response
          expect(headersOnly.status).toBe(503)
          expect(JSON.parse(headersOnly.body)).toEqual({ error: 'authorize_capacity_exceeded' })
          expect(headersOnly.headers.connection).toBe('close')
          expect(otherApp.observations[1]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
            dataBytesBeforeResponse: 0,
          })

          const malformed = '{unauthenticated while full'
          const unauthenticated = await send(
            otherApp.url,
            { 'content-type': 'application/json' },
            malformed
          ).response
          expect(unauthenticated.status).toBe(401)
          expect(parse.mock.calls.map(([text]) => text)).not.toContain(malformed)
          expect(otherApp.observations[2]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
            dataBytesBeforeResponse: 0,
          })

          first.client.destroy()
          await abortObserved.promise
          const stillHeld = await send(otherApp.url, headers('admission-third-host'), rejectedBody)
            .response
          expect(stillHeld.status).toBe(503)
          expect(JSON.parse(stillHeld.body)).toEqual({ error: 'authorize_capacity_exceeded' })
          expect(parse.mock.calls.map(([text]) => text)).not.toContain(rejectedBody)
          expect(otherApp.observations[3]).toMatchObject({
            bodyDataSubscriptions: 1,
            dataBytesBeforeResponse: Buffer.byteLength(rejectedBody),
          })
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()

          permitUnwind.resolve()
          await owner.settled
          expect((firstApp.observations[0].request as Request).body).toBeUndefined()
          const recovered = await send(
            otherApp.url,
            headers('admission-other-host', 'grok'),
            '{"recovered":true}'
          ).response
          expect(recovered.status).toBe(200)
          expect(JSON.parse(recovered.body)).toEqual(SUCCESS)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
          expect(firstApp.observations[0].responseWritesAfterClose).toBe(0)
        } finally {
          first.client.destroy()
          permitUnwind.resolve()
          await firstOutcome
        }
      })
    } finally {
      clock.mockRestore()
      parse.mockRestore()
      owner.spy.mockRestore()
    }
  })

  for (const provider of ['codex', 'grok'] as const) {
    it(`queues a healthy overlapping chunked ${provider} request across apps before any read and executes it once`, async () => {
      const started = deferred()
      const permitUnwind = deferred()
      const owner = observeHeldOwner()
      vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
        async (_claims, _body, deps) => {
          started.resolve()
          await permitUnwind.promise
          deps?.signal?.throwIfAborted()
          return SUCCESS
        }
      )
      try {
        await withApps(2, async ([firstApp, otherApp]) => {
          const first = send(
            firstApp.url,
            { ...headers(`healthy-first-${provider}-host`), 'x-admission-case': 'held' },
            '{"first":true}'
          )
          const firstOutcome = first.response.catch(error => error)
          const queuedBody = {
            hostRef: `healthy-queued-${provider}-host`,
            request: { provider: `${provider}-subscription` },
          }
          let queued: ReturnType<typeof send> | undefined
          let queuedOutcome: Promise<Reply | Error> | undefined
          try {
            await started.promise
            queued = send(otherApp.url, {
              ...headers(`healthy-queued-${provider}-host`, provider),
              'transfer-encoding': 'chunked',
            })
            queuedOutcome = queued.response.catch(error => error)
            const encoded = JSON.stringify(queuedBody)
            queued.client.write(encoded.slice(0, 12))
            queued.client.end(encoded.slice(12))
            await vi.waitFor(() =>
              expect(owner.admission?.snapshot()).toMatchObject({ inFlight: 1, queued: 1 })
            )
            expect(otherApp.observations[0]).toMatchObject({
              bodyDataSubscriptions: 0,
              readBytesBeforeResponse: 0,
            })
            expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()

            permitUnwind.resolve()
            const replies = await Promise.all([firstOutcome, queuedOutcome])
            expect(replies).toEqual([
              expect.objectContaining({ status: 200 }),
              expect.objectContaining({ status: 200 }),
            ])
            expect(JSON.parse((replies[1] as Reply).body)).toEqual(SUCCESS)
            expect(otherApp.observations[0].bodyDataSubscriptions).toBe(1)
            expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
            expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenNthCalledWith(
              2,
              expect.objectContaining({ hostRefs: [`healthy-queued-${provider}-host`] }),
              queuedBody,
              expect.objectContaining({ signal: expect.any(AbortSignal) })
            )
            expect((otherApp.observations[0].request as Request).body).toBeUndefined()
            expect(owner.admission?.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
          } finally {
            permitUnwind.resolve()
            first.client.destroy()
            queued?.client.destroy()
            await Promise.all([firstOutcome, queuedOutcome])
          }
        })
      } finally {
        owner.spy.mockRestore()
      }
    })
  }

  it('uses the verified JWT share across providers and ignores a different body host before parsing', async () => {
    const started = deferred()
    const permitUnwind = deferred()
    const owner = observeHeldOwner()
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
      async (_claims, _body, deps) => {
        started.resolve()
        await permitUnwind.promise
        deps?.signal?.throwIfAborted()
        return SUCCESS
      }
    )
    try {
      await withApps(1, async ([app]) => {
        const first = send(
          app.url,
          { ...headers('verified-share-host'), 'x-admission-case': 'held' },
          '{}'
        )
        const firstOutcome = first.response.catch(error => error)
        let queued: ReturnType<typeof send> | undefined
        let queuedOutcome: Promise<Reply | Error> | undefined
        let rejected: ReturnType<typeof send> | undefined
        let rejectedOutcome: Promise<Reply | Error> | undefined
        try {
          await started.promise
          queued = send(
            app.url,
            headers('verified-share-host', 'grok'),
            '{"hostRef":"forged-second-host","request":{"provider":"grok-subscription"}}'
          )
          queuedOutcome = queued.response.catch(error => error)
          await vi.waitFor(() =>
            expect(owner.admission?.snapshot()).toMatchObject({
              inFlight: 1,
              queued: 1,
              principals: 1,
            })
          )
          const rejectedBody = '{"hostRef":"forged-third-host"}'
          rejected = send(app.url, headers('verified-share-host'), rejectedBody)
          rejectedOutcome = rejected.response.catch(error => error)
          await vi.waitFor(() => expect(owner.spy).toHaveBeenCalledTimes(3))
          expect(owner.admission?.snapshot()).toEqual({ inFlight: 1, queued: 1, principals: 1 })
          const refused = (await rejectedOutcome) as Reply
          expect(refused.status).toBe(503)
          expect(JSON.parse(refused.body)).toEqual({ error: 'authorize_capacity_exceeded' })
          // The queued request is still paused and unread; the refused one was
          // discarded to its end by one counting listener and never parsed.
          expect(app.observations[1]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
            dataBytesBeforeResponse: 0,
          })
          expect(app.observations[2]).toMatchObject({
            bodyDataSubscriptions: 1,
            dataBytesBeforeResponse: Buffer.byteLength(rejectedBody),
          })
          expect((app.observations[2].request as Request).body).toBeUndefined()
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()

          permitUnwind.resolve()
          expect(await firstOutcome).toMatchObject({ status: 200 })
          expect(await queuedOutcome).toMatchObject({ status: 200 })
          const recovered = await send(app.url, headers('verified-share-host'), '{}').response
          expect(recovered.status).toBe(200)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(3)
          expect(owner.admission?.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
        } finally {
          permitUnwind.resolve()
          first.client.destroy()
          queued?.client.destroy()
          rejected?.client.destroy()
          await Promise.all([firstOutcome, queuedOutcome, rejectedOutcome])
        }
      })
    } finally {
      owner.spy.mockRestore()
    }
  })

  it('removes a queued disconnect without parsing and returns that share for a later healthy overlap', async () => {
    const started = deferred()
    const permitUnwind = deferred()
    const owner = observeHeldOwner()
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
      async (_claims, _body, deps) => {
        started.resolve()
        await permitUnwind.promise
        deps?.signal?.throwIfAborted()
        return SUCCESS
      }
    )
    try {
      await withApps(1, async ([app]) => {
        const first = send(
          app.url,
          { ...headers('queued-disconnect-holder'), 'x-admission-case': 'held' },
          '{}'
        )
        const firstOutcome = first.response.catch(error => error)
        let cancelled: ReturnType<typeof send> | undefined
        let cancelledOutcome: Promise<Reply | Error> | undefined
        let recovered: ReturnType<typeof send> | undefined
        let recoveredOutcome: Promise<Reply | Error> | undefined
        try {
          await started.promise
          cancelled = send(app.url, headers('queued-disconnect-host'), '{"cancelled":true}')
          cancelledOutcome = cancelled.response.catch(error => error)
          await vi.waitFor(() =>
            expect(owner.admission?.snapshot()).toMatchObject({ inFlight: 1, queued: 1 })
          )
          cancelled.client.destroy()
          await cancelledOutcome
          await vi.waitFor(() =>
            expect(owner.admission?.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
          )
          expect(app.observations[1]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
          })
          expect(app.observations[1].request.destroyed).toBe(true)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()
          recovered = send(app.url, headers('queued-disconnect-host'), '{"recovered":true}')
          recoveredOutcome = recovered.response.catch(error => error)
          await vi.waitFor(() =>
            expect(owner.admission?.snapshot()).toMatchObject({ inFlight: 1, queued: 1 })
          )
          permitUnwind.resolve()
          expect(await firstOutcome).toMatchObject({ status: 200 })
          expect(await recoveredOutcome).toMatchObject({ status: 200 })
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
          expect(owner.admission?.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
        } finally {
          permitUnwind.resolve()
          first.client.destroy()
          cancelled?.client.destroy()
          recovered?.client.destroy()
          await Promise.all([firstOutcome, cancelledOutcome, recoveredOutcome])
        }
      })
    } finally {
      owner.spy.mockRestore()
    }
  })

  it('expires queued headers without parsing them, refuses them at the discard read deadline and preserves terminal local saturation followed by recovery', async () => {
    const started = deferred()
    const permitUnwind = deferred()
    const owner = observeHeldOwner()
    const nativeSetTimeout = globalThis.setTimeout
    // Shortens the queue wait, and only the first read deadline installed by
    // the queue expiry (the refusal's discard deadline), so the holder and the
    // recovery request keep the production read clock. Fired timers are counted.
    let queueExpirations = 0
    let shortenNextReadDeadline = false
    let discardDeadlinesFired = 0
    const clock = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      const callback = fn as (...callbackArgs: unknown[]) => void
      if (ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.queueWaitMs) {
        return nativeSetTimeout(
          (...callbackArgs: unknown[]) => {
            queueExpirations += 1
            shortenNextReadDeadline = true
            callback(...callbackArgs)
            shortenNextReadDeadline = false
          },
          40,
          ...args
        )
      }
      if (shortenNextReadDeadline && ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.readDeadlineMs) {
        shortenNextReadDeadline = false
        return nativeSetTimeout(
          (...callbackArgs: unknown[]) => {
            discardDeadlinesFired += 1
            callback(...callbackArgs)
          },
          80,
          ...args
        )
      }
      return nativeSetTimeout(fn, ms, ...args)
    })
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
      async (_claims, _body, deps) => {
        started.resolve()
        await permitUnwind.promise
        deps?.signal?.throwIfAborted()
        return SUCCESS
      }
    )
    try {
      await withApps(1, async ([app]) => {
        const first = send(
          app.url,
          { ...headers('queued-expiry-holder'), 'x-admission-case': 'held' },
          '{}'
        )
        const firstOutcome = first.response.catch(error => error)
        try {
          await started.promise
          // Headers only: the queue expires, the refusal waits for a body that
          // never comes and answers when its read deadline fires.
          const expired = await send(app.url, declaredRetainedHeaders('queued-expiry-host'))
            .response
          expect(queueExpirations).toBe(1)
          expect(discardDeadlinesFired).toBe(1)
          expect(expired.status).toBe(503)
          expect(JSON.parse(expired.body)).toEqual({ error: 'authorize_capacity_exceeded' })
          expect(expired.headers.connection).toBe('close')
          expect(expired.headers['retry-after']).toBe('10')
          expect(app.observations[1]).toMatchObject({
            bodyDataSubscriptions: 1,
            readBytesBeforeResponse: 0,
            dataBytesBeforeResponse: 0,
          })
          expect((app.observations[1].request as Request).body).toBeUndefined()
          await vi.waitFor(() => expect(app.observations[1].request.destroyed).toBe(true))
          expect(owner.admission?.snapshot()).toEqual({ inFlight: 1, queued: 0, principals: 1 })
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()
          permitUnwind.resolve()
          expect(await firstOutcome).toMatchObject({ status: 200 })
          const recovered = await send(app.url, headers('queued-expiry-host'), '{}').response
          expect(recovered.status).toBe(200)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
        } finally {
          permitUnwind.resolve()
          first.client.destroy()
          await firstOutcome
        }
      })
    } finally {
      clock.mockRestore()
      owner.spy.mockRestore()
    }
  })

  it('keeps a queued reader paused after active disconnect until physical work unwind and then completes it once', async () => {
    const started = deferred()
    const abortObserved = deferred()
    const permitUnwind = deferred()
    const owner = observeHeldOwner()
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
      async (_claims, _body, deps) => {
        started.resolve()
        deps?.signal?.addEventListener('abort', () => abortObserved.resolve(), { once: true })
        await permitUnwind.promise
        deps?.signal?.throwIfAborted()
        return SUCCESS
      }
    )
    try {
      await withApps(2, async ([firstApp, otherApp]) => {
        const first = send(
          firstApp.url,
          { ...headers('active-disconnect-holder'), 'x-admission-case': 'held' },
          '{}'
        )
        const firstOutcome = first.response.catch(error => error)
        let queued: ReturnType<typeof send> | undefined
        let queuedOutcome: Promise<Reply | Error> | undefined
        try {
          await started.promise
          queued = send(
            otherApp.url,
            headers('active-disconnect-queued-host', 'grok'),
            '{"queued":true}'
          )
          queuedOutcome = queued.response.catch(error => error)
          await vi.waitFor(() =>
            expect(owner.admission?.snapshot()).toMatchObject({ inFlight: 1, queued: 1 })
          )
          first.client.destroy()
          await abortObserved.promise
          expect(otherApp.observations[0]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
          })
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()
          expect(owner.admission?.snapshot()).toEqual({ inFlight: 1, queued: 1, principals: 2 })
          permitUnwind.resolve()
          await owner.settled
          expect(await queuedOutcome).toMatchObject({ status: 200 })
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
          expect(firstApp.observations[0].responseWritesAfterClose).toBe(0)
          expect(owner.admission?.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
        } finally {
          permitUnwind.resolve()
          first.client.destroy()
          queued?.client.destroy()
          await Promise.all([firstOutcome, queuedOutcome])
        }
      })
    } finally {
      owner.spy.mockRestore()
    }
  })

  it('runs both rate limits and JWT before taking any body owner', async () => {
    const acquire = vi.spyOn(AuthorizeBodyAdmission.prototype, 'tryAcquire')
    try {
      await withApps(1, async ([app]) => {
        const invalid = await send(app.url, { 'content-type': 'application/json' }, '{malformed')
          .response
        expect(invalid.status).toBe(401)
        expect(acquire).not.toHaveBeenCalled()
        expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
        expect(app.observations[0]).toMatchObject({
          bodyDataSubscriptions: 0,
          readBytesBeforeResponse: 0,
        })

        vi.mocked(rateLimiter.checkAndIncrement).mockResolvedValueOnce({
          allowed: false,
          backendAvailable: true,
          remaining: 0,
          resetMs: Date.now() + 60_000,
          windowStartMs: Date.now(),
          count: 61,
        })
        const rateDenied = await send(app.url, headers('rate-denied-host'), '{malformed').response
        expect(rateDenied.status).toBe(429)
        expect(acquire).not.toHaveBeenCalled()
        expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
        expect(app.observations[1]).toMatchObject({
          bodyDataSubscriptions: 0,
          readBytesBeforeResponse: 0,
        })

        const recovered = await send(app.url, headers('rate-recovered-host'), '{}').response
        expect(recovered.status).toBe(200)
        expect(acquire).toHaveBeenCalledOnce()
      })
    } finally {
      acquire.mockRestore()
    }
  })

  for (const provider of ['codex', 'grok'] as const) {
    it(`preserves chunked ${provider} JSON through the actual app and releases the body`, async () => {
      const clock = shortenQueueWait()
      onTestFinished(() => clock.mockRestore())
      await withApps(1, async ([app]) => {
        const body = JSON.stringify({
          request: { provider: `${provider}-subscription`, chunked: true },
        })
        const workStarted = deferred()
        const permitUnwind = deferred()
        vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
          async (_claims, _body, deps) => {
            workStarted.resolve()
            await permitUnwind.promise
            deps?.signal?.throwIfAborted()
            return SUCCESS
          }
        )
        const sent = send(app.url, {
          ...headers(`chunked-${provider}-host`, provider),
          'x-admission-case': 'held',
          'transfer-encoding': 'chunked',
        })
        const firstOutcome = sent.response.catch(error => error)
        sent.client.write(body.slice(0, 20))
        sent.client.end(body.slice(20))
        try {
          await workStarted.promise
          expect(app.observations[0]).toMatchObject({ bodyDataSubscriptions: 1 })

          const refused = await send(
            app.url,
            headers(`chunked-refused-${provider}-host`, provider),
            '{}'
          ).response
          expect(refused.status).toBe(503)
          expect(JSON.parse(refused.body)).toEqual({ error: 'authorize_capacity_exceeded' })
          // Discarded to its end by one counting listener, never parsed.
          expect(app.observations[1]).toMatchObject({
            bodyDataSubscriptions: 1,
            dataBytesBeforeResponse: 2,
          })
          expect((app.observations[1].request as Request).body).toBeUndefined()
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()

          permitUnwind.resolve()
          const response = await firstOutcome
          expect(response.status).toBe(200)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ hostRefs: [`chunked-${provider}-host`] }),
            JSON.parse(body),
            expect.objectContaining({
              signal: expect.any(AbortSignal),
              resolveAssignment: expect.any(Function),
            })
          )
          expect((app.observations[0].request as Request).body).toBeUndefined()
          const next = await send(app.url, headers(`next-${provider}-host`, provider), '{}')
            .response
          expect(next.status).toBe(200)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
        } finally {
          sent.client.destroy()
          permitUnwind.resolve()
          await firstOutcome
        }
      })
    })
  }

  for (const [name, error, status, code] of [
    [
      'authorize denial',
      new authorizer.LlmProviderAttemptAuthorizeError('budget_denied', 'fixture budget refusal'),
      403,
      'budget_denied',
    ],
    ['unexpected authorizer error', new Error('fixture authorizer failure'), 500, undefined],
  ] as const) {
    it(`releases after ${name} and admits a subsequent request`, async () => {
      vi.mocked(authorizer.authorizeLlmProviderAttempt).mockRejectedValueOnce(error)
      await withApps(1, async ([app]) => {
        const response = await send(app.url, headers(`error-${status}-host`), '{}').response
        expect(response.status).toBe(status)
        if (code) expect(JSON.parse(response.body)).toEqual({ error: code })
        expect((app.observations[0].request as Request).body).toBeUndefined()
        const next = await send(app.url, headers(`recovered-${status}-host`), '{}').response
        expect(next.status).toBe(200)
        expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
      })
    })
  }

  // The work clock's abort reaches the authorizer. A rejection means nothing
  // was committed and is answered as authorize_timeout; a resolution means the
  // transaction committed, so its result is answered (review 5426789128).
  function shortenWorkClock() {
    const nativeSetTimeout = globalThis.setTimeout
    // Only shorten the owner clock for this socket fixture. The production
    // policy remains unchanged; this test makes no numeric safety claim.
    return vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn, ms, ...args) =>
        nativeSetTimeout(
          fn,
          ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.workDeadlineMs ? 40 : ms,
          ...args
        )
      )
  }
  function authorizeAfterAbort(outcome: 'reject' | 'resolve') {
    const started = deferred()
    const abortObserved = deferred<AbortSignal>()
    const settled = deferred()
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(
      async (_claims, _body, deps) => {
        const signal = deps?.signal
        if (!signal) throw new Error('authorize work did not receive its owner signal')
        started.resolve()
        await new Promise<void>(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              abortObserved.resolve(signal)
              resolve()
            },
            { once: true }
          )
        )
        settled.resolve()
        if (outcome === 'reject') signal.throwIfAborted()
        return SUCCESS
      }
    )
    return { started, abortObserved, settled }
  }

  it('returns terminal authorize_timeout when the real work clock aborts an uncommitted authorize', async () => {
    const clock = shortenWorkClock()
    const { started, abortObserved } = authorizeAfterAbort('reject')
    try {
      await withApps(1, async ([app]) => {
        const outcome = send(app.url, headers('work-timeout-host'), '{}').response
        await started.promise
        const signal = await abortObserved.promise
        expect(signal.reason).toBeInstanceOf(AuthorizeWorkInterrupted)
        expect(signal.reason.code).toBe('authorize_timeout')
        const response = await outcome
        expect(response.status).toBe(503)
        expect(JSON.parse(response.body)).toEqual({ error: 'authorize_timeout' })
        // Work may have run: only a capacity refusal invites a retry.
        expect(response.headers['retry-after']).toBeUndefined()
        expect((app.observations[0].request as Request).body).toBeUndefined()
        const recovered = await send(app.url, headers('after-timeout-host'), '{}').response
        expect(recovered.status).toBe(200)
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('answers a committed authorize with 200 after the real work clock aborted', async () => {
    const clock = shortenWorkClock()
    const { started, abortObserved } = authorizeAfterAbort('resolve')
    try {
      await withApps(1, async ([app]) => {
        const outcome = send(app.url, headers('late-commit-host'), '{}').response
        await started.promise
        const signal = await abortObserved.promise
        expect(signal.reason).toBeInstanceOf(AuthorizeWorkInterrupted)
        expect(signal.reason.code).toBe('authorize_timeout')
        const response = await outcome
        expect(response.status).toBe(200)
        expect(JSON.parse(response.body)).toEqual(SUCCESS)
        expect((app.observations[0].request as Request).body).toBeUndefined()
        const recovered = await send(app.url, headers('after-late-commit-host'), '{}').response
        expect(recovered.status).toBe(200)
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('writes nothing for a committed authorize whose client already disconnected', async () => {
    const { started, abortObserved, settled } = authorizeAfterAbort('resolve')
    await withApps(1, async ([app]) => {
      const sent = send(app.url, headers('late-commit-gone-host'), '{}')
      const outcome = sent.response.catch(error => error)
      await started.promise
      sent.client.destroy()
      const signal = await abortObserved.promise
      expect(signal.reason).toBeInstanceOf(AuthorizeWorkInterrupted)
      expect(signal.reason.code).toBe('authorize_aborted')
      // Witness: the authorizer resolved its committed result after the abort.
      await settled.promise
      await outcome
      await vi.waitFor(() => expect(app.observations[0].request.destroyed).toBe(true))
      const recovered = await send(app.url, headers('after-late-commit-gone-host'), '{}').response
      expect(recovered.status).toBe(200)
      expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledTimes(2)
      expect(app.observations[0].responseWritesAfterClose).toBe(0)
    })
  })

  it('stops a stalled body reader on the real read clock before releasing and admits the next request', async () => {
    const owner = observeHeldOwner()
    const nativeSetTimeout = globalThis.setTimeout
    // Contracted clocks are explicit HTTP fixture timing, not runtime policy.
    const clock = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn, ms, ...args) =>
        nativeSetTimeout(
          fn,
          ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.readDeadlineMs
            ? 40
            : ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.closeGraceMs
              ? 10
              : ms,
          ...args
        )
      )
    try {
      await withApps(1, async ([app]) => {
        const sent = send(app.url, {
          ...declaredRetainedHeaders('read-timeout-host'),
          'x-admission-case': 'held',
        })
        const response = await sent.response
        expect(response.status).toBe(408)
        expect(JSON.parse(response.body)).toEqual({ error: 'request_timeout' })
        expect(response.headers.connection).toBe('close')
        await owner.settled
        expect(app.observations[0].request.destroyed).toBe(true)
        expect((app.observations[0].request as Request).body).toBeUndefined()
        expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
        const next = await send(app.url, headers('after-read-timeout-host'), '{}').response
        expect(next.status).toBe(200)
      })
    } finally {
      clock.mockRestore()
      owner.spy.mockRestore()
    }
  })
})

describe('Host and Recipe assignment owner cancellation', () => {
  for (const hostRef of ['assignment-host', 'default/assignment-recipe']) {
    it(`passes the same signal to ${hostRef.includes('/') ? 'Recipe' : 'Host'} lookup and preserves cancellation`, async () => {
      const { resolveHostAssignedAssignment } =
        await import('../src/routes/mcp-host/llmProviderAttempts.routes.js')
      const controller = new AbortController()
      const interruption = new AuthorizeWorkInterrupted('authorize_timeout')
      const getResource = vi.fn(async (_plural, _name, _namespace, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal)
        controller.abort(interruption)
        throw new Error('fixture lookup unwound after cancellation')
      })
      await expect(
        resolveHostAssignedAssignment({ getResource } as never, hostRef, controller.signal)
      ).rejects.toBe(interruption)
      expect(getResource).toHaveBeenCalledOnce()
      await expect(
        resolveHostAssignedAssignment({ getResource } as never, hostRef, controller.signal)
      ).rejects.toBe(interruption)
      expect(getResource).toHaveBeenCalledOnce()
    })
  }
})

describe('createApp declared-length authorize budget', () => {
  it('pins the text envelope to each contract text budget plus its envelope allowance', () => {
    expect(AUTHORIZE_TEXT_BODY_BYTES).toBe(8_388_608 + 16_384)
  })

  it.each([
    ['no body headers', {}, 'ordinary'],
    ['zero declared length', { 'content-length': '0' }, 'ordinary'],
    ['declared length at the text envelope', { 'content-length': '8404992' }, 'ordinary'],
    ['declared length one byte above the envelope', { 'content-length': '8404993' }, 'retained'],
    ['declared visual length', { 'content-length': String(35 * 1024 * 1024) }, 'retained'],
    ['chunked body', { 'transfer-encoding': 'chunked' }, 'retained'],
    [
      'chunked body with a small declared length',
      { 'transfer-encoding': 'chunked', 'content-length': '2' },
      'retained',
    ],
    ['non-numeric declared length', { 'content-length': '12abc' }, 'retained'],
    ['negative declared length', { 'content-length': '-1' }, 'retained'],
    ['empty declared length', { 'content-length': '' }, 'retained'],
  ] as const)('selects the %s budget', (_name, requestHeaders, expected) => {
    expect(selectAuthorizeBudget(requestHeaders)).toBe(expected)
  })

  function observeAdmission() {
    let admission: AuthorizeBodyAdmission | undefined
    const charged = vi.fn()
    const uncharged = vi.fn()
    const run = AuthorizeBodyAdmission.prototype.run
    const runUncharged = AuthorizeBodyAdmission.prototype.runUncharged
    const runSpy = vi.spyOn(AuthorizeBodyAdmission.prototype, 'run').mockImplementation(function (
      this: AuthorizeBodyAdmission,
      ...args: Parameters<AuthorizeBodyAdmission['run']>
    ) {
      admission = this
      charged(args[0].headers['x-admission-case'])
      return run.apply(this, args)
    })
    const unchargedSpy = vi
      .spyOn(AuthorizeBodyAdmission.prototype, 'runUncharged')
      .mockImplementation(function (
        this: AuthorizeBodyAdmission,
        ...args: Parameters<AuthorizeBodyAdmission['runUncharged']>
      ) {
        admission = this
        uncharged(args[0].headers['x-admission-case'])
        return runUncharged.apply(this, args)
      })
    onTestFinished(() => {
      runSpy.mockRestore()
      unchargedSpy.mockRestore()
    })
    return {
      charged,
      uncharged,
      get admission() {
        if (!admission) throw new Error('no admission observed')
        return admission
      },
    }
  }

  it('authorizes a text request from another Host while a declared visual body stalls the unit', async () => {
    const observed = observeAdmission()
    const textBody = '{"text":"hi"}'
    let inFlightDuringText: number | undefined
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(async claims => {
      inFlightDuringText = observed.admission.snapshot().inFlight
      expect(claims.hostRefs).toEqual(['text-host'])
      return SUCCESS
    })
    await withApps(2, async ([visualApp, textApp]) => {
      // Headers only: the declared body never arrives, so this request holds
      // the retained unit inside its read deadline.
      const stalled = send(visualApp.url, {
        ...declaredRetainedHeaders('stalled-visual-host'),
        'x-admission-case': 'stalled',
      })
      const stalledOutcome = stalled.response.catch(error => error)
      try {
        await vi.waitFor(() => expect(observed.charged).toHaveBeenCalledWith('stalled'))
        await vi.waitFor(() => expect(observed.admission.snapshot().inFlight).toBe(1))

        const text = await send(
          textApp.url,
          { ...textHeaders('text-host'), 'x-admission-case': 'text' },
          textBody
        ).response
        expect(text.status).toBe(200)
        expect(JSON.parse(text.body)).toEqual(SUCCESS)
        expect(observed.uncharged).toHaveBeenCalledWith('text')
        expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()
        expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledWith(
          expect.objectContaining({ hostRefs: ['text-host'] }),
          JSON.parse(textBody),
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        )
        // The stalled visual request still holds the only unit.
        expect(inFlightDuringText).toBe(1)
        expect(observed.admission.snapshot().inFlight).toBe(1)
      } finally {
        stalled.client.destroy()
        await stalledOutcome
      }
      await vi.waitFor(() => expect(observed.admission.snapshot().inFlight).toBe(0))
    })
  })

  it('never charges a text request while its authorize work is running', async () => {
    const observed = observeAdmission()
    const workStarted = deferred()
    const permitWork = deferred()
    let snapshotDuringWork: ReturnType<AuthorizeBodyAdmission['snapshot']> | undefined
    vi.mocked(authorizer.authorizeLlmProviderAttempt).mockImplementationOnce(async () => {
      snapshotDuringWork = observed.admission.snapshot()
      workStarted.resolve()
      await permitWork.promise
      return SUCCESS
    })
    await withApps(1, async ([app]) => {
      const sent = send(app.url, textHeaders('uncharged-host'), '{"text":"uncharged"}')
      await workStarted.promise
      expect(app.observations[0].bodyDataSubscriptions).toBe(1)
      expect(snapshotDuringWork).toEqual({ inFlight: 0, queued: 0, principals: 0 })
      expect(observed.uncharged).toHaveBeenCalledOnce()
      expect(observed.charged).not.toHaveBeenCalled()
      permitWork.resolve()
      expect((await sent.response).status).toBe(200)
    })
  })

  it('reads only the declared bytes of a lying text request', async () => {
    const observed = observeAdmission()
    await withApps(1, async ([app]) => {
      const { port, pathname } = new URL(app.url)
      // Content-Length covers only an incomplete JSON prefix. The bytes after
      // it are a complete pipelined request, so Node frames them as a second
      // request instead of failing the connection, and the first response is
      // the route's own answer to the 13 declared bytes.
      const declared = '{"a":"bbbbbbb'
      const surplus = [
        `GET ${pathname} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: close',
        '',
        '',
      ].join('\r\n')
      const requestHeaders = textHeaders('lying-length-host')
      const socket = net.connect(Number(port), '127.0.0.1')
      const chunks: Buffer[] = []
      const ended = new Promise<string>((resolve, reject) => {
        socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
        socket.on('error', reject)
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      socket.write(
        [
          `POST ${pathname} HTTP/1.1`,
          'Host: 127.0.0.1',
          `Authorization: ${requestHeaders.Authorization}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(declared)}`,
          '',
          declared + surplus,
        ].join('\r\n')
      )
      const raw = await ended
      expect(Buffer.byteLength(declared)).toBe(13)
      const statuses = [...raw.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map(match => Number(match[1]))
      // The route refuses the 13-byte prefix; the surplus GET carries no JWT.
      expect(statuses).toEqual([400, 401])
      const [first, second] = raw.split(/(?=HTTP\/1\.1 401 )/)
      expect(first).toContain('{"error":"invalid_request"}')
      expect(second).toContain('{"error":"Unauthorized"}')
      expect(observed.uncharged).toHaveBeenCalledOnce()
      expect(observed.charged).not.toHaveBeenCalled()
      expect(authorizer.authorizeLlmProviderAttempt).not.toHaveBeenCalled()
      expect(observed.admission.snapshot()).toEqual({ inFlight: 0, queued: 0, principals: 0 })
    })
  })
})
