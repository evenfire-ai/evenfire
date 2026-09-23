/**
 * #731 R3-2 - body admission before `express.json`.
 *
 * At an 8 MiB request cap, the stream gate alone would let 24 bodies in (8
 * running plus 16 queued). Three bodies in flight already peaked at 230-292 MiB
 * of RSS, so 24 would not fit the proxy's 768Mi limit by that ratio (not
 * measured at 24). These tests drive the real runtime app over HTTP and use
 * the control-api `redeem` call as the witness: it runs only after the whole
 * body was read, JSON-parsed, contract-parsed and hash-checked, so the number
 * of attempts held there is the number of bodies in memory.
 */
import { describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import {
  LIMITS,
  hashGrokCompletionRequestV1,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import type { GrokLlmProxyConfig } from '../src/config.js'
import type {
  ControlApiClient,
  FinalizeAttemptSuccess,
  RedeemAttemptSuccess,
} from '../src/controlApiClient.js'
import { logger } from '../src/logger.js'
import { GROK_CATALOG_ORIGIN, GROK_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import {
  BODY_READ_DEADLINE_MS,
  DEFAULT_MAX_BODY_BYTES,
  // The admission budget holds this many bodies of the configured maximum size.
  IN_FLIGHT_BODY_BUDGET_BODIES as BUDGET_BODIES,
  STREAM_LIMITS,
  streamGate,
} from '../src/requestLimits.js'
import { type ProxyRuntimeDeps, createProxyApps } from '../src/server.js'

/** Captured before any test fakes the clock, so waits stay on real time. */
const realSetTimeout = globalThis.setTimeout

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const HOST_REF = 'research-host'
const COMPLETIONS_PATH = '/internal/runtime/v1/grok/completions'

function sign(payload: Record<string, unknown>, audience: string, expiresIn = 60): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience,
    expiresIn,
  })
}

function config(maxBodyBytes: number): GrokLlmProxyConfig {
  return {
    runtimePort: 0,
    adminPort: 0,
    probePort: 0,
    maxBodyBytes,
    maxStreamDurationMs: 60_000,
    maxDeadlineMs: 60_000,
    upstreamIdleTimeoutMs: 600_000,
    heartbeatIntervalMs: 15_000,
    jwtIssuer: 'control-api',
    jwtPublicKey: publicKey,
    executionEnabled: true,
    controlApiBaseUrl: 'http://control-api.invalid/api/v1',
    controlApiServiceName: 'grok-llm-proxy',
    controlApiServiceToken: 'unused',
  }
}

const platformToken = sign(
  {
    sub: `default/${HOST_REF}`,
    hostRefs: [HOST_REF],
    workflowControlScopes: ['llm:grok:execute'],
    scope: 'workflow:approval:request',
  },
  'workflow-approvals'
)

/**
 * A runtime envelope whose request carries one user message of `contentChars`.
 * The execution ticket lives `ticketLifetimeSeconds`.
 */
