import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BODY_STRUCTURE_LIMITS,
  LIMITS,
  measureNonImageCompletionBytes,
  scanJsonStructure,
} from '@clerum/llm-provider-attempt-contract'
import { type CodexLlmProxyConfig } from '../src/config.js'
import { logger } from '../src/logger.js'
import {
  BodyBudget,
  ENVELOPE_ALLOWANCE_BYTES,
  RequestLimitError,
  streamGate,
  visualStreamGate,
} from '../src/requestLimits.js'
import { type ProxyRuntimeDeps, createProxyApps } from '../src/server.js'

// A8: JSON.parse allocates one heap object per container, so a body that fits
// every byte limit can still exhaust the proxy heap. Every parser scans the raw
// body against BODY_STRUCTURE_LIMITS before JSON.parse runs. These tests pin
// where each refusal happens (before the parse) and that the densest body the
// handler accepts is never refused by the scan.

// Test seam: make the structure verify throw an error that carries no status,
// so body-parser wraps it as a 403 `entity.verify.failed` that the error
// handler does not map.
const verifyFault = vi.hoisted(() => ({ throwPlain: false }))

vi.mock('@clerum/llm-provider-attempt-contract', async importOriginal => {
  const actual = await importOriginal<typeof import('@clerum/llm-provider-attempt-contract')>()
  return {
    ...actual,
    createBodyStructureVerify: (limits: Parameters<typeof actual.createBodyStructureVerify>[0]) => {
      const verify = actual.createBodyStructureVerify(limits)
      return (req: unknown, res: unknown, buf: Uint8Array, encoding: string): void => {
        if (verifyFault.throwPlain) throw new Error('verify fault')
        verify(req, res, buf, encoding)
      }
    },
  }
})

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const COMPLETIONS_PATH = '/internal/runtime/v1/codex/completions'
const MARKER = 'body-structure-marker-5f1c0e'
const BIG_STRING = 100_000

type SchemaVersion = 'codex-completion-request.v1' | 'codex-completion-request.v2'
type StreamCompletion = NonNullable<ProxyRuntimeDeps['streamCompletion']>

function config(overrides: Partial<CodexLlmProxyConfig> = {}): CodexLlmProxyConfig {
  return {
    runtimePort: 8080,
    adminPort: 8081,
    probePort: 9090,
    maxBodyBytes: 1_048_576,
    maxVisualBodyBytes: 24 * 1024 * 1024,
    maxStreamDurationMs: 1_800_000,
    maxDeadlineMs: 1_800_000,
    upstreamIdleTimeoutMs: 600_000,
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

function sign(payload: Record<string, unknown>, audience: string, expiresIn = 60): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience,
    expiresIn,
  })
}

function platformToken(): string {
  return sign(
    {
      sub: 'default/research-host',
      hostRefs: ['research-host'],
      workflowControlScopes: ['llm:codex:execute'],
      scope: 'workflow:approval:request',
    },
    'workflow-approvals'
  )
}

let seq = 1

function ticket(expiresIn = 60): string {
  seq += 1
  return sign(
    {
      jti: `22222222-2222-4222-8222-${String(seq).padStart(12, '0')}`,
      typ: 'codex-execution-ticket',
      hostRef: 'research-host',
      model: 'gpt-5.1',
      requestHash: 'a'.repeat(64),
      providerAttemptId: `att-${seq}`,
    },
    'codex-llm-proxy',
    expiresIn
  )
}

function completionRequest(schemaVersion: SchemaVersion, content = 'hi') {
  seq += 1
  return {
    schemaVersion,
    requestId: `req-structure-${String(seq).padStart(6, '0')}`,
    idempotencyKey: `idem-structure-${String(seq).padStart(6, '0')}`,
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    messages: [{ role: 'user', content }],
  }
}

/**
 * A completion body whose request carries `filler`, a JSON array written as
 * raw text so a million-element body is not built as objects first. The ticket
 * is unusable unless `executionTicket` is given, so an admitted body answers
 * 403 `ticket_invalid` at the ticket check.
 */
