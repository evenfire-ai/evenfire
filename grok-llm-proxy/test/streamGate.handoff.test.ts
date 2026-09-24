import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { connect as connectTcp } from 'node:net'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hashGrokCompletionRequest,
  parseGrokCompletionRequest,
} from '@clerum/grok-provider-attempt-contract'
import { type GrokLlmProxyConfig } from '../src/config.js'
import { logger } from '../src/logger.js'
import { createProxyApps } from '../src/server.js'
import {
  STREAM_LIMITS,
  VISUAL_STREAM_LIMITS,
  streamGate,
  visualStreamGate,
} from '../src/requestLimits.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const COMPLETIONS_PATH = '/internal/runtime/v1/grok/completions'

type SchemaVersion = 'grok-completion-request.v1' | 'grok-completion-request.v2'

function config(overrides: Partial<GrokLlmProxyConfig> = {}): GrokLlmProxyConfig {
  return {
    runtimePort: 8080,
    adminPort: 8081,
    probePort: 9090,
    maxBodyBytes: 1_048_576,
    maxVisualBodyBytes: 35 * 1024 * 1024,
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
      workflowControlScopes: ['llm:grok:execute'],
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
      typ: 'grok-execution-ticket',
      hostRef: 'research-host',
      model: 'grok-4.6',
      requestHash,
      providerAttemptId: `att-${ticketSeq}`,
    },
    'grok-llm-proxy'
  )
}