function completionBody(contentChars: number, attempt: string, ticketLifetimeSeconds = 60): string {
  const raw = {
    schemaVersion: 'grok-completion-request.v1',
    requestId: `req-${attempt}`,
    idempotencyKey: `idem-${attempt}`,
    provider: 'grok-subscription',
    model: 'grok-4.6',
    messages: [{ role: 'user', content: 'x'.repeat(contentChars) }],
  }
  const parsed = parseGrokCompletionRequestV1(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  const requestHash = hashGrokCompletionRequestV1(parsed.value)
  return JSON.stringify({
    executionTicket: sign(
      {
        jti: randomUUID(),
        typ: 'grok-execution-ticket',
        hostRef: HOST_REF,
        model: 'grok-4.6',
        requestHash,
        providerAttemptId: `att-${attempt}`,
      },
      'grok-llm-proxy',
      ticketLifetimeSeconds
    ),
    requestHash,
    request: raw,
  })
}

const adminPermit = sign(
  { sub: 'admin-1', typ: 'grok-admin-permit', operation: 'catalog_list' },
  'grok-llm-proxy-admin'
)

/**
 * A proxy whose `redeem` holds every attempt until `releaseAll`, so an attempt
 * that reached it keeps its parsed body in memory. `hold` holds again.
 */
async function heldProxy(maxBodyBytes: number, deps: Pick<ProxyRuntimeDeps, 'bodyReadDeadlineMs'> = {}) {
  let redeemed = 0
  let holding = true
  const held: Array<() => void> = []
  const client = {
    async redeem(): Promise<RedeemAttemptSuccess> {
      redeemed += 1
      if (holding) await new Promise<void>(resolve => held.push(resolve))
      return {
        accessToken: 'test-access-admission',
        transport: {
          protocolVersion: 'grok-subscription-transport.v1',
          completionsOrigin: GROK_COMPLETIONS_ORIGIN,
          catalogOrigin: GROK_CATALOG_ORIGIN,
          operation: 'completion_stream',
          servedModel: 'grok-4.6',
          maxStreamDurationMs: 60_000,
        },
        expiryClass: 'short_lived',
        attemptReceipt: 'b'.repeat(64),
      }
    },
    async finalize(input: {
      receipt: { providerAttemptId: string; outcome: FinalizeAttemptSuccess['outcome'] }
    }): Promise<FinalizeAttemptSuccess> {
      return {
        providerAttemptId: input.receipt.providerAttemptId,
        outcome: input.receipt.outcome,
        duplicate: false,
      }
    },
  } as unknown as ControlApiClient
  const fetchFn = (async () =>
    new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch

  const servers = createProxyApps(config(maxBodyBytes), {
    controlApiClient: client,
    fetchFn,
    lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    ...deps,
  })
  await new Promise<void>(resolve => servers.runtime.listen(0, '127.0.0.1', () => resolve()))
  await new Promise<void>(resolve => servers.admin.listen(0, '127.0.0.1', () => resolve()))
  const { port } = servers.runtime.address() as AddressInfo
  const { port: adminPort } = servers.admin.address() as AddressInfo
  let arrived = 0
  servers.runtime.on('request', () => {
    arrived += 1
  })
  return {
    port,
    adminPort,
    redeemed: () => redeemed,
    /** Requests whose headers the runtime listener has received. */
    arrived: () => arrived,
    hold: () => {
      holding = true
    },
    releaseAll: () => {
      holding = false
      for (const resolve of held.splice(0)) resolve()
    },
    close: () => servers.close(),
  }
}

type Reply = { status: number; body: string }

/** POST with a declared Content-Length, or with a chunked body of undeclared length. */
function post(port: number, payload: string, options: { chunked?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: COMPLETIONS_PATH,
        agent: false,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${platformToken}`,
          ...(options.chunked
            ? { 'transfer-encoding': 'chunked' }
            : { 'content-length': Buffer.byteLength(payload) }),
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

/** Waits until `read()` is positive and stops changing for one poll interval. */
async function settle(read: () => number): Promise<number> {
  const deadline = Date.now() + 20_000
  let last = -1
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const now = read()
    if (now > 0 && now === last) return now
    last = now
  }
  throw new Error(`count did not settle within 20s (last ${last})`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => realSetTimeout(resolve, ms))
}

type TimedReply = Reply & { elapsedMs: number }

/** The reply, or status 0 when none arrived within `ms` of real time. */
function within(reply: Promise<TimedReply>, ms: number): Promise<TimedReply> {
  return Promise.race([
    reply,
    sleep(ms).then(() => ({ status: 0, body: `no reply within ${ms} ms`, elapsedMs: ms })),
  ])
}

/**
 * A POST that declares `declaredBytes`, sends only `sent` and then stalls.
 * `finish` sends the rest of the body; `destroy` closes the client socket so
 * the listener can shut down.
 */
function stalledPost(
  port: number,
  options: { declaredBytes: number; token?: string; path?: string; sent?: string }
): { reply: Promise<TimedReply>; finish: (rest: string) => void; destroy: () => void } {
  const started = Date.now()
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: options.path ?? COMPLETIONS_PATH,
    agent: false,
    headers: {
      'content-type': 'application/json',
      'content-length': options.declaredBytes,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
  })
  const reply = new Promise<TimedReply>((resolve, reject) => {
    req.on('response', res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          elapsedMs: Date.now() - started,
        })
      )
      res.on('error', reject)
    })
    req.on('error', reject)
  })
  req.write(options.sent ?? '{')
  return { reply, finish: rest => req.end(rest), destroy: () => req.destroy() }
}

describe('grok-llm-proxy body admission (#731 R3-2)', () => {
  it('T-R3-2a-grok holds at most three near-cap bodies at once and admits the rest as they finish', async () => {
    const proxy = await heldProxy(DEFAULT_MAX_BODY_BYTES)
    try {
      const contentChars = Math.floor(LIMITS.maxRequestBodyBytes * 0.9)
      const payloads = Array.from({ length: 6 }, (_, i) => completionBody(contentChars, `cap-${i}`))
      const payloadBytes = Buffer.byteLength(payloads[0]!)
      // Fixture check: three bodies fit the budget and a fourth does not.
      expect(BUDGET_BODIES * payloadBytes).toBeLessThanOrEqual(
        BUDGET_BODIES * DEFAULT_MAX_BODY_BYTES
      )
      expect((BUDGET_BODIES + 1) * payloadBytes).toBeGreaterThan(
        BUDGET_BODIES * DEFAULT_MAX_BODY_BYTES
      )

      const replies = payloads.map(payload => post(proxy.port, payload))
      expect(await settle(proxy.redeemed)).toBe(BUDGET_BODIES)

      // Liveness: the three that waited are admitted once the first finish.
      proxy.releaseAll()
      const settled = await Promise.all(replies)
      expect(settled.map(reply => reply.status)).toEqual([200, 200, 200, 200, 200, 200])
      for (const reply of settled) expect(reply.body).toContain('"outcome":"success"')
      expect(proxy.redeemed()).toBe(6)
    } finally {
      proxy.releaseAll()
      await proxy.close()
    }
  }, 60_000)

  it('T-R3-2b-grok refuses a body of undeclared length with 411 before reading it', async () => {
    const proxy = await heldProxy(DEFAULT_MAX_BODY_BYTES)
    proxy.releaseAll()
    try {
      const refused = await post(proxy.port, completionBody(64, 'chunked'), { chunked: true })
      expect(refused.status).toBe(411)
      expect(JSON.parse(refused.body)).toEqual({ error: 'length_required' })
      expect(proxy.redeemed()).toBe(0)

      // Witness: the same request with a declared length is served.
      const served = await post(proxy.port, completionBody(64, 'declared'))
      expect(served.status).toBe(200)
      expect(proxy.redeemed()).toBe(1)
    } finally {
      await proxy.close()
    }
  }, 30_000)

  it('T-R3-2c-grok answers provider_unavailable once the admission queue is full', async () => {
    // A small body limit keeps this cheap; the budget scales with it.
    const maxBodyBytes = 16 * 1024
    const proxy = await heldProxy(maxBodyBytes)
    try {
      const payload = (attempt: string) => completionBody(12_000, attempt)
      const payloadBytes = Buffer.byteLength(payload('probe'))
      expect(payloadBytes).toBeLessThanOrEqual(maxBodyBytes)
      expect((BUDGET_BODIES + 1) * payloadBytes).toBeGreaterThan(BUDGET_BODIES * maxBodyBytes)

      const waiting = Array.from({ length: BUDGET_BODIES + STREAM_LIMITS.maxQueuedRequests }, (_, i) =>
        post(proxy.port, payload(`queued-${i}`))
      )
      expect(await settle(proxy.redeemed)).toBe(BUDGET_BODIES)

      const overflow = await post(proxy.port, payload('overflow'))
      expect(overflow.status).toBe(503)
      expect(JSON.parse(overflow.body)).toEqual({ error: 'provider_unavailable' })

      // Liveness: every queued request is still served once the budget frees.
      proxy.releaseAll()
      const settled = await Promise.all(waiting)
      expect(settled.every(reply => reply.status === 200)).toBe(true)
      expect(proxy.redeemed()).toBe(BUDGET_BODIES + STREAM_LIMITS.maxQueuedRequests)
    } finally {
      proxy.releaseAll()
      await proxy.close()
    }
  }, 60_000)

  it('T-R9-2-grok drops a queued body whose client left, so the whole budget is free once the holders finish', async () => {
    // A small body limit keeps this cheap; the budget scales with it. The read
    // deadline is the production one (10 s), and every check below completes
    // well inside it, so the deadline cannot reclaim a leaked reservation first.
    const maxBodyBytes = 16 * 1024
    const fillingBody = (attempt: string) => completionBody(12_000, attempt)
    const proxy = await heldProxy(maxBodyBytes)
    const holders = Array.from({ length: BUDGET_BODIES }, (_, i) =>
      post(proxy.port, fillingBody(`holder-${i}`))
    )
    const refill: Array<Promise<Reply>> = []
    const body = fillingBody('abandoned')
    let abandoned: ReturnType<typeof stalledPost> | undefined
    try {
      const payloadBytes = Buffer.byteLength(body)
      expect(payloadBytes).toBeLessThanOrEqual(maxBodyBytes)
      expect((BUDGET_BODIES + 1) * payloadBytes).toBeGreaterThan(BUDGET_BODIES * maxBodyBytes)
      expect(await settle(proxy.redeemed)).toBe(BUDGET_BODIES)

      // The holders fill the budget, so this body waits in the admission queue.
      abandoned = stalledPost(proxy.port, {
        declaredBytes: payloadBytes,
        token: platformToken,
        sent: body.slice(0, 1),
      })
      while (proxy.arrived() < BUDGET_BODIES + 1) await sleep(10)
      await sleep(50)
      abandoned.destroy()
      await expect(abandoned.reply).rejects.toThrow('socket hang up')
      await sleep(50)

      proxy.releaseAll()
      for (const reply of await Promise.all(holders)) expect(reply.status).toBe(200)

      // Every reservation is back: bodies that fill the whole budget are all
      // read and redeemed at once. A reservation granted to the departed
      // waiter would leave the last of them queued until the read deadline.
      proxy.hold()
      for (let i = 0; i < BUDGET_BODIES; i += 1) refill.push(post(proxy.port, fillingBody(`refill-${i}`)))
      expect(await settle(proxy.redeemed)).toBe(2 * BUDGET_BODIES)
      proxy.releaseAll()
      for (const reply of await Promise.all(refill)) {
        expect(reply.status).toBe(200)
        expect(reply.body).toContain('"outcome":"success"')
      }
    } finally {
      abandoned?.destroy()
      proxy.releaseAll()
      await Promise.allSettled([...holders, ...refill])
      await proxy.close()
    }
  }, 30_000)
})

/**
 * R9-M-B — a stalled body must not hold the budget. The platform JWT is
 * checked before a reservation is taken, and a reserved body that is not read
 * within the read deadline is answered 408 and releases its reservation.
 */
describe('grok-llm-proxy authentication before admission and body-read deadline (R9-M-B)', () => {
  // A small body limit keeps these cheap; the budget scales with it.
  const maxBodyBytes = 16 * 1024
  const fillingBody = (attempt: string) => completionBody(12_000, attempt)

  it('T-MB-0-grok fixes the production body-read deadline at 10 000 ms', () => {
    expect(BODY_READ_DEADLINE_MS).toBe(10_000)
  })

  it('T-MB-1-grok answers anonymous stalled bodies 401 within 1 s without reserving the budget', async () => {
    const proxy = await heldProxy(maxBodyBytes)
    const anonymous = Array.from({ length: BUDGET_BODIES }, () =>
      stalledPost(proxy.port, { declaredBytes: maxBodyBytes })
    )
    const filling: Array<Promise<Reply>> = []
    try {
      for (const reply of await Promise.all(anonymous.map(s => within(s.reply, 1_000)))) {
        expect(reply.status).toBe(401)
        expect(JSON.parse(reply.body)).toEqual({ error: 'Unauthorized' })
      }
      // Zero bytes reserved: authenticated bodies that fill the whole budget
      // are all read and redeemed at once.
      const payloadBytes = Buffer.byteLength(fillingBody('probe'))
      expect(payloadBytes).toBeLessThanOrEqual(maxBodyBytes)
      for (let i = 0; i < BUDGET_BODIES; i += 1) filling.push(post(proxy.port, fillingBody(`fill-${i}`)))
      expect(await settle(proxy.redeemed)).toBe(BUDGET_BODIES)
      proxy.releaseAll()
      for (const reply of await Promise.all(filling)) expect(reply.status).toBe(200)
    } finally {
      for (const s of anonymous) s.destroy()
      proxy.releaseAll()
      await Promise.allSettled(filling)
      await proxy.close()
    }
  }, 30_000)

  it('T-MB-1-admin-grok answers anonymous stalled admin bodies 401 within 1 s without reserving the shared budget', async () => {
    const deadlineMs = 1_000
    const proxy = await heldProxy(maxBodyBytes, { bodyReadDeadlineMs: deadlineMs })
    const modelsPath = '/internal/admin/v1/grok/models'
    const anonymous = Array.from({ length: BUDGET_BODIES }, () =>
      stalledPost(proxy.adminPort, { declaredBytes: maxBodyBytes, path: modelsPath })
    )
    const permitted = stalledPost(proxy.adminPort, {
      declaredBytes: maxBodyBytes,
      path: modelsPath,
      token: adminPermit,
    })
    const filling: Array<Promise<Reply>> = []
    try {
      for (const reply of await Promise.all(anonymous.map(s => within(s.reply, 1_000)))) {
        expect(reply.status).toBe(401)
        expect(JSON.parse(reply.body)).toEqual({ error: 'Unauthorized' })
      }
      // Witness: a valid admin permit passes the gate and is then bounded by
      // the read deadline, not refused by the gate.
      const held = await within(permitted.reply, deadlineMs + 1_000)
      expect(held.status).toBe(408)
      expect(JSON.parse(held.body)).toEqual({ error: 'request_timeout' })
      // The budget is shared with the runtime listener, and all of it is free.
      for (let i = 0; i < BUDGET_BODIES; i += 1) filling.push(post(proxy.port, fillingBody(`fill-${i}`)))
      expect(await settle(proxy.redeemed)).toBe(BUDGET_BODIES)
      proxy.releaseAll()
      for (const reply of await Promise.all(filling)) expect(reply.status).toBe(200)
    } finally {
      for (const s of [...anonymous, permitted]) s.destroy()
      proxy.releaseAll()
      await Promise.allSettled(filling)
      await proxy.close()
    }
  }, 30_000)

  it('T-MB-2-grok answers an authenticated stalled body 408 request_timeout at the deadline and frees its reservation', async () => {
    const deadlineMs = 1_000
    const warn = vi.spyOn(logger, 'warn')
    const error = vi.spyOn(logger, 'error')
    const proxy = await heldProxy(maxBodyBytes, { bodyReadDeadlineMs: deadlineMs })
    proxy.releaseAll()
    const stalled = Array.from({ length: BUDGET_BODIES }, () =>
      stalledPost(proxy.port, { declaredBytes: maxBodyBytes, token: platformToken })
    )
    const refill: Array<Promise<Reply>> = []
    try {
      while (proxy.arrived() < BUDGET_BODIES) await sleep(10)
      await sleep(50)
      // The stalled bodies hold the whole budget, so this one waits in the queue.
      const queued = post(proxy.port, fillingBody('queued'))

      for (const reply of await Promise.all(stalled.map(s => within(s.reply, deadlineMs + 1_000)))) {
        expect(reply.status).toBe(408)
        expect(JSON.parse(reply.body)).toEqual({ error: 'request_timeout' })
        expect(reply.elapsedMs).toBeGreaterThanOrEqual(deadlineMs)
        expect(reply.elapsedMs).toBeLessThan(deadlineMs + 1_000)
      }
      // Witness: the queued request is admitted once the reservations are freed.
      const served = await queued
      expect(served.status).toBe(200)
      expect(served.body).toContain('"outcome":"success"')
      expect(proxy.redeemed()).toBe(1)
      expect(warn).toHaveBeenCalledWith(
        { event: 'grok_proxy_denied', code: 'request_timeout' },
        'request denied'
      )
      expect(error).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'grok_proxy_error' }),
        expect.anything()
      )

      // The budget is back to zero: bodies that fill all of it are admitted at once.
      proxy.hold()
      for (let i = 0; i < BUDGET_BODIES; i += 1) refill.push(post(proxy.port, fillingBody(`refill-${i}`)))
      expect(await settle(proxy.redeemed)).toBe(1 + BUDGET_BODIES)
      proxy.releaseAll()
      for (const reply of await Promise.all(refill)) expect(reply.status).toBe(200)
    } finally {
      for (const s of stalled) s.destroy()
      proxy.releaseAll()
      await Promise.allSettled(refill)
      await proxy.close()
      warn.mockRestore()
      error.mockRestore()
    }
  }, 30_000)

  it('T-MB-2d-grok arms BODY_READ_DEADLINE_MS when no deadline is injected', async () => {
    const proxy = await heldProxy(maxBodyBytes)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stalled = stalledPost(proxy.port, { declaredBytes: maxBodyBytes, token: platformToken })
    try {
      while (proxy.arrived() < 1) await sleep(10)
      await sleep(50)
      vi.advanceTimersByTime(BODY_READ_DEADLINE_MS - 1)
      expect((await within(stalled.reply, 200)).status).toBe(0)
      vi.advanceTimersByTime(1)
      const reply = await within(stalled.reply, 2_000)
      expect(reply.status).toBe(408)
      expect(JSON.parse(reply.body)).toEqual({ error: 'request_timeout' })
    } finally {
      vi.useRealTimers()
      stalled.destroy()
      await proxy.close()
    }
  }, 30_000)

  it('T-MB-3-grok starts the deadline at grant, so a body queued past it is still served', async () => {
    const deadlineMs = 500
    const proxy = await heldProxy(maxBodyBytes, { bodyReadDeadlineMs: deadlineMs })
    const holders = Array.from({ length: BUDGET_BODIES }, (_, i) =>
      post(proxy.port, fillingBody(`holder-${i}`))
    )
    // The queued body sends one byte and holds the rest until half a deadline
    // after the budget frees, so it can only be served if the clock started at
    // grant. A fully buffered body would be parsed before any timer fired.
    const body = fillingBody('queued')
    let queued: ReturnType<typeof stalledPost> | undefined
    try {
      expect(await settle(proxy.redeemed)).toBe(BUDGET_BODIES)
      queued = stalledPost(proxy.port, {
        declaredBytes: Buffer.byteLength(body),
        token: platformToken,
        sent: body.slice(0, 1),
      })
      await sleep(3 * deadlineMs)
      // Witness: the body really waited in the queue for longer than the deadline.
      expect(proxy.redeemed()).toBe(BUDGET_BODIES)
      proxy.releaseAll()
      await sleep(deadlineMs / 2)
      queued.finish(body.slice(1))
      const served = await within(queued.reply, 5_000)
      expect(served.status).toBe(200)
      expect(served.body).toContain('"outcome":"success"')
      expect(proxy.redeemed()).toBe(BUDGET_BODIES + 1)
      for (const reply of await Promise.all(holders)) expect(reply.status).toBe(200)
    } finally {
      proxy.releaseAll()
      queued?.destroy()
      await Promise.allSettled(holders)
      await proxy.close()
    }
  }, 30_000)

  it('T-MB-4-grok answers an unauthenticated oversize body 401 without parsing it', async () => {
    const proxy = await heldProxy(maxBodyBytes)
    proxy.releaseAll()
    const anonymous = stalledPost(proxy.port, { declaredBytes: maxBodyBytes + 1 })
    try {
      const refused = await within(anonymous.reply, 1_000)
      expect(refused.status).toBe(401)
      expect(JSON.parse(refused.body)).toEqual({ error: 'Unauthorized' })
      // Witness: an oversize body with a platform JWT reaches the size check.
      const oversizePayload = completionBody(20_000, 'oversize')
      expect(Buffer.byteLength(oversizePayload)).toBeGreaterThan(maxBodyBytes)
      const oversize = await post(proxy.port, oversizePayload)
      expect(oversize.status).toBe(413)
      expect(JSON.parse(oversize.body)).toEqual({ error: 'payload_too_large' })
      expect(proxy.redeemed()).toBe(0)
    } finally {
      anonymous.destroy()
      await proxy.close()
    }
  }, 30_000)
})

/**
 * Polls `condition` on real time (`performance.now` is never faked here);
 * fails loudly when it does not hold within `ms`.
 */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = performance.now() + ms
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`)
    await sleep(10)
  }
}

/**
 * #739 D1 — one admission clock per request. Every wait a request performs is
 * bounded by the instant it arrived plus `maxQueueWaitMs`, so time spent in the
 * body budget is not granted again by the stream gate.
 */
describe('grok-llm-proxy one admission clock (#739 D1)', () => {
  // A small body limit keeps this cheap; the budget scales with it.
  const maxBodyBytes = 16 * 1024

  it('T-AC-4-grok answers a request that waited 50 s for the body budget 503 at 60 s from arrival, not 110 s', async () => {
    const bodyWaitMs = 50_000
    // The stalled holders are answered 408 at `bodyWaitMs`, which is what frees
    // the budget for the queued request.
    const proxy = await heldProxy(maxBodyBytes, { bodyReadDeadlineMs: bodyWaitMs })
    proxy.releaseAll()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const stalled = Array.from({ length: BUDGET_BODIES }, () =>
      stalledPost(proxy.port, { declaredBytes: maxBodyBytes, token: platformToken })
    )
    const slots: Array<() => void> = []
    let queued: ReturnType<typeof stalledPost> | undefined
    let acquire: ReturnType<typeof vi.spyOn> | undefined
    try {
      await until(() => proxy.arrived() >= BUDGET_BODIES, 'the stalled holders arriving')
      await sleep(50)
      for (let i = 0; i < STREAM_LIMITS.maxConcurrentStreams; i += 1) {
        slots.push(await streamGate.acquire())
      }
      // Pass-through spy: it only counts the handler's calls into the gate.
      acquire = vi.spyOn(streamGate, 'acquire')
      // The ticket outlives every wait below, so only the admission clock can
      // end this request.
      const body = completionBody(12_000, 'one-clock', 300)
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBodyBytes)
      const arrivedAt = Date.now()
      queued = stalledPost(proxy.port, {
        declaredBytes: Buffer.byteLength(body),
        token: platformToken,
        sent: body,
      })
      await until(() => proxy.arrived() >= BUDGET_BODIES + 1, 'the queued request arriving')
      await sleep(50)

      await vi.advanceTimersByTimeAsync(bodyWaitMs)
      for (const reply of await Promise.all(stalled.map(s => within(s.reply, 2_000)))) {
        expect(reply.status).toBe(408)
      }
      // Witness: the queued body was granted, parsed and verified, and now
      // waits at the saturated stream gate.
      const spy = acquire
      await until(() => spy.mock.calls.length === 1, 'the request queueing at the stream gate')

      await vi.advanceTimersByTimeAsync(STREAM_LIMITS.maxQueueWaitMs - bodyWaitMs - 1)
      expect((await within(queued.reply, 200)).status).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      const refused = await within(queued.reply, 2_000)
      expect(refused.status).toBe(503)
      expect(JSON.parse(refused.body)).toEqual({ error: 'provider_unavailable' })
      expect(Date.now() - arrivedAt).toBe(STREAM_LIMITS.maxQueueWaitMs)
      expect(proxy.redeemed()).toBe(0)
    } finally {
      acquire?.mockRestore()
      vi.useRealTimers()
      for (const s of stalled) s.destroy()
      queued?.destroy()
      for (const release of slots) release()
      await proxy.close()
    }
  }, 30_000)
})