function bodyWithFiller(
  schemaVersion: SchemaVersion,
  filler: string,
  extra: { executionTicket?: string; content?: string; pad?: string } = {}
): string {
  const request: Record<string, unknown> = {
    ...completionRequest(schemaVersion, extra.content ?? 'hi'),
    filler: '__FILLER__',
  }
  if (extra.pad !== undefined) request.pad = extra.pad
  return JSON.stringify({
    executionTicket: extra.executionTicket ?? 'invalid-ticket',
    requestHash: 'a'.repeat(64),
    request,
  }).replace('"__FILLER__"', filler)
}

function measure(body: string) {
  return scanJsonStructure(Buffer.from(body), {
    maxStructuralBytes: Number.MAX_SAFE_INTEGER,
    maxContainers: Number.MAX_SAFE_INTEGER,
    maxDepth: Number.MAX_SAFE_INTEGER,
  })
}

/** A body holding exactly `containers` containers, the root included. */
function bodyWithContainers(schemaVersion: SchemaVersion, containers: number, content?: string): string {
  // root, request, messages, message and the filler array itself
  const filler = `[${new Array(containers - 5).fill('[]').join(',')}]`
  const body = bodyWithFiller(schemaVersion, filler, { content })
  expect(measure(body).containers).toBe(containers)
  return body
}

/** A body nesting exactly `depth` containers deep, the root included. */
function bodyWithDepth(depth: number): string {
  // root and request hold the filler; filler adds depth - 2 arrays
  const arrays = depth - 2
  const body = bodyWithFiller('codex-completion-request.v1', `${'['.repeat(arrays)}${']'.repeat(arrays)}`)
  expect(measure(body).deepest).toBe(depth)
  return body
}

function zeros(count: number): string {
  return `[${new Array(count).fill('0').join(',')}]`
}

/**
 * The densest V2 body the handler accepts: its non-image measure equals the
 * handler's own bound, and nearly all of it is structural bytes.
 */
function densestAcceptedV2(): string {
  const bound = LIMITS.maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES
  const one = JSON.parse(bodyWithFiller('codex-completion-request.v2', zeros(1), { pad: '' }))
  // Each further element adds two bytes ("0,"); `pad` takes the odd byte.
  const count = Math.floor((bound - measureNonImageCompletionBytes(one)) / 2) + 1
  const draft = JSON.parse(bodyWithFiller('codex-completion-request.v2', zeros(count), { pad: '' }))
  const pad = 'p'.repeat(bound - measureNonImageCompletionBytes(draft))
  const body = bodyWithFiller('codex-completion-request.v2', zeros(count), { pad })
  expect(measureNonImageCompletionBytes(JSON.parse(body))).toBe(bound)
  return body
}

