import { describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import request from 'supertest'
import {
  LIMITS,
  hashGrokCompletionRequestV1,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import { verifyAdminPermit } from '../src/auth/adminPermitVerifier.js'
import { verifyExecutionTicket } from '../src/auth/executionTicketVerifier.js'
import { type GrokLlmProxyConfig, loadConfig } from '../src/config.js'
import {
  ControlApiClient,
  ControlApiClientError,
  type FinalizeAttemptSuccess,
  type RedeemAttemptSuccess,
} from '../src/controlApiClient.js'
import { MAX_TOOL_CALL_ARGUMENT_CHARS } from '../src/grokTransport.js'
import { REDACT_PATHS, logger } from '../src/logger.js'
import { GROK_CATALOG_ORIGIN, GROK_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import { ENVELOPE_ALLOWANCE_BYTES } from '../src/requestLimits.js'
import { createProxyApps } from '../src/server.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function config(overrides: Partial<GrokLlmProxyConfig> = {}): GrokLlmProxyConfig {
  return {
    runtimePort: 8080,
    adminPort: 8081,
    probePort: 9090,
    maxBodyBytes: 1024,
    maxStreamDurationMs: 300_000,
    maxDeadlineMs: 300_000,
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

function platformToken(overrides: Record<string, unknown> = {}): string {
  return sign(
    {
      sub: 'default/research-host',
      hostRefs: ['research-host'],
      workflowControlScopes: ['llm:grok:execute'],
      scope: 'workflow:approval:request',
      ...overrides,
    },
    'workflow-approvals'
  )
}

function ticket(): string {
  return sign(
    {
      jti: '11111111-1111-4111-8111-111111111111',
      typ: 'grok-execution-ticket',
      hostRef: 'research-host',
      model: 'gpt-5.1',
      requestHash: 'a'.repeat(64),
      providerAttemptId: 'att-1',
    },
    'grok-llm-proxy'
  )
}

function adminPermit(): string {
  return sign(
    { sub: 'admin-1', typ: 'grok-admin-permit', operation: 'catalog_list' },
    'grok-llm-proxy-admin'
  )
}

describe('grok-llm-proxy security surface', () => {
  it('exposes only the frozen runtime, admin, and probe routes', async () => {
    const { runtimeApp, adminApp, probeApp } = createProxyApps(config())
    expect((await request(probeApp).get('/healthz')).status).toBe(200)
    expect((await request(probeApp).get('/readyz')).status).toBe(200)
    const metrics = await request(probeApp).get('/metrics')
    expect(metrics.status).toBe(200)
    expect(metrics.text).not.toMatch(/account|refresh|accessToken/i)
    expect((await request(runtimeApp).get('/internal/runtime/v1/grok/completions')).status).toBe(
      404
    )
    expect((await request(adminApp).get('/internal/admin/v1/grok/models')).status).toBe(404)
  })

  it('denies an admin permit on the runtime listener and a runtime ticket on admin', async () => {
    const { runtimeApp, adminApp } = createProxyApps(config())
    const runtime = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${adminPermit()}`)
      .send({ executionTicket: ticket(), requestHash: 'a'.repeat(64), request: {} })
    expect(runtime.status).toBe(403)
    expect(runtime.body.error).toBe('insufficient_scope')

    const admin = await request(adminApp)
      .post('/internal/admin/v1/grok/models')
      .set('Authorization', `Bearer ${ticket()}`)
      .send({})
    expect(admin.status).toBe(403)
    expect(admin.body.error).toBe('insufficient_scope')
  })

  it('rejects unknown fields, invalid deadlines, and incorrect content types', async () => {
    const { runtimeApp } = createProxyApps(config())
    const unknown = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
        extra: true,
      })
    expect(unknown.body.error).toBe('unknown_field')

    const deadline = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
        deadlineMs: 999_999,
      })
    expect(deadline.body.error).toBe('invalid_request')

    const ctype = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .set('Content-Type', 'text/plain')
      .send('not-json')
    expect(ctype.status).toBe(415)
  })

  it('rejects an oversized body before invoking the completion path', async () => {
    const { runtimeApp } = createProxyApps(config({ maxBodyBytes: 32 }))
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: { pad: 'x'.repeat(200) },
      })
    expect(res.status).toBe(413)
  })

  it('rejects a platform JWT whose hostRefs do not bind the ticket hostRef', async () => {
    const { runtimeApp } = createProxyApps(config())
    const foreign = sign(
      {
        sub: 'default/other-host',
        hostRefs: ['other-host'],
        workflowControlScopes: ['llm:grok:execute'],
        scope: 'workflow:approval:request',
      },
      'workflow-approvals'
    )
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${foreign}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('host_binding_mismatch')
  })

  it('rejects a refresh JWT that otherwise carries llm:grok:execute', async () => {
    const { runtimeApp } = createProxyApps(config())
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken({ scope: 'workflow:approval:refresh' })}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
      })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('rejects a platform JWT that omits the access-token scope', async () => {
    const { runtimeApp } = createProxyApps(config())
    const missingScope = sign(
      {
        sub: 'default/research-host',
        hostRefs: ['research-host'],
        workflowControlScopes: ['llm:grok:execute'],
      },
      'workflow-approvals'
    )
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${missingScope}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
      })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('rejects a platform JWT whose hostRefs is a wildcard', async () => {
    const { runtimeApp } = createProxyApps(config())
    const wildcard = sign(
      {
        sub: 'default/research-host',
        hostRefs: ['*'],
        workflowControlScopes: ['llm:grok:execute'],
        scope: 'workflow:approval:request',
      },
      'workflow-approvals'
    )
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${wildcard}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
      })
    expect(res.status).toBe(401)
  })

  it('rejects execution tickets and admin permits without a numeric exp', () => {
    const cfg = config()
    const ticketNoExp = jwt.sign(
      {
        jti: '11111111-1111-4111-8111-111111111111',
        typ: 'grok-execution-ticket',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: 'a'.repeat(64),
        providerAttemptId: 'att-1',
      },
      privateKey,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'grok-llm-proxy' }
    )
    const permitNoExp = jwt.sign(
      { sub: 'admin-1', typ: 'grok-admin-permit', operation: 'catalog_list' },
      privateKey,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'grok-llm-proxy-admin' }
    )
    expect(verifyExecutionTicket(ticketNoExp, cfg)).toBeNull()
    expect(verifyAdminPermit(permitNoExp, cfg)).toBeNull()
  })

  it('rejects an admin permit whose operation does not match the route', async () => {
    const { adminApp } = createProxyApps(config())
    const wrong = sign(
      { sub: 'admin-1', typ: 'grok-admin-permit', operation: 'connection_test' },
      'grok-llm-proxy-admin'
    )
    const res = await request(adminApp)
      .post('/internal/admin/v1/grok/models')
      .set('Authorization', `Bearer ${wrong}`)
      .send({ accessToken: 'tok' })
    expect(res.status).toBe(401)
  })

  it('rejects missing, zero, and unbounded config', () => {
    expect(() => loadConfig({ GROK_LLM_PROXY_RUNTIME_PORT: '0' })).toThrow(/greater than zero/)
    expect(() =>
      loadConfig({
        GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
        GROK_LLM_PROXY_MAX_BODY_BYTES: '0',
      })
    ).toThrow(/greater than zero/)
    expect(() => loadConfig({})).toThrow(/PEM-encoded public key/)
    expect(() =>
      loadConfig({
        GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
        GROK_LLM_PROXY_MAX_STREAM_DURATION_MS: String(Number.MAX_SAFE_INTEGER),
      })
    ).toThrow(/bounded positive integer/)
  })
})

describe('grok-llm-proxy execution kill switch', () => {
  const lookup = async () => [{ address: '1.2.3.4', family: 4 }]

  function validCompletionBody(): Record<string, unknown> {
    const raw = {
      schemaVersion: 'grok-completion-request.v1',
      requestId: 'req-kill-switch',
      idempotencyKey: 'idem-kill-switch',
      provider: 'grok-subscription',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'hello' }],
    }
    const parsed = parseGrokCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashGrokCompletionRequestV1(parsed.value)
    const executionTicket = sign(
      {
        jti: '33333333-3333-4333-8333-333333333333',
        typ: 'grok-execution-ticket',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash,
        providerAttemptId: 'att-kill-switch',
      },
      'grok-llm-proxy'
    )
    return { executionTicket, requestHash, request: raw }
  }

  function recordingClient(): { client: ControlApiClient; redeems: unknown[] } {
    const redeems: unknown[] = []
    const client = {
      async redeem(input: unknown) {
        redeems.push(input)
        throw new ControlApiClientError('no_grant', 'no grant in kill-switch test')
      },
      async finalize() {
        throw new Error('finalize must not run in kill-switch test')
      },
    } as unknown as ControlApiClient
    return { client, redeems }
  }

  it('returns 404 disabled for a fully valid runtime JWT + ticket when execution is disabled', async () => {
    const body = validCompletionBody()

    // Liveness witness: the identical request reaches redeem when enabled.
    const enabled = recordingClient()
    const live = createProxyApps(config({ executionEnabled: true, maxBodyBytes: 65_536 }), {
      controlApiClient: enabled.client,
      lookup,
    })
    const reached = await request(live.runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send(body)
    expect(reached.status).toBe(403)
    expect(JSON.parse(reached.text)).toEqual({ error: 'no_grant' })
    expect(enabled.redeems).toHaveLength(1)

    const disabled = recordingClient()
    const off = createProxyApps(config({ executionEnabled: false, maxBodyBytes: 65_536 }), {
      controlApiClient: disabled.client,
      lookup,
    })
    const res = await request(off.runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send(body)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'disabled' })
    expect(disabled.redeems).toHaveLength(0)
  })

  it('returns 404 disabled for a valid admin permit when execution is disabled', async () => {
    const upstream = () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-5.1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    // Liveness witness: the identical admin call reaches the catalog upstream when enabled.
    let enabledCalls = 0
    const live = createProxyApps(config({ executionEnabled: true, maxBodyBytes: 65_536 }), {
      fetchFn: (async () => {
        enabledCalls += 1
        return upstream()
      }) as typeof fetch,
      lookup,
    })
    const reached = await request(live.adminApp)
      .post('/internal/admin/v1/grok/models')
      .set('Authorization', `Bearer ${adminPermit()}`)
      .send({ accessToken: 'tok' })
    expect(reached.status).toBe(200)
    expect(reached.body.outcome).toBe('ready')
    expect(enabledCalls).toBe(1)

    let disabledCalls = 0
    const off = createProxyApps(config({ executionEnabled: false, maxBodyBytes: 65_536 }), {
      fetchFn: (async () => {
        disabledCalls += 1
        return upstream()
      }) as typeof fetch,
      lookup,
    })
    const res = await request(off.adminApp)
      .post('/internal/admin/v1/grok/models')
      .set('Authorization', `Bearer ${adminPermit()}`)
      .send({ accessToken: 'tok' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'disabled' })
    expect(disabledCalls).toBe(0)
  })
})

describe('grok-llm-proxy startup config', () => {
  const base = {
    GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
    GROK_LLM_PROXY_CONTROL_API_URL:
      'http://control-api-rpc-gateway.control-plane.svc.cluster.local:8090/api/v1',
    GROK_LLM_PROXY_CONTROL_API_TOKEN: 'dev-grok-llm-proxy-token',
  }

  it('loads a complete environment', () => {
    const loaded = loadConfig(base)
    expect(loaded.controlApiBaseUrl).toBe(base.GROK_LLM_PROXY_CONTROL_API_URL)
    expect(loaded.controlApiServiceToken).toBe('dev-grok-llm-proxy-token')
    expect(loaded.controlApiServiceName).toBe('grok-llm-proxy')
  })

  // #731 — the envelope carries the contract-capped `request` plus the ticket,
  // the hash and the deadline. A body limit equal to the contract cap refuses,
  // as a 413, requests the contract itself accepts.
  it('T-R2-6b-grok defaults the body limit to the contract request cap plus a 16 KiB envelope allowance', () => {
    expect(loadConfig(base).maxBodyBytes).toBe(LIMITS.maxRequestBodyBytes + 16 * 1024)
  })

  // R9-3 (L-3) — a lower override would answer 413 to requests the contract
  // accepts, so it is refused at startup.
  it('T-R9-3-grok refuses a body limit below the contract request cap plus the envelope allowance', () => {
    const floor = LIMITS.maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES
    expect(() => loadConfig({ ...base, GROK_LLM_PROXY_MAX_BODY_BYTES: String(floor - 1) })).toThrow(
      'GROK_LLM_PROXY_MAX_BODY_BYTES must be at least the contract request cap plus the envelope allowance'
    )
    expect(() =>
      loadConfig({ ...base, GROK_LLM_PROXY_MAX_BODY_BYTES: String(LIMITS.maxRequestBodyBytes) })
    ).toThrow(/GROK_LLM_PROXY_MAX_BODY_BYTES must be at least/)
    // Witness: the floor itself and any larger value load.
    expect(loadConfig({ ...base, GROK_LLM_PROXY_MAX_BODY_BYTES: String(floor) }).maxBodyBytes).toBe(floor)
    expect(loadConfig({ ...base, GROK_LLM_PROXY_MAX_BODY_BYTES: String(floor + 1) }).maxBodyBytes).toBe(
      floor + 1
    )
  })

  it('T-R2-6c-grok does not refuse a request at the contract cap with a real ticket as payload_too_large', async () => {
    const { runtimeApp } = createProxyApps(config({ maxBodyBytes: loadConfig(base).maxBodyBytes }))
    const atCap = { pad: 'x'.repeat(LIMITS.maxRequestBodyBytes - '{"pad":""}'.length) }
    expect(Buffer.byteLength(JSON.stringify(atCap), 'utf8')).toBe(LIMITS.maxRequestBodyBytes)
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send({ executionTicket: ticket(), requestHash: 'a'.repeat(64), request: atCap })
    expect(res.body.error).not.toBe('payload_too_large')
    expect(res.status).not.toBe(413)
    // Witness: the body parser accepted the envelope and the route answered.
    expect(typeof res.body.error).toBe('string')
  })

  it.each([undefined, '', '   '])('fails at startup when the control-api URL is %j', value => {
    expect(() => loadConfig({ ...base, GROK_LLM_PROXY_CONTROL_API_URL: value })).toThrow(
      /GROK_LLM_PROXY_CONTROL_API_URL/
    )
  })

  it.each(['not a url', 'ftp://control-api/api/v1', 'file:///etc/passwd'])(
    'fails at startup when the control-api URL %j is not http(s)',
    value => {
      expect(() => loadConfig({ ...base, GROK_LLM_PROXY_CONTROL_API_URL: value })).toThrow(
        /GROK_LLM_PROXY_CONTROL_API_URL/
      )
    }
  )

  it.each([undefined, '', '   '])(
    'fails at startup when the control-api service token is %j',
    value => {
      expect(() => loadConfig({ ...base, GROK_LLM_PROXY_CONTROL_API_TOKEN: value })).toThrow(
        /GROK_LLM_PROXY_CONTROL_API_TOKEN/
      )
    }
  )
})

describe('grok-llm-proxy attempt telemetry', () => {
  const lookup = async () => [{ address: '1.2.3.4', family: 4 }]
  // Keys that carry caller content. The attempt line is identifiers and counts;
  // none of these may ever reach it. The four names this suite has always
  // checked are joined by every leaf the service itself redacts, so a value the
  // logger would scrub cannot be declared safe here merely because this list
  // forgot it — `accessToken` and `attemptReceipt` both come back from the
  // redeem fixture below.
  const FORBIDDEN_LOG_KEYS = [
    ...new Set([
      'body',
      'request',
      'executionTicket',
      'arguments',
      ...REDACT_PATHS.map(
        redacted =>
          redacted
            .replace(/\['([^']+)'\]/g, '.$1')
            .split('.')
            .pop() as string
      ).filter(key => key !== '*'),
    ]),
  ]

  function completionBody(
    providerAttemptId: string,
    tamper?: (raw: Record<string, unknown>) => void
  ): Record<string, unknown> {
    const raw: Record<string, unknown> = {
      schemaVersion: 'grok-completion-request.v1',
      requestId: `req-${providerAttemptId}`,
      idempotencyKey: `idem-${providerAttemptId}`,
      provider: 'grok-subscription',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'hello' }],
    }
    const parsed = parseGrokCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashGrokCompletionRequestV1(parsed.value)
    // Applied after hashing: the ticket stays bound to the untampered request,
    // so the transport's parser rejects the body before any hash comparison.
    tamper?.(raw)
    const executionTicket = sign(
      {
        jti: '55555555-5555-4555-8555-555555555555',
        typ: 'grok-execution-ticket',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash,
        providerAttemptId,
      },
      'grok-llm-proxy'
    )
    return { executionTicket, requestHash, request: raw }
  }

  function grantingClient(): { client: ControlApiClient; receipts: unknown[] } {
    const receipts: unknown[] = []
    const client = {
      async redeem(): Promise<RedeemAttemptSuccess> {
        return {
          accessToken: 'test-access-telemetry',
          transport: {
            protocolVersion: 'grok-subscription-transport.v1',
            completionsOrigin: GROK_COMPLETIONS_ORIGIN,
            catalogOrigin: GROK_CATALOG_ORIGIN,
            operation: 'completion_stream',
            servedModel: 'gpt-5.1',
            maxStreamDurationMs: 300_000,
          },
          expiryClass: 'short_lived',
          attemptReceipt: 'c'.repeat(64),
        }
      },
      async finalize(input: {
        receipt: { outcome: FinalizeAttemptSuccess['outcome'] }
      }): Promise<FinalizeAttemptSuccess> {
        receipts.push(input.receipt)
        return { providerAttemptId: 'att', outcome: input.receipt.outcome, duplicate: false }
      },
    } as unknown as ControlApiClient
    return { client, receipts }
  }

  function upstream(textDeltas: number, calls: number): typeof fetch {
    const frames: string[] = []
    for (let index = 0; index < textDeltas; index += 1) {
      frames.push(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: `t${index}` })}\n\n`
      )
    }
    for (let index = 0; index < calls; index += 1) {
      frames.push(
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: { type: 'function_call', id: `call-${index}`, name: 'lookup', arguments: '{}' },
        })}\n\n`
      )
    }
    frames.push('data: {"type":"response.completed"}\n\n')
    return (async () =>
      new Response(frames.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch
  }

  // One SSE block larger than the transport's 1 MiB buffer and never terminated,
  // so the buffer guard fires before any frame is delivered.
  function unterminatedUpstream(): typeof fetch {
    return (async () =>
      new Response(`data: ${'x'.repeat(1_100_000)}`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch
  }

  // One tool call whose `arguments` deltas add up past the retained budget,
  // delivered one frame per read so the 1 MiB SSE buffer guard — which only
  // bounds the unparsed tail between two `\n\n` boundaries — never fires and
  // the argument budget is the guard under test.
  const ARGUMENT_OVERRUN_CHUNK = 65_536

  function oversizedArgumentsUpstream(): typeof fetch {
    const chunks = MAX_TOOL_CALL_ARGUMENT_CHARS / ARGUMENT_OVERRUN_CHUNK + 1
    const frames = [
      `data: ${JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'call-args', name: 'lookup', arguments: '' },
      })}\n\n`,
      ...Array.from(
        { length: chunks },
        () =>
          `data: ${JSON.stringify({
            type: 'response.function_call_arguments.delta',
            item_id: 'call-args',
            delta: 'a'.repeat(ARGUMENT_OVERRUN_CHUNK),
          })}\n\n`
      ),
      'data: {"type":"response.completed"}\n\n',
    ]
    const encoder = new TextEncoder()
    return (async () => {
      let index = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = frames[index]
          index += 1
          if (next === undefined) controller.close()
          else controller.enqueue(encoder.encode(next))
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
  }

  // One call whose `arguments` are truncated JSON, closed by a completed response.
  function malformedArgumentsUpstream(): typeof fetch {
    const frames = [
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'call-bad', name: 'lookup', arguments: '{"q":' },
      })}\n\n`,
      'data: {"type":"response.completed"}\n\n',
    ]
    return (async () =>
      new Response(frames.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch
  }

  function denyingClient(code: string): ControlApiClient {
    return {
      async redeem() {
        throw new ControlApiClientError(code, 'control API request denied')
      },
      async finalize() {
        throw new Error('finalize must not run after a denied redeem')
      },
    } as unknown as ControlApiClient
  }

  function failureCount(metricsText: string, code: string): number {
    const line = metricsText
      .split('\n')
      .find(row => row.startsWith(`grok_proxy_attempt_failures_total{code="${code}"}`))
    return line ? Number(line.split(' ').pop()) : 0
  }

  async function run(options: {
    providerAttemptId: string
    textDeltas?: number
    calls?: number
    tamper?: (raw: Record<string, unknown>) => void
    deniedCode?: string
    fetchFn?: typeof fetch
  }) {
    const info = vi.spyOn(logger, 'info')
    const warn = vi.spyOn(logger, 'warn')
    const { client, receipts } = grantingClient()
    const apps = createProxyApps(config({ maxBodyBytes: 65_536 }), {
      controlApiClient: options.deniedCode ? denyingClient(options.deniedCode) : client,
      fetchFn: options.fetchFn ?? upstream(options.textDeltas ?? 0, options.calls ?? 0),
      lookup,
    })
    try {
      const res = await request(apps.runtimeApp)
        .post('/internal/runtime/v1/grok/completions')
        .set('Authorization', `Bearer ${platformToken()}`)
        .send(completionBody(options.providerAttemptId, options.tamper))
      const metricsText = (await request(apps.probeApp).get('/metrics')).text
      const lines = [...info.mock.calls, ...warn.mock.calls]
        .map(call => call[0] as unknown as Record<string, unknown>)
        .filter(entry => entry?.event === 'grok_proxy_attempt_finished')
      return { res, receipts, lines, metricsText }
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  }

  /** Returns how many keys it inspected, so an empty payload cannot pass. */
  function walkForbiddenKeys(value: unknown, trail: string): number {
    if (Array.isArray(value)) {
      return value.reduce<number>(
        (total, item, index) => total + walkForbiddenKeys(item, `${trail}[${index}]`),
        0
      )
    }
    if (value === null || typeof value !== 'object') return 0
    let visited = 0
    for (const [key, nested] of Object.entries(value)) {
      visited += 1
      if (FORBIDDEN_LOG_KEYS.includes(key)) {
        throw new Error(`log line carries the forbidden key ${trail}.${key}`)
      }
      visited += walkForbiddenKeys(nested, `${trail}.${key}`)
    }
    return visited
  }

  function expectNoForbiddenKeys(line: Record<string, unknown>): void {
    // A flat check would clear `details` and `usage` without ever opening them.
    const visited = walkForbiddenKeys(line, 'line')
    // Liveness witness: a walk over an empty or non-object payload inspects
    // nothing and would otherwise report the line as clean.
    expect(visited).toBeGreaterThan(0)
  }

  it('(a) answers 422 and logs one attempt line when 257 calls arrive before any text', async () => {
    const { res, receipts, lines, metricsText } = await run({
      providerAttemptId: 'att-limit-http',
      calls: 257,
    })
    expect(res.status).toBe(422)
    // The staged SSE headers are replaced by a JSON response.
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.body).toEqual({ error: 'tool_call_limit_exceeded' })
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-limit-http',
      outcome: 'failed',
      code: 'tool_call_limit_exceeded',
      reason: 'tool calls exceed 256',
      details: { limit: 256, observed: 257 },
      deliveredAs: 'http_status',
      httpStatus: 422,
      toolCalls: 0,
      textChunks: 0,
    })
    expectNoForbiddenKeys(lines[0]!)
    expect(failureCount(metricsText, 'tool_call_limit_exceeded')).toBe(1)
  })

  // A call count within `maxToolCalls` says nothing about the size of each
  // call. This refusal has to reach the Host as a 422 with its own code: a 503
  // would be classified as an overload and retried with the same oversized
  // response.
  it('(a1) answers 422 when one call’s arguments exceed the retained budget', async () => {
    const { res, receipts, lines, metricsText } = await run({
      providerAttemptId: 'att-args-http',
      fetchFn: oversizedArgumentsUpstream(),
    })
    expect(res.status).toBe(422)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ error: 'tool_call_arguments_exceeded' })
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-args-http',
      outcome: 'failed',
      code: 'tool_call_arguments_exceeded',
      details: {
        limit: MAX_TOOL_CALL_ARGUMENT_CHARS,
        observed: MAX_TOOL_CALL_ARGUMENT_CHARS + ARGUMENT_OVERRUN_CHUNK,
      },
      deliveredAs: 'http_status',
      httpStatus: 422,
      toolCalls: 0,
      textChunks: 0,
    })
    // The refusal text names the bound, never the arguments that tripped it.
    expectNoForbiddenKeys(lines[0]!)
    expect(failureCount(metricsText, 'tool_call_arguments_exceeded')).toBe(1)
  })

  // Arguments that are not a JSON object are invalid model output. The refusal
  // has to reach the Host as a 422 with its own code and metric label: the 503
  // default would be classified as an overload and retried.
  it('(a1b) answers 422 invalid_tool_arguments when a call’s arguments are not a JSON object', async () => {
    const { res, receipts, lines, metricsText } = await run({
      providerAttemptId: 'att-bad-args-http',
      fetchFn: malformedArgumentsUpstream(),
    })
    expect(res.status).toBe(422)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ error: 'invalid_tool_arguments' })
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-bad-args-http',
      outcome: 'failed',
      code: 'invalid_tool_arguments',
      deliveredAs: 'http_status',
      httpStatus: 422,
      toolCalls: 0,
      textChunks: 0,
    })
    expectNoForbiddenKeys(lines[0]!)
    // The attempt line names the refusal, never the arguments that caused it.
    expect(JSON.stringify(lines[0])).not.toContain('{\\"q\\":')
    expect(failureCount(metricsText, 'invalid_tool_arguments')).toBe(1)
    expect(failureCount(metricsText, 'other')).toBe(0)
  })

  it('(a2) sends an SSE error frame when text was already streamed', async () => {
    const { res, lines } = await run({
      providerAttemptId: 'att-limit-sse',
      textDeltas: 1,
      calls: 257,
    })
    expect(res.status).toBe(200)
    expect(res.text).toContain('data: {"type":"text","text":"t0"}')
    expect(res.text).toContain('data: {"type":"error","code":"tool_call_limit_exceeded"}')
    expect(res.text).not.toContain('"type":"tool_call"')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      outcome: 'failed',
      code: 'tool_call_limit_exceeded',
      deliveredAs: 'sse_error',
      textChunks: 1,
      toolCalls: 0,
    })
    expect('httpStatus' in lines[0]!).toBe(false)
    expectNoForbiddenKeys(lines[0]!)
  })

  it('(b) logs the counted frames of a successful attempt', async () => {
    const { res, lines, metricsText } = await run({
      providerAttemptId: 'att-success',
      calls: 3,
    })
    expect(res.status).toBe(200)
    expect(res.text).toContain('"type":"done","outcome":"success"')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-success',
      outcome: 'success',
      deliveredAs: 'sse_done',
      toolCalls: 3,
      textChunks: 0,
    })
    expectNoForbiddenKeys(lines[0]!)
    // Witness: the attempt was counted, so the absent failure sample is meaningful.
    expect(metricsText).toMatch(
      /grok_llm_proxy_attempts_total\{outcome="success",operation="completion_stream"\} 1/
    )
    expect(failureCount(metricsText, 'tool_call_limit_exceeded')).toBe(0)
  })

  it('(c) serves a post-staging invalid request as JSON without the parse message', async () => {
    const secretField = 'sk-live-0123456789abcdef'
    const { res, lines } = await run({
      providerAttemptId: 'att-invalid',
      tamper: raw => {
        ;(raw.messages as Record<string, unknown>[])[0]![secretField] = 'x'
      },
    })
    // This error is raised inside the transport, after the SSE headers were
    // staged. The route's four earlier rejections run before that staging and
    // already answer JSON, so only this one proves the repair.
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.body).toEqual({ error: 'invalid_request' })
    // Witness: the attempt line is still emitted for the rejected request.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-invalid',
      outcome: 'failed',
      code: 'invalid_request',
      deliveredAs: 'http_status',
      httpStatus: 400,
    })
    // The parser's message names caller-supplied fields, so it is withheld.
    expect('reason' in lines[0]!).toBe(false)
    expect(JSON.stringify(lines[0])).not.toContain(secretField)
    expectNoForbiddenKeys(lines[0]!)
  })

  it('(d) labels the failure metric with a known transport code', async () => {
    const { res, lines, metricsText } = await run({
      providerAttemptId: 'att-buffer',
      fetchFn: unterminatedUpstream(),
    })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'sse_buffer_exceeded' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      outcome: 'failed',
      code: 'sse_buffer_exceeded',
      httpStatus: 503,
    })
    expect(failureCount(metricsText, 'sse_buffer_exceeded')).toBe(1)
    expect(failureCount(metricsText, 'other')).toBe(0)
  })

  it('(e) labels an unknown control-api code as other and keeps the raw code in the log', async () => {
    const rawCode = 'k8s says: pod foo not found'
    const { res, lines, metricsText } = await run({
      providerAttemptId: 'att-unknown-code',
      deniedCode: rawCode,
    })
    expect(res.status).toBe(503)
    // Witness: the attempt failed and was logged with the code control-api sent.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ outcome: 'failed', code: rawCode, httpStatus: 503 })
    expect(failureCount(metricsText, 'other')).toBe(1)
    expect(metricsText).not.toContain(rawCode)
  })

  // `ATTEMPT_ERROR_STATUS` is an object literal, so an inherited name resolves
  // to a function or an object instead of undefined. A plain index read would
  // hand that value to `res.status()`, which throws ERR_HTTP_INVALID_STATUS_CODE
  // inside the request IIFE's catch — an unhandled rejection that takes every
  // other in-flight stream down with the process.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    '(f) answers 503 for the inherited control-api code %j instead of crashing',
    async code => {
      const { res, lines, metricsText } = await run({
        providerAttemptId: `att-proto-${code}`,
        deniedCode: code,
      })
      expect(res.status).toBe(503)
      expect(res.body).toEqual({ error: code })
      // Witness: the attempt was reached and logged, so the status above is the
      // mapped refusal and not a connection that never produced a response.
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ outcome: 'failed', code, httpStatus: 503 })
      expect(failureCount(metricsText, 'other')).toBe(1)
      expect(failureCount(metricsText, code)).toBe(0)
    }
  )
})
