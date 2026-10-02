import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'
import { type IncomingMessage, createServer, request as httpRequest } from 'node:http'
import { LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY } from '../src/middleware/llmProviderAttemptAdmissionLimits.js'
import {
  AuthorizeBodyAdmission,
  AuthorizeWorkInterrupted,
} from '../src/middleware/llmProviderAttemptBodyAdmission.js'
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
  responseWritesAfterClose: number
}

type Reply = { status: number; headers: IncomingMessage['headers']; body: string }

function headers(host: string, provider: 'codex' | 'grok' = 'codex') {
  const issued = issueMcpHostAccessJwt('default', host, [host], {
    workflowControlScopes: [provider === 'codex' ? 'llm:codex:execute' : 'llm:grok:execute'],
  })
  return { Authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }
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
        responseWritesAfterClose: 0,
      }
      observations.push(observed)
      const end = res.end
      res.end = function (...args: Parameters<typeof res.end>) {
        if (this.destroyed) observed.responseWritesAfterClose += 1
        return end.apply(this, args)
      } as typeof res.end
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
      const on = req.on
      req.on = function (event: string, listener: (...args: any[]) => void) {
        if (event === 'data') {
          observed.bodyDataSubscriptions += 1
        }
        return on.call(this, event, listener)
      } as typeof req.on
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

function observeHeldOwner() {
  const settled = deferred()
  const original = AuthorizeBodyAdmission.prototype.run
  const spy = vi.spyOn(AuthorizeBodyAdmission.prototype, 'run').mockImplementation(async function (
    this: AuthorizeBodyAdmission,
    ...args: Parameters<AuthorizeBodyAdmission['run']>
  ) {
    try {
      return await original.apply(this, args)
    } finally {
      if (args[0].headers['x-admission-case'] === 'held') settled.resolve()
    }
  })
  return { settled: settled.promise, spy }
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
          expect(otherApp.observations[0]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
          })
          expect(parse.mock.calls.map(([text]) => text)).not.toContain(rejectedBody)
          expect(authorizer.authorizeLlmProviderAttempt).toHaveBeenCalledOnce()

          // The same refusal must also arrive from headers alone. An owner
          // that first buffers the next body would stall this request.
          const headersOnly = await send(otherApp.url, {
            ...headers('admission-headers-only-host'),
            'content-length': '4096',
          }).response
          expect(headersOnly.status).toBe(503)
          expect(otherApp.observations[1]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
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
          })

          first.client.destroy()
          await abortObserved.promise
          const stillHeld = await send(otherApp.url, headers('admission-third-host'), rejectedBody)
            .response
          expect(stillHeld.status).toBe(503)
          expect(JSON.parse(stillHeld.body)).toEqual({ error: 'authorize_capacity_exceeded' })
          expect(parse.mock.calls.map(([text]) => text)).not.toContain(rejectedBody)
          expect(otherApp.observations[3]).toMatchObject({
            bodyDataSubscriptions: 0,
            readBytesBeforeResponse: 0,
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
      parse.mockRestore()
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
      await withApps(1, async ([app]) => {
        const body = JSON.stringify({
          request: { provider: `${provider}-subscription`, chunked: true },
        })
        const sent = send(app.url, {
          ...headers(`chunked-${provider}-host`, provider),
          'transfer-encoding': 'chunked',
        })
        sent.client.write(body.slice(0, 20))
        sent.client.end(body.slice(20))
        const response = await sent.response
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
        const next = await send(app.url, headers(`next-${provider}-host`, provider), '{}').response
        expect(next.status).toBe(200)
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

  it('returns terminal authorize_timeout after the real work clock aborts, without publishing late success', async () => {
    const started = deferred()
    const abortObserved = deferred<AbortSignal>()
    const nativeSetTimeout = globalThis.setTimeout
    // Only shorten the owner clock for this socket fixture. The production
    // policy remains unchanged; this test makes no numeric safety claim.
    const clock = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn, ms, ...args) =>
        nativeSetTimeout(
          fn,
          ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.workDeadlineMs ? 40 : ms,
          ...args
        )) as typeof setTimeout)
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
        // Deliberately produce a late result: the route must check the signal
        // immediately before publishing an execution ticket.
        return SUCCESS
      }
    )
    try {
      await withApps(1, async ([app]) => {
        const sent = send(app.url, headers('work-timeout-host'), '{}')
        const outcome = sent.response
        await started.promise
        const signal = await abortObserved.promise
        expect(signal.reason).toBeInstanceOf(AuthorizeWorkInterrupted)
        expect(signal.reason.code).toBe('authorize_timeout')
        const response = await outcome
        expect(response.status).toBe(503)
        expect(JSON.parse(response.body)).toEqual({ error: 'authorize_timeout' })
        expect((app.observations[0].request as Request).body).toBeUndefined()
        const recovered = await send(app.url, headers('after-timeout-host'), '{}').response
        expect(recovered.status).toBe(200)
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('stops a stalled body reader on the real read clock before releasing and admits the next request', async () => {
    const owner = observeHeldOwner()
    const nativeSetTimeout = globalThis.setTimeout
    // Contracted clocks are explicit HTTP fixture timing, not runtime policy.
    const clock = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn, ms, ...args) =>
        nativeSetTimeout(
          fn,
          ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.readDeadlineMs
            ? 40
            : ms === LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY.closeGraceMs
              ? 10
              : ms,
          ...args
        )) as typeof setTimeout)
    try {
      await withApps(1, async ([app]) => {
        const sent = send(app.url, {
          ...headers('read-timeout-host'),
          'content-length': '128',
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
