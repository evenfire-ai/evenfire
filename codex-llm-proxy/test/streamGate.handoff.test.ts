import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { connect as connectTcp } from 'node:net'
import {
  hashCodexCompletionRequest,
  parseCodexCompletionRequest,
} from '@clerum/llm-provider-attempt-contract'
import { type CodexLlmProxyConfig } from '../src/config.js'
import { logger } from '../src/logger.js'
import {
  RequestLimitError,
  STREAM_LIMITS,
  VISUAL_PER_HOST_MAX_ADMITTED,
  VISUAL_STREAM_LIMITS,
  streamGate,
  visualStreamGate,
} from '../src/requestLimits.js'
import { createProxyApps } from '../src/server.js'

const COMPLETIONS_PATH = '/internal/runtime/v1/codex/completions'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function config(overrides: Partial<CodexLlmProxyConfig> = {}): CodexLlmProxyConfig {
  return {
    runtimePort: 8080,
    adminPort: 8081,
    probePort: 9090,
    maxBodyBytes: 1_048_576,
    maxVisualBodyBytes: 24 * 1024 * 1024,
    maxStreamDurationMs: 300_000,
    maxDeadlineMs: 300_000,
    upstreamIdleTimeoutMs: 300_000,
    heartbeatIntervalMs: 15_000,
    jwtIssuer: 'control-api',
    jwtPublicKey: publicKey,
    executionEnabled: true,
    controlApiBaseUrl: '',
    controlApiServiceName: 'codex-llm-proxy',
    controlApiServiceToken: '',
    ...overrides,
  }
}

function sign(payload: Record<string, unknown>, audience: string): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience,
    expiresIn: 60,
  })
}

function platformToken(hostRefs: string[] = ['research-host']): string {
  return sign(
    {
      sub: 'default/research-host',
      hostRefs,
      workflowControlScopes: ['llm:codex:execute'],
      scope: 'workflow:approval:request',
    },
    'workflow-approvals'
  )
}

let ticketSeq = 1

function ticket(requestHash: string): string {
  ticketSeq += 1
  return sign(
    {
      jti: `11111111-1111-4111-8111-${String(ticketSeq).padStart(12, '0')}`,
      typ: 'codex-execution-ticket',
      hostRef: 'research-host',
      model: 'gpt-5.1',
      requestHash,
      providerAttemptId: `att-${ticketSeq}`,
    },
    'codex-llm-proxy'
  )
}

function completionRequest(
  schemaVersion: 'codex-completion-request.v1' | 'codex-completion-request.v2',
  content = 'hi'
) {
  ticketSeq += 1
  return {
    schemaVersion,
    requestId: `req-gate-${ticketSeq}`,
    idempotencyKey: `idem-gate-${ticketSeq}`,
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    messages: [{ role: 'user', content }],
  }
}

function hangStream() {
  let releaseHeld!: () => void
  const held = new Promise<void>(resolve => {
    releaseHeld = resolve
  })
  return {
    release: () => releaseHeld(),
    impl: async () => {
      await held
      return { outcome: 'canceled' as const }
    },
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(label)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function completionPayload(
  schemaVersion: 'codex-completion-request.v1' | 'codex-completion-request.v2',
  content = 'hi'
): { token: string; body: string } {
  const raw = completionRequest(schemaVersion, content)
  const parsed = parseCodexCompletionRequest(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  const requestHash = hashCodexCompletionRequest(parsed.value)
  return {
    token: platformToken(),
    body: JSON.stringify({
      executionTicket: ticket(requestHash),
      requestHash,
      request: raw,
    }),
  }
}

async function postCompletion(
  port: number,
  schemaVersion: 'codex-completion-request.v1' | 'codex-completion-request.v2',
  content = 'hi',
  hostRefs: string[] = ['research-host']
): Promise<Response> {
  const { body } = completionPayload(schemaVersion, content)
  return fetch(`http://127.0.0.1:${port}/internal/runtime/v1/codex/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${platformToken(hostRefs)}`,
      'content-type': 'application/json',
    },
    body,
  })
}

function postChunked(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      const chunk = Buffer.from('{}')
      socket.write(
        `POST /internal/runtime/v1/codex/completions HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${token}\r\n` +
          `Content-Type: application/json\r\n` +
          `Connection: close\r\n` +
          `Transfer-Encoding: chunked\r\n` +
          `\r\n` +
          `${chunk.length.toString(16)}\r\n`
      )
      socket.write(chunk)
      socket.write('\r\n0\r\n\r\n')
    })
    const chunks: Buffer[] = []
    const finish = () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const match = /^HTTP\/1\.1 (\d+)/.exec(raw)
      if (!match) {
        reject(new Error(`no status in ${raw.slice(0, 180)}`))
        return
      }
      resolve(Number(match[1]))
    }
    socket.setTimeout(2_000, () => {
      socket.destroy()
      finish()
    })
    socket.on('data', data => {
      chunks.push(data)
      if (Buffer.concat(chunks).toString('utf8').includes('\r\n\r\n')) {
        socket.destroy()
        finish()
      }
    })
    socket.on('error', err => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
    })
    socket.on('close', finish)
  })
}

