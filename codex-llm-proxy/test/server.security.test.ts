import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import {
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import { describe, expect, it, vi } from 'vitest'
import { verifyAdminPermit } from '../src/auth/adminPermitVerifier.js'
import { verifyExecutionTicket } from '../src/auth/executionTicketVerifier.js'
import { loadConfig, type CodexLlmProxyConfig } from '../src/config.js'
import {
  ControlApiClient,
  ControlApiClientError,
  type FinalizeAttemptSuccess,
  type RedeemAttemptSuccess,
} from '../src/controlApiClient.js'
import { logger } from '../src/logger.js'
import { CODEX_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import { createProxyApps } from '../src/server.js'

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
    maxBodyBytes: 1024,
    maxStreamDurationMs: 300_000,
    maxDeadlineMs: 300_000,
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

function platformToken(overrides: Record<string, unknown> = {}): string {
  return sign(
    {
      sub: 'default/research-host',
      hostRefs: ['research-host'],
      workflowControlScopes: ['llm:codex:execute'],
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
      typ: 'codex-execution-ticket',
      hostRef: 'research-host',
      model: 'gpt-5.1',
      requestHash: 'a'.repeat(64),
      providerAttemptId: 'att-1',
    },
    'codex-llm-proxy'
  )
}

function adminPermit(): string {
  return sign(
    { sub: 'admin-1', typ: 'codex-admin-permit', operation: 'catalog_list' },
    'codex-llm-proxy-admin'
  )
}

describe('codex-llm-proxy security surface', () => {
  it('exposes only the frozen runtime, admin, and probe routes', async () => {
    const { runtimeApp, adminApp, probeApp } = createProxyApps(config())
    expect((await request(probeApp).get('/healthz')).status).toBe(200)
    expect((await request(probeApp).get('/readyz')).status).toBe(200)
    const metrics = await request(probeApp).get('/metrics')
    expect(metrics.status).toBe(200)
    expect(metrics.text).not.toMatch(/account|refresh|accessToken/i)
    expect((await request(runtimeApp).get('/internal/runtime/v1/codex/completions')).status).toBe(404)
    expect((await request(adminApp).get('/internal/admin/v1/codex/models')).status).toBe(404)
  })

  it('denies an admin permit on the runtime listener and a runtime ticket on admin', async () => {
    const { runtimeApp, adminApp } = createProxyApps(config())
    const runtime = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
      .set('Authorization', `Bearer ${adminPermit()}`)
      .send({ executionTicket: ticket(), requestHash: 'a'.repeat(64), request: {} })
    expect(runtime.status).toBe(403)
    expect(runtime.body.error).toBe('insufficient_scope')

    const admin = await request(adminApp)
      .post('/internal/admin/v1/codex/models')
      .set('Authorization', `Bearer ${ticket()}`)
      .send({})
    expect(admin.status).toBe(403)
    expect(admin.body.error).toBe('insufficient_scope')
  })

  it('rejects unknown fields, invalid deadlines, and incorrect content types', async () => {
    const { runtimeApp } = createProxyApps(config())
    const unknown = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
        extra: true,
      })
    expect(unknown.body.error).toBe('unknown_field')

    const deadline = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
        deadlineMs: 999_999,
      })
    expect(deadline.body.error).toBe('invalid_request')

    const ctype = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
      .set('Authorization', `Bearer ${platformToken()}`)
      .set('Content-Type', 'text/plain')
      .send('not-json')
    expect(ctype.status).toBe(415)
  })

  it('rejects an oversized body before invoking the completion path', async () => {
    const { runtimeApp } = createProxyApps(config({ maxBodyBytes: 32 }))
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
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
        workflowControlScopes: ['llm:codex:execute'],
        scope: 'workflow:approval:request',
      },
      'workflow-approvals'
    )
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
      .set('Authorization', `Bearer ${foreign}`)
      .send({
        executionTicket: ticket(),
        requestHash: 'a'.repeat(64),
        request: {},
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('host_binding_mismatch')
  })

  it('rejects a refresh JWT that otherwise carries llm:codex:execute', async () => {
    const { runtimeApp } = createProxyApps(config())
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
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
        workflowControlScopes: ['llm:codex:execute'],
      },
      'workflow-approvals'
    )
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
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
        workflowControlScopes: ['llm:codex:execute'],
        scope: 'workflow:approval:request',
      },
      'workflow-approvals'
    )
    const res = await request(runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
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
        typ: 'codex-execution-ticket',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: 'a'.repeat(64),
        providerAttemptId: 'att-1',
      },
      privateKey,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'codex-llm-proxy' }
    )
    const permitNoExp = jwt.sign(
      { sub: 'admin-1', typ: 'codex-admin-permit', operation: 'catalog_list' },
      privateKey,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'codex-llm-proxy-admin' }
    )
    expect(verifyExecutionTicket(ticketNoExp, cfg)).toBeNull()
    expect(verifyAdminPermit(permitNoExp, cfg)).toBeNull()
  })

  it('rejects an admin permit whose operation does not match the route', async () => {
    const { adminApp } = createProxyApps(config())
    const wrong = sign(
      { sub: 'admin-1', typ: 'codex-admin-permit', operation: 'connection_test' },
      'codex-llm-proxy-admin'
    )
    const res = await request(adminApp)
      .post('/internal/admin/v1/codex/models')
      .set('Authorization', `Bearer ${wrong}`)
      .send({ accessToken: 'tok' })
    expect(res.status).toBe(401)
  })

  it('rejects missing, zero, and unbounded config', () => {
    expect(() => loadConfig({ CODEX_LLM_PROXY_RUNTIME_PORT: '0' })).toThrow(/greater than zero/)
    expect(() =>
      loadConfig({
        CODEX_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
        CODEX_LLM_PROXY_MAX_BODY_BYTES: '0',
      })
    ).toThrow(/greater than zero/)
    expect(() => loadConfig({})).toThrow(/PEM-encoded public key/)
    expect(() =>
      loadConfig({
        CODEX_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
        CODEX_LLM_PROXY_MAX_STREAM_DURATION_MS: String(Number.MAX_SAFE_INTEGER),
      })
    ).toThrow(/bounded positive integer/)
  })
})