function post(
  port: number,
  body: string | Uint8Array,
  contentType = 'application/json'
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${platformToken()}`, 'content-type': contentType },
    body,
  })
}

function adminPermit(): string {
  return sign(
    { sub: 'admin-1', typ: 'codex-admin-permit', operation: 'catalog_list' },
    'codex-llm-proxy-admin'
  )
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(label)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Lengths of the large strings JSON.parse was called with. */
function spyLargeParses(): () => number[] {
  const parse = vi.spyOn(JSON, 'parse')
  return () =>
    parse.mock.calls
      .map(([text]) => (typeof text === 'string' ? text.length : 0))
      .filter(length => length > BIG_STRING)
}

/** Every logged argument, with Buffers decoded, as one string. */
function loggedText(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return spies
    .flatMap(spy => spy.mock.calls)
    .map(args =>
      JSON.stringify(args, (_key, value: unknown) =>
        value !== null &&
        typeof value === 'object' &&
        (value as { type?: unknown }).type === 'Buffer' &&
        Array.isArray((value as { data?: unknown }).data)
          ? Buffer.from((value as { data: number[] }).data).toString('utf8')
          : value
      )
    )
    .join('\n')
}

/** A stream stub whose calls stay open until the test finishes them. */
function controlledStream() {
  const calls: Array<{ input: Parameters<StreamCompletion>[0]; finish: () => void }> = []
  const impl: StreamCompletion = async input => {
    await new Promise<void>(resolve => calls.push({ input, finish: resolve }))
    return { outcome: 'canceled' as const }
  }
  return { calls, impl }
}

describe('codex proxy raw-body structure bounds (A8)', () => {
  const streams: Array<ReturnType<typeof controlledStream>> = []
  const serversToClose: Array<{ close: () => Promise<void> }> = []
  const listeners: Array<ReturnType<typeof createServer>> = []

  afterEach(async () => {
    verifyFault.throwPlain = false
    vi.restoreAllMocks()
    for (const stream of streams.splice(0)) for (const call of stream.calls) call.finish()
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
      'gates did not drain'
    )
  })

  function listen(
    servers: ReturnType<typeof createProxyApps>,
    app: 'runtimeApp' | 'adminApp' = 'runtimeApp'
  ): number {
    serversToClose.push(servers)
    const listener = createServer(servers[app]).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    return address.port
  }

  it('refuses a visual body with too many containers before JSON.parse and frees the slot', async () => {
    const acquire = vi.spyOn(visualStreamGate, 'acquire')
    const largeParses = spyLargeParses()
    const port = listen(createProxyApps(config({ maxBodyBytes: 4096 })))

    const over = bodyWithContainers('codex-completion-request.v2', BODY_STRUCTURE_LIMITS.maxContainers + 1)
    expect(over.length).toBeGreaterThan(4096)
    const refused = await post(port, over)
    expect(refused.status).toBe(413)
    expect(await refused.json()).toEqual({ error: 'payload_too_large' })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(largeParses()).not.toContain(over.length)
    await waitFor(() => visualStreamGate.snapshot().running === 0, 'the visual slot was not released')

    // Witness: the same shape at the bound is parsed and reaches the ticket
    // check through a free visual slot.
    const atBound = bodyWithContainers('codex-completion-request.v2', BODY_STRUCTURE_LIMITS.maxContainers)
    const admitted = await post(port, atBound)
    expect(admitted.status).toBe(403)
    expect(await admitted.json()).toEqual({ error: 'ticket_invalid' })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(largeParses()).toContain(atBound.length)
  })

  it('refuses an ordinary body with too many containers before JSON.parse', async () => {
    const acquire = vi.spyOn(visualStreamGate, 'acquire')
    const largeParses = spyLargeParses()
    const maxBodyBytes = LIMITS.maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES
    const port = listen(createProxyApps(config({ maxBodyBytes })))

    const over = bodyWithContainers('codex-completion-request.v1', BODY_STRUCTURE_LIMITS.maxContainers + 1)
    expect(over.length).toBeLessThan(maxBodyBytes)
    const refused = await post(port, over)
    expect(refused.status).toBe(413)
    expect(await refused.json()).toEqual({ error: 'payload_too_large' })
    expect(largeParses()).not.toContain(over.length)

    const atBound = bodyWithContainers('codex-completion-request.v1', BODY_STRUCTURE_LIMITS.maxContainers)
    const admitted = await post(port, atBound)
    expect(admitted.status).toBe(403)
    expect(await admitted.json()).toEqual({ error: 'ticket_invalid' })
    expect(largeParses()).toContain(atBound.length)
    // Both bodies stayed on the ordinary parser.
    expect(acquire).not.toHaveBeenCalled()
  })

  it('refuses an admin body with too many containers before JSON.parse', async () => {
    const largeParses = spyLargeParses()
    const port = listen(createProxyApps(config()), 'adminApp')
    const adminBody = (containers: number): string =>
      `{"filler":[${Array.from({ length: containers - 2 }, () => '[]').join(',')}]}`
    const postAdmin = (body: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/internal/admin/v1/codex/models`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminPermit()}`, 'content-type': 'application/json' },
        body,
      })

    const over = adminBody(BODY_STRUCTURE_LIMITS.maxContainers + 1)
    const refused = await postAdmin(over)
    expect(refused.status).toBe(413)
    expect(await refused.json()).toEqual({ error: 'payload_too_large' })
    expect(largeParses()).not.toContain(over.length)

    // Witness: at the bound the body is parsed and reaches the admin handler,
    // which refuses the unknown key.
    const atBound = adminBody(BODY_STRUCTURE_LIMITS.maxContainers)
    const admitted = await postAdmin(atBound)
    expect(admitted.status).toBe(400)
    expect(await admitted.json()).toEqual({ error: 'unknown_field' })
    expect(largeParses()).toContain(atBound.length)
  })

  it('refuses a body denser than the structural bound before JSON.parse', async () => {
    // Built before the spy: the builder parses strings of the same length.
    const densest = densestAcceptedV2()
    const largeParses = spyLargeParses()
    const port = listen(createProxyApps(config({ maxBodyBytes: 4096 })))
    const base = measure(bodyWithFiller('codex-completion-request.v2', zeros(1))).structuralBytes
    const count = Math.ceil((BODY_STRUCTURE_LIMITS.maxStructuralBytes + 1 - base) / 2) + 1
    const over = bodyWithFiller('codex-completion-request.v2', zeros(count))
    const structural = base + 2 * (count - 1)
    expect(structural).toBeGreaterThan(BODY_STRUCTURE_LIMITS.maxStructuralBytes)
    expect(structural).toBeLessThanOrEqual(BODY_STRUCTURE_LIMITS.maxStructuralBytes + 2)

    const refused = await post(port, over)
    expect(refused.status).toBe(413)
    expect(await refused.json()).toEqual({ error: 'payload_too_large' })
    expect(largeParses()).not.toContain(over.length)

    // Witness: the densest body the handler itself accepts is parsed.
    const admitted = await post(port, densest)
    expect(admitted.status).toBe(403)
    expect(largeParses()).toContain(densest.length)
  })

  it('never refuses the densest accepted body, compact or whitespace-padded', async () => {
    const port = listen(createProxyApps(config({ maxBodyBytes: 4096 })))
    const densest = densestAcceptedV2()
    expect(measure(densest).structuralBytes).toBeLessThanOrEqual(BODY_STRUCTURE_LIMITS.maxStructuralBytes)
    // One tab after each comma: an indented copy would pass the 24 MiB visual
    // ceiling and be refused by its declared length before any scan.
    const padded = densest.replaceAll(',', ',\t')
    // The padding alone puts the raw body far past the structural bound.
    expect(padded.length).toBeGreaterThan(1.4 * BODY_STRUCTURE_LIMITS.maxStructuralBytes)
    expect(padded.length).toBeLessThanOrEqual(24 * 1024 * 1024)
    for (const body of [densest, padded]) {
      const res = await post(port, body)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'ticket_invalid' })
    }
  })

  it('answers 400 to a body deeper than the envelope bound before JSON.parse', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    const port = listen(createProxyApps(config()))
    const deep = bodyWithDepth(BODY_STRUCTURE_LIMITS.maxDepth + 1)
    const refused = await post(port, deep)
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'invalid_request' })
    expect(parse.mock.calls.map(([text]) => text)).not.toContain(deep)

    const deepest = bodyWithDepth(BODY_STRUCTURE_LIMITS.maxDepth)
    const admitted = await post(port, deepest)
    expect(admitted.status).toBe(403)
    expect(await admitted.json()).toEqual({ error: 'ticket_invalid' })
    expect(parse.mock.calls.map(([text]) => text)).toContain(deepest)
  })

  it('refuses a charset other than UTF-8 with 415', async () => {
    const port = listen(createProxyApps(config()))
    const body = bodyWithFiller('codex-completion-request.v1', '[]')
    const utf16 = await post(port, Uint8Array.from(Buffer.from(body, 'utf16le')), 'application/json; charset=utf-16le')
    expect(utf16.status).toBe(415)
    expect(await utf16.json()).toEqual({ error: 'unsupported_media_type' })
    const latin1 = await post(port, body, 'application/json; charset=latin1')
    expect(latin1.status).toBe(415)
    expect(await latin1.json()).toEqual({ error: 'unsupported_media_type' })
    // Witness: the same body declared as UTF-8 reaches the ticket check.
    const utf8 = await post(port, body, 'application/json; charset=utf-8')
    expect(utf8.status).toBe(403)
    expect(await utf8.json()).toEqual({ error: 'ticket_invalid' })
  })

  it('never logs the raw body of a refused request', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const error = vi.spyOn(logger, 'error')
    const info = vi.spyOn(logger, 'info')
    const port = listen(createProxyApps(config({ maxBodyBytes: 4096 })))
    const over = bodyWithContainers('codex-completion-request.v2', BODY_STRUCTURE_LIMITS.maxContainers + 1, MARKER)
    const refused = await post(port, over)
    expect(refused.status).toBe(413)
    expect(warn).toHaveBeenCalledWith(
      { event: 'codex_proxy_denied', code: 'payload_too_large' },
      'request denied'
    )
    expect(loggedText(warn, error, info)).not.toContain(MARKER)
  })

  it('logs only the type and status of an unmapped verify error', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const error = vi.spyOn(logger, 'error')
    const port = listen(createProxyApps(config()))
    verifyFault.throwPlain = true
    const res = await post(port, bodyWithFiller('codex-completion-request.v1', '[]', { content: MARKER }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
    expect(error).toHaveBeenCalledWith(
      { event: 'codex_proxy_error', type: 'entity.verify.failed', status: 403 },
      'unhandled request error'
    )
    expect(loggedText(warn, error)).not.toContain(MARKER)
  })

  it('passes a visual-gate failure other than a limit to the error handler', async () => {
    const error = vi.spyOn(logger, 'error')
    const fault = new Error('visual gate fault')
    const acquire = vi.spyOn(visualStreamGate, 'acquire').mockRejectedValueOnce(fault)
    const largeParses = spyLargeParses()
    const port = listen(createProxyApps(config({ maxBodyBytes: 4096 })))

    const body = bodyWithContainers('codex-completion-request.v2', 8)
    const padded = `${body}${' '.repeat(4096)}`
    const res = await post(port, padded)
    // The request stops at the error handler; it never reaches the parser or
    // the handler without a body.
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith({ event: 'codex_proxy_error', err: fault }, 'unhandled request error')
    expect(largeParses()).not.toContain(padded.length)
  })

  describe('a demoted visual body (declared above the ordinary cap, compact below it)', () => {
    /**
     * Three ordinary bodies whose budget reservations fill the whole body
     * budget while their streams stay open, so the next reservation must wait.
     */
    async function fillBodyBudget(port: number, maxBodyBytes: number, stream: ReturnType<typeof controlledStream>) {
      const bodies = [0, 1, 2].map(() =>
        bodyWithFiller('codex-completion-request.v1', '[]', { executionTicket: ticket() })
      )
      const pending = bodies.map(body => {
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBodyBytes)
        return post(port, body)
      })
      await waitFor(() => stream.calls.length === 3, 'the ordinary bodies did not reach the stream')
      return pending
    }

    function ordinaryCapFor(): number {
      // The ordinary bodies fill the budget to within a few bytes.
      return Buffer.byteLength(bodyWithFiller('codex-completion-request.v1', '[]', { executionTicket: ticket() })) + 8
    }

    function demotedV2(maxBodyBytes: number, expiresIn = 60): string {
      const compact = bodyWithFiller('codex-completion-request.v2', '[]', { executionTicket: ticket(expiresIn) })
      expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(maxBodyBytes)
      return `${compact}${' '.repeat(maxBodyBytes - Buffer.byteLength(compact) + 1)}`
    }

    it('waits for the body budget before it takes the stream gate', async () => {
      const stream = controlledStream()
      streams.push(stream)
      const maxBodyBytes = ordinaryCapFor()
      const budgetAcquire = vi.spyOn(BodyBudget.prototype, 'acquire')
      const port = listen(createProxyApps(config({ maxBodyBytes }), { streamCompletion: stream.impl }))
      const ordinary = await fillBodyBudget(port, maxBodyBytes, stream)
      expect(budgetAcquire).toHaveBeenCalledTimes(3)

      const demoted = demotedV2(maxBodyBytes)
      const response = post(port, demoted)
      await waitFor(() => budgetAcquire.mock.calls.length === 4, 'the demoted body took no budget')
      expect(budgetAcquire.mock.calls[3][0]).toBe(Buffer.byteLength(demoted.trimEnd()))
      // It holds its visual slot while it waits, and never reached the stream.
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(visualStreamGate.snapshot().running).toBe(1)
      expect(stream.calls).toHaveLength(3)

      // One ordinary body is written upstream, its reservation ends, and the
      // demoted body moves on to the stream gate.
      stream.calls[0].input.onUpstreamAccepted?.()
      await waitFor(() => stream.calls.length === 4, 'the demoted body did not reach the stream')
      expect(visualStreamGate.snapshot().running).toBe(0)
      for (const call of stream.calls) call.finish()
      expect((await response).status).toBe(200)
      for (const res of await Promise.all(ordinary)) expect(res.status).toBe(200)
    })

    it('answers 503 when its ticket dies while it waits for the body budget', async () => {
      const stream = controlledStream()
      streams.push(stream)
      const warn = vi.spyOn(logger, 'warn')
      const maxBodyBytes = ordinaryCapFor()
      const budgetAcquire = vi.spyOn(BodyBudget.prototype, 'acquire')
      const port = listen(createProxyApps(config({ maxBodyBytes }), { streamCompletion: stream.impl }))
      await fillBodyBudget(port, maxBodyBytes, stream)

      const res = await post(port, demotedV2(maxBodyBytes, 2))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'provider_unavailable' })
      expect(budgetAcquire).toHaveBeenCalledTimes(4)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'codex_proxy_admission_refused', reason: 'ticket_life' }),
        'admission refused'
      )
      expect(stream.calls).toHaveLength(3)
      await waitFor(() => visualStreamGate.snapshot().running === 0, 'the visual slot was not released')
    }, 10_000)

    it('refuses for ticket life when the budget deadline fires before the clock reaches exp', async () => {
      const stream = controlledStream()
      streams.push(stream)
      const warn = vi.spyOn(logger, 'warn')
      const maxBodyBytes = ordinaryCapFor()
      // A timer armed for exp can run a millisecond before Date.now() reaches
      // exp. The budget reports that its own deadline ended the wait while the
      // ticket still has two seconds on the clock.
      const budgetAcquire = vi
        .spyOn(BodyBudget.prototype, 'acquire')
        .mockRejectedValueOnce(new RequestLimitError('body admission wait exceeded', 'deadline'))
      const port = listen(createProxyApps(config({ maxBodyBytes }), { streamCompletion: stream.impl }))

      const res = await post(port, demotedV2(maxBodyBytes, 2))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'provider_unavailable' })
      expect(budgetAcquire).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'codex_proxy_admission_refused', reason: 'ticket_life' }),
        'admission refused'
      )
      expect(stream.calls).toHaveLength(0)
      await waitFor(() => visualStreamGate.snapshot().running === 0, 'the visual slot was not released')
    })

    it('does not blame the ticket when the budget queue is full', async () => {
      const stream = controlledStream()
      streams.push(stream)
      const warn = vi.spyOn(logger, 'warn')
      const maxBodyBytes = ordinaryCapFor()
      const budgetAcquire = vi
        .spyOn(BodyBudget.prototype, 'acquire')
        .mockRejectedValueOnce(new RequestLimitError('body admission queue is full', 'queue_full'))
      const port = listen(createProxyApps(config({ maxBodyBytes }), { streamCompletion: stream.impl }))

      const res = await post(port, demotedV2(maxBodyBytes, 2))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'provider_unavailable' })
      // Witness: the refusal came from the budget, the path under test.
      expect(budgetAcquire).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'ticket_life' }),
        expect.anything()
      )
      expect(stream.calls).toHaveLength(0)
      await waitFor(() => visualStreamGate.snapshot().running === 0, 'the visual slot was not released')
    })
  })
})