/**
 * POST `body` with the given `Content-Encoding`. Keep-alive, so a reply sent
 * before the body is read is not raced by the client's own write.
 */
function postEncoded(
  port: number,
  options: { path: string; token: string; body: Buffer; encoding: string }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: options.path,
        agent: false,
        headers: {
          connection: 'keep-alive',
          'content-type': 'application/json',
          'content-encoding': options.encoding,
          'content-length': options.body.length,
          authorization: `Bearer ${options.token}`,
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () => {
          req.destroy()
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

/**
 * R9-1 — the byte budget reserves the declared wire length, so a body the
 * parser inflated could hold many times its reservation. Every parser refuses
 * an encoded body before inflating it.
 */
describe('grok-llm-proxy encoded bodies (R9-1)', () => {
  // A small body limit keeps these cheap; the budget scales with it.
  const maxBodyBytes = 16 * 1024

  it('T-R9-1a-grok refuses a gzip completion body that decodes past its reservation with 415', async () => {
    const proxy = await heldProxy(maxBodyBytes)
    proxy.releaseAll()
    try {
      const plain = completionBody(12_000, 'gzip')
      const gzipped = gzipSync(plain)
      // Fixture check: the wire length reserved is a small fraction of what
      // the parser would hold after inflating it, and inflated it fits the cap.
      expect(10 * gzipped.length).toBeLessThan(Buffer.byteLength(plain))
      expect(Buffer.byteLength(plain)).toBeLessThanOrEqual(maxBodyBytes)
      const refused = await postEncoded(proxy.port, {
        path: COMPLETIONS_PATH,
        token: platformToken,
        body: gzipped,
        encoding: 'gzip',
      })
      expect(refused.status).toBe(415)
      expect(JSON.parse(refused.body)).toEqual({ error: 'unsupported_media_type' })
      expect(proxy.redeemed()).toBe(0)
      // Witness: the same request unencoded is read, redeemed and served.
      const served = await post(proxy.port, completionBody(12_000, 'plain'))
      expect(served.status).toBe(200)
      expect(proxy.redeemed()).toBe(1)
    } finally {
      await proxy.close()
    }
  }, 30_000)

  it('T-R9-1c-grok refuses a gzip admin body with 415', async () => {
    const proxy = await heldProxy(maxBodyBytes)
    try {
      const gzipped = gzipSync(JSON.stringify({ accessToken: 'x'.repeat(8_000) }))
      expect(10 * gzipped.length).toBeLessThan(8_000)
      const refused = await postEncoded(proxy.adminPort, {
        path: '/internal/admin/v1/grok/models',
        token: adminPermit,
        body: gzipped,
        encoding: 'gzip',
      })
      expect(refused.status).toBe(415)
      expect(JSON.parse(refused.body)).toEqual({ error: 'unsupported_media_type' })
    } finally {
      await proxy.close()
    }
  }, 30_000)
})