function postBody(port: number, bearerToken: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body,
  })
}

// Declares `declared` body bytes, sends `sent` of them and then stalls, so the
// server has to answer before the body completes.
function postStalled(
  port: number,
  bearerToken: string,
  declared: number,
  sent: string
): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      socket.write(
        `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${bearerToken}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${declared}\r\n` +
          `\r\n` +
          sent
      )
    })
    const chunks: Buffer[] = []
    socket.setTimeout(3_000, () => {
      socket.destroy()
      reject(new Error('the server did not answer a stalled visual body'))
    })
    socket.on('data', data => {
      chunks.push(data)
      const raw = Buffer.concat(chunks).toString('utf8')
      const end = raw.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.destroy()
      const match = /^HTTP\/1\.1 (\d+)/.exec(raw)
      if (!match) {
        reject(new Error(`no status in ${raw.slice(0, 180)}`))
        return
      }
      resolve({ status: Number(match[1]), head: raw.slice(0, end) })
    })
    socket.on('error', err => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
    })
  })
}

// A large V2 with an unusable ticket: admitted through the visual gate, then
// refused at the ticket check. It can only answer 403 when a visual slot is free.
async function expectNextVisualAdmitted(port: number, maxBodyBytes: number): Promise<void> {
  const body = JSON.stringify({
    executionTicket: 'invalid-ticket',
    requestHash: 'a'.repeat(64),
    request: completionRequest('codex-completion-request.v2', 'x'.repeat(maxBodyBytes)),
  })
  expect(Buffer.byteLength(body)).toBeGreaterThan(maxBodyBytes)
  const res = await postBody(port, platformToken(), body)
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'ticket_invalid' })
}