describe('codex-llm-proxy execution kill switch', () => {
  const lookup = async () => [{ address: '1.2.3.4', family: 4 }]

  function validCompletionBody(): Record<string, unknown> {
    const raw = {
      schemaVersion: 'codex-completion-request.v1',
      requestId: 'req-kill-switch',
      idempotencyKey: 'idem-kill-switch',
      provider: 'codex-subscription',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'hello' }],
    }
    const parsed = parseCodexCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashCodexCompletionRequestV1(parsed.value)
    const executionTicket = sign(
      {
        jti: '33333333-3333-4333-8333-333333333333',
        typ: 'codex-execution-ticket',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash,
        providerAttemptId: 'att-kill-switch',
      },
      'codex-llm-proxy'
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
      .post('/internal/runtime/v1/codex/completions')
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
      .post('/internal/runtime/v1/codex/completions')
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
      .post('/internal/admin/v1/codex/models')
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
      .post('/internal/admin/v1/codex/models')
      .set('Authorization', `Bearer ${adminPermit()}`)
      .send({ accessToken: 'tok' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'disabled' })
    expect(disabledCalls).toBe(0)
  })
})

describe('codex-llm-proxy startup config', () => {
  const base = {
    CODEX_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
    CODEX_LLM_PROXY_CONTROL_API_URL:
      'http://control-api-rpc-gateway.control-plane.svc.cluster.local:8090/api/v1',
    CODEX_LLM_PROXY_CONTROL_API_TOKEN: 'dev-codex-llm-proxy-token',
  }

  it('loads a complete environment', () => {
    const loaded = loadConfig(base)
    expect(loaded.controlApiBaseUrl).toBe(base.CODEX_LLM_PROXY_CONTROL_API_URL)
    expect(loaded.controlApiServiceToken).toBe('dev-codex-llm-proxy-token')
    expect(loaded.controlApiServiceName).toBe('codex-llm-proxy')
  })

  it.each([undefined, '', '   '])(
    'fails at startup when the control-api URL is %j',
    value => {
      expect(() => loadConfig({ ...base, CODEX_LLM_PROXY_CONTROL_API_URL: value })).toThrow(
        /CODEX_LLM_PROXY_CONTROL_API_URL/
      )
    }
  )

  it.each(['not a url', 'ftp://control-api/api/v1', 'file:///etc/passwd'])(
    'fails at startup when the control-api URL %j is not http(s)',
    value => {
      expect(() => loadConfig({ ...base, CODEX_LLM_PROXY_CONTROL_API_URL: value })).toThrow(
        /CODEX_LLM_PROXY_CONTROL_API_URL/
      )
    }
  )

  it.each([undefined, '', '   '])(
    'fails at startup when the control-api service token is %j',
    value => {
      expect(() => loadConfig({ ...base, CODEX_LLM_PROXY_CONTROL_API_TOKEN: value })).toThrow(
        /CODEX_LLM_PROXY_CONTROL_API_TOKEN/
      )
    }
  )
})