function completionRequest(schemaVersion: SchemaVersion, content = 'hi') {
  ticketSeq += 1
  return {
    schemaVersion,
    requestId: `req-gate-${ticketSeq}`,
    idempotencyKey: `idem-gate-${ticketSeq}`,
    provider: 'grok-subscription',
    model: 'grok-4.6',
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
  schemaVersion: SchemaVersion,
  content = 'hi'
): { token: string; body: string } {
  const raw = completionRequest(schemaVersion, content)
  const parsed = parseGrokCompletionRequest(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  const requestHash = hashGrokCompletionRequest(parsed.value)
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
  schemaVersion: SchemaVersion,
  content = 'hi'
): Promise<Response> {
  const { token, body } = completionPayload(schemaVersion, content)
  return fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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
        `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
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

function postBody(port: number, token: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body,
  })
}

// Declares `declared` body bytes, sends `sent` of them and then stalls, so the
// server has to answer before the body completes.
function postStalled(
  port: number,
  token: string,
  declared: number,
  sent: string
): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      socket.write(
        `POST ${COMPLETIONS_PATH} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${token}\r\n` +
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
    request: completionRequest('grok-completion-request.v2', 'x'.repeat(maxBodyBytes)),
  })
  expect(Buffer.byteLength(body)).toBeGreaterThan(maxBodyBytes)
  const res = await postBody(port, platformToken(), body)
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'ticket_invalid' })
}

describe('grok visual stream-gate handoff', () => {
  const hangs: Array<{ release: () => void }> = []
  const serversToClose: Array<{ close: () => Promise<void> }> = []
  const listeners: Array<ReturnType<typeof createServer>> = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const hang of hangs.splice(0)) hang.release()
    for (const server of serversToClose.splice(0)) await server.close()
    await Promise.all(
      listeners.splice(0).map(
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

  function listen(servers: ReturnType<typeof createProxyApps>): number {
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    return address.port
  }

  it('keeps small V1 text off the visual gate while a large V2 stream holds it', async () => {
    expect(VISUAL_STREAM_LIMITS.maxConcurrentStreams).toBe(1)
    expect(STREAM_LIMITS.maxConcurrentStreams).toBe(8)

    const small = completionPayload('grok-completion-request.v1')
    const maxBodyBytes = Buffer.byteLength(small.body) + 512
    const largeContent = 'x'.repeat(maxBodyBytes)
    const large = completionPayload('grok-completion-request.v2', largeContent)
    expect(Buffer.byteLength(large.body)).toBeGreaterThan(maxBodyBytes)

    const hang = hangStream()
    hangs.push(hang)
    const port = listen(
      createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
        streamCompletion: hang.impl,
      })
    )

    const firstVisual = postCompletion(port, 'grok-completion-request.v2', largeContent)
    await waitFor(
      () => visualStreamGate.snapshot().running === 1 && streamGate.snapshot().running === 0,
      'large V2 did not hold the visual gate'
    )

    const v1 = postCompletion(port, 'grok-completion-request.v1')
    await waitFor(
      () => streamGate.snapshot().running === 1 && visualStreamGate.snapshot().running === 1,
      'small V1 waited on the visual gate instead of the ordinary stream gate'
    )

    const queued = Array.from({ length: VISUAL_STREAM_LIMITS.maxQueuedRequests }, () =>
      postCompletion(port, 'grok-completion-request.v2', largeContent)
    )
    await waitFor(
      () => visualStreamGate.snapshot().queued === VISUAL_STREAM_LIMITS.maxQueuedRequests,
      'visual queue did not fill to 4'
    )
    // One running and four queued: the sixth large V2 is refused, and the
    // refusal names the visual gate in the log.
    const warn = vi.spyOn(logger, 'warn')
    const overflow = await postCompletion(port, 'grok-completion-request.v2', largeContent)
    expect(overflow.status).toBe(503)
    expect(await overflow.json()).toEqual({ error: 'provider_unavailable' })
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'grok_proxy_admission_refused',
        reason: 'visual_gate',
        code: 'provider_unavailable',
      }),
      'admission refused'
    )

    const textWhileSaturated = postCompletion(port, 'grok-completion-request.v1')
    await waitFor(
      () => streamGate.snapshot().running === 2 && visualStreamGate.snapshot().running === 1,
      'a small V1 was rejected or queued behind a saturated image stream'
    )

    hang.release()
    await Promise.all([v1, textWhileSaturated, firstVisual, ...queued])
  })

  it('does not queue a chunked platform body behind a saturated image stream', async () => {
    const small = completionPayload('grok-completion-request.v1')
    const maxBodyBytes = Buffer.byteLength(small.body) + 512
    const largeContent = 'x'.repeat(maxBodyBytes)
    const hang = hangStream()
    hangs.push(hang)
    const port = listen(
      createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
        streamCompletion: hang.impl,
      })
    )

    const firstVisual = postCompletion(port, 'grok-completion-request.v2', largeContent)
    await waitFor(
      () => visualStreamGate.snapshot().running === 1 && visualStreamGate.snapshot().queued === 0,
      'large V2 did not fill the visual gate'
    )

    // #731 R3-2 body admission refuses a body of undeclared length before it
    // reaches the transport budget, so the answer arrives while the visual
    // slot is still held.
    const status = await postChunked(port, platformToken())
    expect(status).toBe(411)
    expect(visualStreamGate.snapshot()).toEqual({ running: 1, queued: 0 })

    hang.release()
    await firstVisual
  })

  it('rejects a between-cap V1 with 413 and leaves the visual gate empty', async () => {
    const small = completionPayload('grok-completion-request.v1')
    const maxBodyBytes = Buffer.byteLength(small.body) + 512
    const largeContent = 'x'.repeat(maxBodyBytes)
    const large = completionPayload('grok-completion-request.v1', largeContent)
    expect(Buffer.byteLength(large.body)).toBeGreaterThan(maxBodyBytes)

    const port = listen(createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 })))

    const response = await fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
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
    const small = completionPayload('grok-completion-request.v2')
    const maxBodyBytes = Buffer.byteLength(small.body) + 64
    const padded = `${small.body}${' '.repeat(maxBodyBytes - Buffer.byteLength(small.body) + 1)}`
    expect(Buffer.byteLength(padded)).toBeGreaterThan(maxBodyBytes)

    const hang = hangStream()
    hangs.push(hang)
    const port = listen(
      createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 }), {
        streamCompletion: hang.impl,
      })
    )

    const response = fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
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

  describe('visual slot lifetime', () => {
    function smallCaps(): number {
      return Buffer.byteLength(completionPayload('grok-completion-request.v1').body) + 512
    }

    async function expectGateEmpty(): Promise<void> {
      await waitFor(
        () =>
          visualStreamGate.snapshot().running === 0 && visualStreamGate.snapshot().queued === 0,
        'the visual slot was not released'
      )
      expect(visualStreamGate.snapshot()).toEqual({ running: 0, queued: 0 })
    }

    it('answers 400 to a deeply nested visual body and frees the slot', async () => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const port = listen(createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 })))
      // JSON.parse accepts this depth; JSON.stringify and the contract's byte
      // measurement throw RangeError on it.
      const depth = 20_000
      const body =
        `{"executionTicket":"invalid-ticket","requestHash":"${'a'.repeat(64)}",` +
        `"request":{"schemaVersion":"grok-completion-request.v2",` +
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
      const port = listen(createProxyApps(config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024 })))
      const body = JSON.stringify({
        executionTicket: 'invalid-ticket',
        requestHash: 'a'.repeat(64),
        request: completionRequest('grok-completion-request.v2', 'x'.repeat(maxBodyBytes)),
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
      overrides?: Partial<GrokLlmProxyConfig>
      body: (maxBodyBytes: number) => { token: string; body: string }
    }

    const largeValid = (maxBodyBytes: number) =>
      completionPayload('grok-completion-request.v2', 'x'.repeat(maxBodyBytes))

    const refusals: RefusalRow[] = [
      {
        name: 'malformed JSON',
        status: 400,
        error: 'invalid_request',
        body: maxBodyBytes => ({
          token: platformToken(),
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
            token: valid.token,
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
            token: valid.token,
            body: JSON.stringify({ ...JSON.parse(valid.body), executionTicket: 'invalid-ticket' }),
          }
        },
      },
      {
        name: 'a host binding mismatch',
        status: 403,
        error: 'host_binding_mismatch',
        body: maxBodyBytes => ({
          token: platformToken(['other-host']),
          body: largeValid(maxBodyBytes).body,
        }),
      },
      {
        name: 'execution disabled',
        status: 404,
        error: 'disabled',
        overrides: { executionEnabled: false },
        body: largeValid,
      },
    ]

    it.each(refusals)('frees the visual slot after refusing $name', async row => {
      const maxBodyBytes = smallCaps()
      const acquire = vi.spyOn(visualStreamGate, 'acquire')
      const port = listen(
        createProxyApps(
          config({ maxBodyBytes, maxVisualBodyBytes: 1024 * 1024, ...row.overrides })
        )
      )
      const { token, body } = row.body(maxBodyBytes)
      expect(Buffer.byteLength(body)).toBeGreaterThan(maxBodyBytes)

      const res = await postBody(port, token, body)
      expect(res.status).toBe(row.status)
      expect(await res.json()).toEqual({ error: row.error })
      expect(acquire).toHaveBeenCalledTimes(1)
      await expectGateEmpty()
      // The ticket check runs before the execution flag, so this also holds
      // for the disabled row.
      await expectNextVisualAdmitted(port, maxBodyBytes)
    })

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
      const holder = postCompletion(port, 'grok-completion-request.v2', 'x'.repeat(maxBodyBytes))
      await waitFor(() => visualStreamGate.snapshot().running === 1, 'no stream held the gate')

      const abort = new AbortController()
      const { token, body } = largeValid(maxBodyBytes)
      const waiting = fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: abort.signal,
      }).catch((err: unknown) => err)
      await waitFor(() => visualStreamGate.snapshot().queued === 1, 'the second request did not queue')
      abort.abort()
      expect(await waiting).toBeInstanceOf(Error)
      await waitFor(() => visualStreamGate.snapshot().queued === 0, 'the aborted waiter kept its place')
      expect(acquire).toHaveBeenCalledTimes(2)

      hang.release()
      await holder
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
      const holder = postCompletion(port, 'grok-completion-request.v2', 'x'.repeat(maxBodyBytes))
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