describe('visual stream-gate handoff', () => {
  const hangs: Array<{ release: () => void }> = []
  const serversToClose: Array<{ close: () => Promise<void> }> = []
  const listeners: Array<ReturnType<typeof createServer>> = []

  function listen(servers: ReturnType<typeof createProxyApps>): number {
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    return address.port
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const hang of hangs.splice(0)) hang.release()
    for (const server of serversToClose.splice(0)) await server.close()
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
    await waitFor(
      () =>
        visualStreamGate.snapshot().running === 0 &&
        visualStreamGate.snapshot().queued === 0 &&
        streamGate.snapshot().running === 0 &&
        streamGate.snapshot().queued === 0,
      'gates did not drain after release'
    )
  })

  it('keeps small V1 text off the visual gate while large V2 streams hold it', async () => {
    expect(VISUAL_STREAM_LIMITS.maxConcurrentStreams).toBe(2)
    expect(STREAM_LIMITS.maxConcurrentStreams).toBe(8)

    const small = completionPayload('codex-completion-request.v1')
    const maxBodyBytes = Buffer.byteLength(small.body) + 512
    const largeContent = 'x'.repeat(maxBodyBytes)
    const large = completionPayload('codex-completion-request.v2', largeContent)
    expect(Buffer.byteLength(large.body)).toBeGreaterThan(maxBodyBytes)

    const hang = hangStream()
    hangs.push(hang)
    const servers = createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
      streamCompletion: hang.impl,
    })
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    const port = address.port

    const firstVisual = postCompletion(port, 'codex-completion-request.v2', largeContent)
    const secondVisual = postCompletion(port, 'codex-completion-request.v2', largeContent)
    await waitFor(
      () => visualStreamGate.snapshot().running === 2 && streamGate.snapshot().running === 0,
      'large V2 did not hold the visual gate'
    )

    const v1 = postCompletion(port, 'codex-completion-request.v1')
    await waitFor(
      () => streamGate.snapshot().running === 1 && visualStreamGate.snapshot().running === 2,
      'small V1 waited on the visual gate instead of the ordinary stream gate'
    )

    // One principal can hold at most four visual entries, so each queued
    // request mints a distinct principal; the subject here is the global gate
    // width, not the per-host share.
    const queued = Array.from({ length: VISUAL_STREAM_LIMITS.maxQueuedRequests }, (_, index) =>
      postCompletion(port, 'codex-completion-request.v2', largeContent, [`visual-queue-${index}`])
    )
    await waitFor(
      () => visualStreamGate.snapshot().queued === VISUAL_STREAM_LIMITS.maxQueuedRequests,
      'visual queue did not fill to 8'
    )
    const overflow = await postCompletion(port, 'codex-completion-request.v2', largeContent)
    expect(overflow.status).toBe(503)
    expect(await overflow.json()).toEqual({ error: 'provider_unavailable' })

    const textWhileSaturated = postCompletion(port, 'codex-completion-request.v1')
    await waitFor(
      () => streamGate.snapshot().running === 2 && visualStreamGate.snapshot().running === 2,
      'a small V1 was rejected or queued behind saturated image streams'
    )

    hang.release()
    await Promise.all([v1, textWhileSaturated, firstVisual, secondVisual, ...queued])
  })

  it('does not queue a chunked platform body behind saturated image streams', async () => {
    const small = completionPayload('codex-completion-request.v1')
    const maxBodyBytes = Buffer.byteLength(small.body) + 512
    const largeContent = 'x'.repeat(maxBodyBytes)
    const hang = hangStream()
    hangs.push(hang)
    const servers = createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
      streamCompletion: hang.impl,
    })
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    const port = address.port

    const firstVisual = postCompletion(port, 'codex-completion-request.v2', largeContent)
    const secondVisual = postCompletion(port, 'codex-completion-request.v2', largeContent)
    await waitFor(
      () => visualStreamGate.snapshot().running === 2 && visualStreamGate.snapshot().queued === 0,
      'large V2 did not fill the visual gate'
    )

    // #731 R3-2 body admission refuses a body of undeclared length before it
    // reaches the transport budget, so the answer arrives while both visual
    // slots are still held.
    const status = await postChunked(port, platformToken())
    expect(status).toBe(411)
    expect(visualStreamGate.snapshot()).toEqual({ running: 2, queued: 0 })

    hang.release()
    await Promise.all([firstVisual, secondVisual])
  })

  it('rejects a between-cap V1 with 413 and leaves the visual gate empty', async () => {
    const small = completionPayload('codex-completion-request.v1')
    const maxBodyBytes = Buffer.byteLength(small.body) + 512
    const largeContent = 'x'.repeat(maxBodyBytes)
    const large = completionPayload('codex-completion-request.v1', largeContent)
    expect(Buffer.byteLength(large.body)).toBeGreaterThan(maxBodyBytes)

    const servers = createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }))
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    const port = address.port

    const response = await fetch(`http://127.0.0.1:${port}/internal/runtime/v1/codex/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${large.token}`,
        'content-type': 'application/json',
      },
      body: large.body,
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload_too_large' })
    expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    expect(streamGate.snapshot()).toEqual({ running: 0, queued: 0 })
  })

  it('releases the visual slot for a whitespace-padded small V2', async () => {
    const small = completionPayload('codex-completion-request.v2')
    const maxBodyBytes = Buffer.byteLength(small.body) + 64
    const padded = `${small.body}${' '.repeat(maxBodyBytes - Buffer.byteLength(small.body) + 1)}`
    expect(Buffer.byteLength(padded)).toBeGreaterThan(maxBodyBytes)

    const hang = hangStream()
    hangs.push(hang)
    const servers = createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
      streamCompletion: hang.impl,
    })
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    const port = address.port

    const response = fetch(`http://127.0.0.1:${port}/internal/runtime/v1/codex/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${small.token}`,
        'content-type': 'application/json',
      },
      body: padded,
    })
    await waitFor(
      () => streamGate.snapshot().running === 1 && visualStreamGate.snapshot().running === 0,
      'padded small V2 kept the visual slot instead of the ordinary stream gate'
    )
    hang.release()
    await response
  })

  describe('visual per-host share', () => {
    function invalidTicketBody(maxBodyBytes: number): string {
      const body = JSON.stringify({
        executionTicket: 'invalid-ticket',
        requestHash: 'a'.repeat(64),
        request: completionRequest('codex-completion-request.v2', 'x'.repeat(maxBodyBytes)),
      })
      expect(Buffer.byteLength(body)).toBeGreaterThan(maxBodyBytes)
      return body
    }

    it('refuses a platform token whose sub is not a non-empty string with 401', async () => {
      const port = listen(createProxyApps(config()))
      const claims = {
        hostRefs: ['research-host'],
        workflowControlScopes: ['llm:codex:execute'],
        scope: 'workflow:approval:request',
      }
      for (const bearerToken of [
        sign(claims, 'workflow-approvals'),
        sign({ ...claims, sub: '' }, 'workflow-approvals'),
        sign({ ...claims, sub: 403 }, 'workflow-approvals'),
      ]) {
        const res = await postBody(port, bearerToken, JSON.stringify({ probe: 1 }))
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Unauthorized' })
      }
      // Liveness witness: none of those requests reached body admission.
      expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    })

    it('admits at most four visual entries per principal while another principal proceeds', async () => {
      expect(VISUAL_PER_HOST_MAX_ADMITTED).toBe(4)
      const maxBodyBytes =
        Buffer.byteLength(completionPayload('codex-completion-request.v1').body) + 512
      const hang = hangStream()
      hangs.push(hang)
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const warn = vi.spyOn(logger, 'warn')
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
          streamCompletion: hang.impl,
        })
      )

      // Host A's first two entries run and its next two queue; all four count
      // against the same principal (sub plus hostRefs).
      const first = postCompletion(port, 'codex-completion-request.v2', 'x'.repeat(maxBodyBytes))
      const second = postCompletion(port, 'codex-completion-request.v2', 'x'.repeat(maxBodyBytes))
      await waitFor(
        () => visualStreamGate.snapshot().running === 2,
        'host A did not take both running visual slots'
      )
      const third = postBody(port, platformToken(), invalidTicketBody(maxBodyBytes))
      postBody(port, platformToken(), invalidTicketBody(maxBodyBytes))
      await waitFor(
        () => visualStreamGate.snapshot().queued === 2,
        'host A did not take two queued visual entries'
      )
      expect(acquire).toHaveBeenCalledTimes(4)

      const fifth = await postBody(port, platformToken(), invalidTicketBody(maxBodyBytes))
      expect(fifth.status).toBe(503)
      expect(await fifth.json()).toEqual({ error: 'provider_unavailable' })
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'codex_proxy_admission_refused',
          reason: 'visual_host_share',
        }),
        'admission refused'
      )
      // The share refusal happens before the global gate is touched.
      expect(acquire).toHaveBeenCalledTimes(4)

      const otherHost = postBody(
        port,
        platformToken(['other-host']),
        invalidTicketBody(maxBodyBytes)
      )
      await waitFor(
        () => visualStreamGate.snapshot().queued === 3,
        'host B was not admitted while host A held its full share'
      )

      hang.release()
      await first
      await second
      const thirdRes = await third
      expect(thirdRes.status).toBe(403)
      expect(await thirdRes.json()).toEqual({ error: 'ticket_invalid' })
      const otherRes = await otherHost
      expect(otherRes.status).toBe(403)
      expect(await otherRes.json()).toEqual({ error: 'ticket_invalid' })
      await waitFor(
        () => visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
        'the visual gate did not drain'
      )
      // Host A's share was released with its entries, so a fresh A request is
      // admitted again and reaches the ticket check.
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })
  })

  describe('visual slot lifetime', () => {
    function smallCaps(): number {
      return Buffer.byteLength(completionPayload('codex-completion-request.v1').body) + 512
    }

    async function expectGateEmpty(): Promise<void> {
      await waitFor(
        () => visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
        'the visual slot was not released'
      )
      expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    }

    it('answers 400 to a deeply nested visual body and frees the slot', async () => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }))
      )
      // JSON.parse accepts this depth; JSON.stringify and the contract's byte
      // measurement throw RangeError on it.
      const depth = 20_000
      const body =
        `{"executionTicket":"invalid-ticket","requestHash":"${'a'.repeat(64)}",` +
        `"request":{"schemaVersion":"codex-completion-request.v2",` +
        `"deep":${'['.repeat(depth)}${']'.repeat(depth)}}}`
      expect(Buffer.byteLength(body)).toBeGreaterThan(maxBodyBytes)

      const res = await postBody(port, platformToken(), body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_request' })
      expect(acquire).toHaveBeenCalledTimes(1)
      await expectGateEmpty()
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })

    it('frees the slot when the handler throws before releasing it', async () => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }))
      )
      const body = JSON.stringify({
        executionTicket: 'invalid-ticket',
        requestHash: 'a'.repeat(64),
        request: completionRequest('codex-completion-request.v2', 'x'.repeat(maxBodyBytes)),
        poison: true,
      })
      expect(Buffer.byteLength(body)).toBeGreaterThan(maxBodyBytes)
      // Any throw between the grant and the handler's explicit releases reaches
      // the error handler; only the response's close event can free the slot.
      const stringify = JSON.stringify.bind(JSON)
      const poisoned = vi.spyOn(JSON, 'stringify').mockImplementation(((
        value: unknown,
        ...rest: unknown[]
      ) => {
        if (value !== null && typeof value === 'object' && 'poison' in value) {
          throw new RangeError('Maximum call stack size exceeded')
        }
        return (stringify as (...args: unknown[]) => string)(value, ...rest)
      }) as typeof JSON.stringify)

      const res = await postBody(port, platformToken(), body)
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error' })
      expect(poisoned).toHaveBeenCalledWith(expect.objectContaining({ poison: true }))
      expect(acquire).toHaveBeenCalledTimes(1)
      poisoned.mockRestore()
      await expectGateEmpty()
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })

    it('answers 408 to a stalled visual body within the read deadline and frees the slot', async () => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
          bodyReadDeadlineMs: 100,
        })
      )
      const declared = maxBodyBytes + 1024
      const answer = await postStalled(port, platformToken(), declared, '{"executionTicket":')
      expect(answer.status).toBe(408)
      expect(answer.head).toMatch(/^connection: close$/im)
      expect(acquire).toHaveBeenCalledTimes(1)
      await expectGateEmpty()
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })

    type RefusalRow = {
      name: string
      status: number
      error: string
      overrides?: Partial<CodexLlmProxyConfig>
      body: (maxBodyBytes: number) => { auth: string; body: string }
    }

    const largeValid = (maxBodyBytes: number) =>
      completionPayload('codex-completion-request.v2', 'x'.repeat(maxBodyBytes))

    const refusals: RefusalRow[] = [
      {
        name: 'malformed JSON',
        status: 400,
        error: 'invalid_request',
        body: maxBodyBytes => ({
          auth: platformToken(),
          body: `{"pad":"${'x'.repeat(maxBodyBytes)}`,
        }),
      },
      {
        name: 'an unknown envelope field',
        status: 400,
        error: 'unknown_field',
        body: maxBodyBytes => {
          const valid = largeValid(maxBodyBytes)
          return {
            auth: valid.token,
            body: JSON.stringify({ ...JSON.parse(valid.body), extra: 1 }),
          }
        },
      },
      {
        name: 'an invalid ticket',
        status: 403,
        error: 'ticket_invalid',
        body: maxBodyBytes => {
          const valid = largeValid(maxBodyBytes)
          return {
            auth: valid.token,
            body: JSON.stringify({ ...JSON.parse(valid.body), executionTicket: 'invalid-ticket' }),
          }
        },
      },
      {
        name: 'a host binding mismatch',
        status: 403,
        error: 'host_binding_mismatch',
        body: maxBodyBytes => ({
          auth: platformToken(['other-host']),
          body: largeValid(maxBodyBytes).body,
        }),
      },
      {
        name: 'execution disabled',
        status: 404,
        error: 'disabled',
        overrides: { executionEnabled: false },
        body: maxBodyBytes => {
          const valid = largeValid(maxBodyBytes)
          return { auth: valid.token, body: valid.body }
        },
      },
    ]

    it.each(refusals)('frees the visual slot after refusing $name', async row => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024, ...row.overrides }))
      )
      const payload = row.body(maxBodyBytes)
      expect(Buffer.byteLength(payload.body)).toBeGreaterThan(maxBodyBytes)

      const res = await postBody(port, payload.auth, payload.body)
      expect(res.status).toBe(row.status)
      expect(await res.json()).toEqual({ error: row.error })
      expect(acquire).toHaveBeenCalledTimes(1)
      await expectGateEmpty()
      // The ticket check runs before the execution flag, so this also holds
      // for the disabled row.
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })

    // A body this small fits the socket buffer Node keeps reading, so the
    // client's disconnect fires `aborted` while it waits. A larger body is the
    // next test.
    it('frees the queue place of a visual request aborted while it waited', async () => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const hang = hangStream()
      hangs.push(hang)
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
          streamCompletion: hang.impl,
        })
      )
      // Codex admits two visual streams, so both entries must be held before a
      // third request can queue behind them.
      const holderA = postCompletion(port, 'codex-completion-request.v2', 'x'.repeat(maxBodyBytes))
      const holderB = postCompletion(port, 'codex-completion-request.v2', 'x'.repeat(maxBodyBytes))
      await waitFor(
        () => visualStreamGate.snapshot().running === 2,
        'no pair of streams held the gate'
      )

      const abort = new AbortController()
      const payload = largeValid(maxBodyBytes)
      const waiting = fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${payload.token}`, 'content-type': 'application/json' },
        body: payload.body,
        signal: abort.signal,
      }).catch((err: unknown) => err)
      await waitFor(
        () => visualStreamGate.snapshot().queued === 1,
        'the second request did not queue'
      )
      const warn = vi.spyOn(logger, 'warn')
      abort.abort()
      expect(await waiting).toBeInstanceOf(Error)
      await waitFor(
        () => visualStreamGate.snapshot().queued === 0,
        'the aborted waiter kept its place'
      )
      expect(acquire).toHaveBeenCalledTimes(3)
      // Witness: the waiter's acquire ended on the client's abort, so the
      // catch around it ran. A departed client is not gate saturation and
      // must not be logged as `visual_gate`.
      const waiterAcquire = acquire.mock.results[2]?.value as Promise<unknown>
      const acquireError = await waiterAcquire.catch((err: unknown) => err)
      expect(acquireError).toBeInstanceOf(RequestLimitError)
      expect((acquireError as RequestLimitError).kind).toBe('aborted')
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'codex_proxy_admission_refused', reason: 'visual_gate' }),
        'admission refused'
      )

      hang.release()
      await holderA
      await holderB
      await expectGateEmpty()
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })

    // Once the unread body exceeds the request's buffer, Node stops reading the
    // socket, so a queued client's disconnect is not seen and `aborted` never
    // fires. The place is held until the grant or the admission deadline. At the
    // grant Node reads the bytes that already reached the server; here that is
    // the whole body, so the dead client's request runs through the handler,
    // which frees the slot. This pins that bound.
    it('holds the queue place of a disconnected large-body waiter until its grant', async () => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const hang = hangStream()
      hangs.push(hang)
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 4 * 1024 * 1024 }), {
          streamCompletion: hang.impl,
        })
      )
      const holderA = postCompletion(port, 'codex-completion-request.v2', 'x'.repeat(maxBodyBytes))
      const holderB = postCompletion(port, 'codex-completion-request.v2', 'x'.repeat(maxBodyBytes))
      await waitFor(
        () => visualStreamGate.snapshot().running === 2,
        'no pair of streams held the gate'
      )

      const payload = largeValid(2 * 1024 * 1024)
      const waiter = connectTcp(port, '127.0.0.1', () => {
        waiter.write(
          `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Authorization: Bearer ${payload.token}\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(payload.body)}\r\n` +
            `\r\n`
        )
        waiter.write(payload.body)
      })
      waiter.on('error', err => {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ECONNRESET' && code !== 'EPIPE') throw err
      })
      await waitFor(
        () => visualStreamGate.snapshot().queued === 1,
        'the large waiter did not queue'
      )
      const closed = new Promise<void>(resolve => waiter.once('close', () => resolve()))
      waiter.destroy()
      await closed
      expect(waiter.destroyed).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 300))
      expect(visualStreamGate.snapshot()).toEqual({ running: 2, queued: 1 })
      expect(acquire).toHaveBeenCalledTimes(3)

      hang.release()
      await holderA
      await holderB
      await expectGateEmpty()
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })

    it('refuses a declared length past the visual ceiling with 413 without queueing', async () => {
      const maxBodyBytes = smallCaps()
      const maxVisualBodyBytes = 64 * 1024
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const hang = hangStream()
      hangs.push(hang)
      const port = listen(
        createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes }), {
          streamCompletion: hang.impl,
        })
      )
      const holder = postCompletion(port, 'codex-completion-request.v2', 'x'.repeat(maxBodyBytes))
      await waitFor(() => visualStreamGate.snapshot().running === 1, 'no stream held the gate')

      // With the slot held, a body that reached the gate would queue and wait;
      // the declared length alone must answer 413 first.
      const over = largeValid(maxVisualBodyBytes)
      expect(Buffer.byteLength(over.body)).toBeGreaterThan(maxVisualBodyBytes)
      const res = await postBody(port, over.token, over.body)
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'payload_too_large' })
      expect(visualStreamGate.snapshot()).toEqual({ running: 1, queued: 0 })
      expect(acquire).toHaveBeenCalledTimes(1)

      hang.release()
      await holder
    })
  })
})