describe('codex-llm-proxy attempt telemetry', () => {
  const lookup = async () => [{ address: '1.2.3.4', family: 4 }]
  const FORBIDDEN_LOG_KEYS = ['body', 'request', 'executionTicket', 'arguments']

  function completionBody(providerAttemptId: string): Record<string, unknown> {
    const raw = {
      schemaVersion: 'codex-completion-request.v1',
      requestId: `req-${providerAttemptId}`,
      idempotencyKey: `idem-${providerAttemptId}`,
      provider: 'codex-subscription',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'hello' }],
    }
    const parsed = parseCodexCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashCodexCompletionRequestV1(parsed.value)
    const executionTicket = sign(
      {
        jti: '44444444-4444-4444-8444-444444444444',
        typ: 'codex-execution-ticket',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash,
        providerAttemptId,
      },
      'codex-llm-proxy'
    )
    return { executionTicket, requestHash, request: raw }
  }

  function grantingClient(): { client: ControlApiClient; receipts: unknown[] } {
    const receipts: unknown[] = []
    const claims = Buffer.from(
      JSON.stringify({
        sub: 'telemetry',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_live_1' },
      })
    ).toString('base64url')
    const client = {
      async redeem(): Promise<RedeemAttemptSuccess> {
        return {
          accessToken: `hdr.${claims}.sig`,
          transport: {
            protocolVersion: 'codex-subscription-transport.v1',
            completionsOrigin: CODEX_COMPLETIONS_ORIGIN,
            catalogOrigin: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
            operation: 'completion_stream',
            servedModel: 'gpt-5.1',
            maxStreamDurationMs: 300_000,
          },
          expiryClass: 'short_lived',
          attemptReceipt: 'a'.repeat(64),
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

  function failureCount(metricsText: string, code: string): number {
    const line = metricsText
      .split('\n')
      .find(row => row.startsWith(`codex_proxy_attempt_failures_total{code="${code}"}`))
    return line ? Number(line.split(' ').pop()) : 0
  }

  async function run(providerAttemptId: string, textDeltas: number, calls: number) {
    const info = vi.spyOn(logger, 'info')
    const warn = vi.spyOn(logger, 'warn')
    const { client, receipts } = grantingClient()
    const apps = createProxyApps(config({ maxBodyBytes: 65_536 }), {
      controlApiClient: client,
      fetchFn: upstream(textDeltas, calls),
      lookup,
    })
    try {
      const res = await request(apps.runtimeApp)
        .post('/internal/runtime/v1/codex/completions')
        .set('Authorization', `Bearer ${platformToken()}`)
        .send(completionBody(providerAttemptId))
      const metricsText = (await request(apps.probeApp).get('/metrics')).text
      const lines = [...info.mock.calls, ...warn.mock.calls]
        .map(call => call[0] as unknown as Record<string, unknown>)
        .filter(entry => entry?.event === 'codex_proxy_attempt_finished')
      return { res, receipts, lines, metricsText }
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  }

  function expectNoForbiddenKeys(line: Record<string, unknown>): void {
    for (const key of FORBIDDEN_LOG_KEYS) expect(key in line).toBe(false)
  }

  it('(a) answers 422 and logs one attempt line when 65 calls arrive before any text', async () => {
    const { res, receipts, lines, metricsText } = await run('att-limit-http', 0, 65)
    expect(res.status).toBe(422)
    // The SSE content-type is set before streaming starts, so parse the text.
    expect(JSON.parse(res.text)).toEqual({ error: 'tool_call_limit_exceeded' })
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-limit-http',
      outcome: 'failed',
      code: 'tool_call_limit_exceeded',
      reason: 'tool calls exceed 64',
      details: { limit: 64, observed: 65 },
      deliveredAs: 'http_status',
      httpStatus: 422,
      toolCalls: 0,
      textChunks: 0,
    })
    expectNoForbiddenKeys(lines[0]!)
    expect(failureCount(metricsText, 'tool_call_limit_exceeded')).toBe(1)
  })

  it('(b) sends an SSE error frame when text was already streamed', async () => {
    const { res, lines } = await run('att-limit-sse', 1, 65)
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

  it('(c) logs the counted frames of a successful attempt', async () => {
    const { res, lines, metricsText } = await run('att-success', 0, 3)
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
      /codex_llm_proxy_attempts_total\{outcome="success",operation="completion_stream"\} 1/
    )
    expect(failureCount(metricsText, 'tool_call_limit_exceeded')).toBe(0)
  })
})
