import { describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import {
  ENVELOPE_ALLOWANCE_BYTES as CONTRACT_ENVELOPE_ALLOWANCE_BYTES,
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
import { MAX_TOOL_CALL_ARGUMENT_BYTES } from '../src/grokTransport.js'
import { REDACT_PATHS, logger } from '../src/logger.js'
import { GROK_CATALOG_ORIGIN, GROK_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import {
  BodyBudget,
  DEFAULT_MAX_BODY_BYTES,
  ENVELOPE_ALLOWANCE_BYTES,
  RequestLimitError,
  STREAM_LIMITS,
  streamGate,
} from '../src/requestLimits.js'
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
        deadlineMs: 1_800_001,
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
    expect(() =>
      loadConfig({
        GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
        GROK_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS: '0',
      })
    ).toThrow(/GROK_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS must be a finite integer greater than zero/)
  })

  it('defaults the upstream idle timeout to the published STREAM_LIMITS value', () => {
    const loaded = loadConfig({
      GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
      GROK_LLM_PROXY_CONTROL_API_URL: 'http://control-api:8080',
      GROK_LLM_PROXY_CONTROL_API_TOKEN: 'service-token',
    })
    expect(loaded.upstreamIdleTimeoutMs).toBe(600_000)
    expect(
      loadConfig({
        GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
        GROK_LLM_PROXY_CONTROL_API_URL: 'http://control-api:8080',
        GROK_LLM_PROXY_CONTROL_API_TOKEN: 'service-token',
        GROK_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS: '45000',
      }).upstreamIdleTimeoutMs
    ).toBe(45_000)
  })

  it('defaults the total stream cap and the deadline ceiling to 30 min', () => {
    const loaded = loadConfig({
      GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
      GROK_LLM_PROXY_CONTROL_API_URL: 'http://control-api:8080',
      GROK_LLM_PROXY_CONTROL_API_TOKEN: 'service-token',
    })
    expect(loaded.maxStreamDurationMs).toBe(1_800_000)
    expect(loaded.maxDeadlineMs).toBe(1_800_000)
  })

  it('defaults the SSE heartbeat to 15 s and rejects a non-positive interval', () => {
    const env = {
      GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
      GROK_LLM_PROXY_CONTROL_API_URL: 'http://control-api:8080',
      GROK_LLM_PROXY_CONTROL_API_TOKEN: 'service-token',
    }
    expect(loadConfig(env).heartbeatIntervalMs).toBe(15_000)
    expect(
      loadConfig({ ...env, GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS: '5000' }).heartbeatIntervalMs
    ).toBe(5_000)
    for (const raw of ['0', '-1']) {
      expect(() => loadConfig({ ...env, GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS: raw })).toThrow(
        /GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS must be a finite integer greater than zero/
      )
    }
  })

  it('refuses at startup a heartbeat interval the Host HTTP client would time out on', () => {
    const env = {
      GROK_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
      GROK_LLM_PROXY_CONTROL_API_URL: 'http://control-api:8080',
      GROK_LLM_PROXY_CONTROL_API_TOKEN: 'service-token',
    }
    // The bound itself is accepted, so the refusal below is the bound and not
    // a parse failure.
    expect(
      loadConfig({ ...env, GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS: '60000' }).heartbeatIntervalMs
    ).toBe(60_000)
    for (const raw of ['60001', '600000']) {
      expect(() => loadConfig({ ...env, GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS: raw })).toThrow(
        /GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS must be at most 60000/
      )
    }
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

  // R11 — the allowance has one source, the contract, shared with control-api
  // and mcp-host. A literal here could drift from theirs.
  it('T-R11-grok takes the envelope allowance from the contract', () => {
    expect(CONTRACT_ENVELOPE_ALLOWANCE_BYTES).toBe(16 * 1024)
    expect(ENVELOPE_ALLOWANCE_BYTES).toBe(CONTRACT_ENVELOPE_ALLOWANCE_BYTES)
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

  function grantingClient(maxStreamDurationMs = 1_800_000): {
    client: ControlApiClient
    receipts: unknown[]
  } {
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
            maxStreamDurationMs,
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
    const chunks = MAX_TOOL_CALL_ARGUMENT_BYTES / ARGUMENT_OVERRUN_CHUNK + 1
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

  // The upstream's context-window refusal recorded on 2026-09-23 (R10): an
  // HTTP 400 before any stream, with the marker inside the `error` string.
  function contextOverflowUpstream(): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          code: 'invalid-argument',
          error:
            "Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (1107771 tokens > 500000 tokens)",
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch
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

  // Sends `textDeltas` frames, then never sends another byte. The body ignores
  // the fetch signal, like a peer that stops writing without closing.
  function stalledUpstream(textDeltas: number): typeof fetch {
    return (async () => {
      const encoder = new TextEncoder()
      let sent = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent < textDeltas) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: `t${sent}` })}\n\n`
                )
              )
              sent += 1
              return undefined
            }
            return new Promise<void>(() => undefined)
          },
        },
        { highWaterMark: 0 }
      )
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
  }

  function failureCount(metricsText: string, code: string): number {
    const line = metricsText
      .split('\n')
      .find(row => row.startsWith(`grok_proxy_attempt_failures_total{code="${code}"}`))
    return line ? Number(line.split(' ').pop()) : 0
  }

  function timeoutCount(metricsText: string, kind: 'idle' | 'total'): number {
    const line = metricsText
      .split('\n')
      .find(row => row.startsWith(`grok_proxy_upstream_timeouts_total{kind="${kind}"}`))
    return line ? Number(line.split(' ').pop()) : 0
  }

  function keepaliveCount(text: string): number {
    return text.split(': keepalive\n\n').length - 1
  }

  // Stays silent for `silentMs` after the fetch resolves, then streams one text
  // delta and completes, like a model that reasons before its first token.
  function silentThenCompletingUpstream(silentMs: number): typeof fetch {
    return (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await new Promise(resolve => setTimeout(resolve, silentMs))
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"t0"}\n\n' +
                  'data: {"type":"response.completed"}\n\n'
              )
            )
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as typeof fetch
  }

  // Answers `status` with no SSE body after `delayMs`.
  function slowFailingUpstream(delayMs: number, status: number): typeof fetch {
    return (async () => {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return new Response('upstream failed', { status })
    }) as typeof fetch
  }

  // Denies the redeem after `delayMs`, which is longer than the heartbeat
  // interval the caller configures.
  function slowDenyingClient(code: string, delayMs: number): {
    client: ControlApiClient
    redeemCalls: () => number
  } {
    let calls = 0
    const client = {
      async redeem() {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, delayMs))
        throw new ControlApiClientError(code, 'control API request denied')
      },
      async finalize() {
        throw new Error('finalize must not run after a denied redeem')
      },
    } as unknown as ControlApiClient
    return { client, redeemCalls: () => calls }
  }

  async function run(options: {
    providerAttemptId: string
    textDeltas?: number
    calls?: number
    tamper?: (raw: Record<string, unknown>) => void
    deniedCode?: string
    fetchFn?: typeof fetch
    maxStreamDurationMs?: number
    configOverrides?: Partial<GrokLlmProxyConfig>
    controlApiClient?: ControlApiClient
  }) {
    const info = vi.spyOn(logger, 'info')
    const warn = vi.spyOn(logger, 'warn')
    const { client, receipts } = grantingClient(options.maxStreamDurationMs)
    const apps = createProxyApps(config({ maxBodyBytes: 65_536, ...options.configOverrides }), {
      controlApiClient:
        options.controlApiClient ??
        (options.deniedCode ? denyingClient(options.deniedCode) : client),
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
        limit: MAX_TOOL_CALL_ARGUMENT_BYTES,
        observed: MAX_TOOL_CALL_ARGUMENT_BYTES + ARGUMENT_OVERRUN_CHUNK,
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

  // R10 (M1): the upstream context overflow reaches the Host as a 400 with its
  // own code and metric label. The 503 default would be classified as an
  // overload and retried with the identical conversation.
  it('(a1c) T-R10-2 answers 400 context_length_exceeded for the upstream context overflow', async () => {
    const { res, receipts, lines, metricsText } = await run({
      providerAttemptId: 'att-context-http',
      fetchFn: contextOverflowUpstream(),
    })
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ error: 'context_length_exceeded' })
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-context-http',
      outcome: 'failed',
      code: 'context_length_exceeded',
      deliveredAs: 'http_status',
      httpStatus: 400,
      toolCalls: 0,
      textChunks: 0,
    })
    expectNoForbiddenKeys(lines[0]!)
    expect(failureCount(metricsText, 'context_length_exceeded')).toBe(1)
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

  it('(t1) answers 504 stream_duration_exceeded when the total cap fires before any frame', async () => {
    const { res, receipts, lines, metricsText } = await run({
      providerAttemptId: 'att-total-http',
      fetchFn: stalledUpstream(0),
      maxStreamDurationMs: 100,
    })
    expect(res.status).toBe(504)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ error: 'stream_duration_exceeded' })
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-total-http',
      outcome: 'failed',
      code: 'stream_duration_exceeded',
      reason: 'upstream stream exceeded maxStreamDurationMs',
      details: { limitMs: 100 },
      deliveredAs: 'http_status',
      httpStatus: 504,
    })
    expectNoForbiddenKeys(lines[0]!)
    expect(failureCount(metricsText, 'stream_duration_exceeded')).toBe(1)
    expect(failureCount(metricsText, 'other')).toBe(0)
    expect(timeoutCount(metricsText, 'total')).toBe(1)
    expect(timeoutCount(metricsText, 'idle')).toBe(0)
  })

  it('(t2) sends a stream_duration_exceeded SSE frame when text was already streamed', async () => {
    const { res, lines } = await run({
      providerAttemptId: 'att-total-sse',
      fetchFn: stalledUpstream(1),
      maxStreamDurationMs: 100,
    })
    expect(res.status).toBe(200)
    expect(res.text).toContain('data: {"type":"text","text":"t0"}')
    expect(res.text).toContain('data: {"type":"error","code":"stream_duration_exceeded"}')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      outcome: 'failed',
      code: 'stream_duration_exceeded',
      deliveredAs: 'sse_error',
      textChunks: 1,
    })
    expect('httpStatus' in lines[0]!).toBe(false)
  })

  it('(t3) answers 503 provider_unavailable and counts an idle timeout on a silent upstream', async () => {
    const { res, receipts, lines, metricsText } = await run({
      providerAttemptId: 'att-idle-http',
      fetchFn: stalledUpstream(0),
      configOverrides: { upstreamIdleTimeoutMs: 50 },
    })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'provider_unavailable' })
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-idle-http',
      outcome: 'failed',
      code: 'provider_unavailable',
      reason: 'upstream stream idle timeout',
      details: { idleTimeoutMs: 50 },
      deliveredAs: 'http_status',
      httpStatus: 503,
    })
    expect(failureCount(metricsText, 'provider_unavailable')).toBe(1)
    expect(timeoutCount(metricsText, 'idle')).toBe(1)
    expect(timeoutCount(metricsText, 'total')).toBe(0)
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

  it('(rl1) logs the request-limit reason and labels its failure metric request_limit', async () => {
    const acquire = vi
      .spyOn(streamGate, 'acquire')
      .mockRejectedValueOnce(new RequestLimitError('stream queue is full'))
    try {
      const { res, receipts, lines, metricsText } = await run({ providerAttemptId: 'att-queue-full' })
      // Witness: the refusal came from the stream gate this test replaced.
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(res.status).toBe(503)
      expect(res.body).toEqual({ error: 'provider_unavailable' })
      // The gate refused before the redeem, so there is no receipt to finalize.
      expect(receipts).toEqual([])
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        providerAttemptId: 'att-queue-full',
        outcome: 'failed',
        code: 'provider_unavailable',
        reason: 'stream queue is full',
        deliveredAs: 'http_status',
        httpStatus: 503,
      })
      expectNoForbiddenKeys(lines[0]!)
      expect(failureCount(metricsText, 'request_limit')).toBe(1)
      expect(failureCount(metricsText, 'provider_unavailable')).toBe(0)
    } finally {
      acquire.mockRestore()
    }
  })

  it('(hb1) keeps a silent upstream attempt open with SSE comments and counts them', async () => {
    const { res, lines } = await run({
      providerAttemptId: 'att-heartbeat',
      fetchFn: silentThenCompletingUpstream(100),
      configOverrides: { heartbeatIntervalMs: 20 },
    })
    expect(res.status).toBe(200)
    const firstData = res.text.indexOf('data:')
    expect(firstData).toBeGreaterThan(0)
    expect(keepaliveCount(res.text.slice(0, firstData))).toBeGreaterThanOrEqual(2)
    expect(res.text).toContain('data: {"type":"text","text":"t0"}')
    // Nothing is written after the done frame.
    expect(res.text.endsWith('data: {"type":"done","outcome":"success"}\n\n')).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      providerAttemptId: 'att-heartbeat',
      outcome: 'success',
      deliveredAs: 'sse_done',
      heartbeats: keepaliveCount(res.text),
    })
  })

  it('(hb2) sends no keepalive before the redeem succeeds, so a denial keeps its HTTP status', async () => {
    const denied = slowDenyingClient('no_grant', 60)
    const { res, lines } = await run({
      providerAttemptId: 'att-heartbeat-denied',
      controlApiClient: denied.client,
      configOverrides: { heartbeatIntervalMs: 20 },
    })
    // Witness: the redeem ran and outlasted three heartbeat intervals.
    expect(denied.redeemCalls()).toBe(1)
    expect(res.status).toBe(403)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ error: 'no_grant' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      code: 'no_grant',
      deliveredAs: 'http_status',
      httpStatus: 403,
      heartbeats: 0,
    })
  })

  it('(hb3) delivers an upstream failure after a keepalive as an SSE error frame', async () => {
    const { res, lines } = await run({
      providerAttemptId: 'att-heartbeat-failed',
      fetchFn: slowFailingUpstream(60, 500),
      configOverrides: { heartbeatIntervalMs: 20 },
    })
    expect(res.status).toBe(200)
    expect(keepaliveCount(res.text)).toBeGreaterThanOrEqual(1)
    expect(res.text.endsWith('data: {"type":"error","code":"provider_unavailable"}\n\n')).toBe(
      true
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      outcome: 'failed',
      code: 'provider_unavailable',
      deliveredAs: 'sse_error',
      heartbeats: keepaliveCount(res.text),
    })
    expect('httpStatus' in lines[0]!).toBe(false)
  })

  // Node drops a write on a closed response without an error, so a heartbeat
  // the server never stops is invisible on the wire: it is an interval that
  // outlives its attempt. The test tracks the timers themselves.
  it('(hb4) clears every heartbeat timer once the attempt ends and keeps serving', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      uncaught.push(err)
    }
    const realSetInterval = globalThis.setInterval
    const heartbeatTimers: unknown[] = []
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: () => void,
      ms?: number
    ) => {
      const timer = realSetInterval(handler, ms)
      // 5 ms is the interval this test configures; nothing else uses it.
      if (ms === 5) heartbeatTimers.push(timer)
      return timer
    }) as unknown as typeof setInterval)
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    process.on('uncaughtException', onUncaught)
    try {
      const first = await run({
        providerAttemptId: 'att-heartbeat-end',
        fetchFn: silentThenCompletingUpstream(30),
        configOverrides: { heartbeatIntervalMs: 5 },
      })
      // Witness: the heartbeat was running while the upstream was silent.
      expect(keepaliveCount(first.res.text)).toBeGreaterThanOrEqual(1)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
      const second = await run({
        providerAttemptId: 'att-heartbeat-next',
        textDeltas: 1,
        configOverrides: { heartbeatIntervalMs: 5 },
      })
      expect(second.res.status).toBe(200)
      expect(second.res.text).toContain('data: {"type":"done","outcome":"success"}')
      // Witness: each attempt started its own heartbeat.
      expect(heartbeatTimers).toHaveLength(2)
      const cleared = clearSpy.mock.calls.map(call => call[0])
      for (const timer of heartbeatTimers) expect(cleared).toContain(timer)
    } finally {
      process.off('uncaughtException', onUncaught)
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})

/**
 * #739 D1-bis — the stream-gate wait also ends when the execution ticket dies.
 * A request still queued at the ticket's `exp` could only be redeemed into a
 * certain `ticket_expired`, so it is answered as a capacity refusal instead,
 * with no redeem. The margin is zero: a request whose ticket is still alive
 * when a slot frees is served exactly as before.
 */
describe('grok-llm-proxy ticket-aware stream-gate wait (#739 D1-bis)', () => {
  /** Captured before any test fakes the clock, so waits stay on real time. */
  const realSetTimeout = globalThis.setTimeout
  const realSleep = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms))
  const lookup = async () => [{ address: '1.2.3.4', family: 4 }]
  const COMPLETIONS = '/internal/runtime/v1/grok/completions'

  async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = performance.now() + 5_000
    while (!condition()) {
      if (performance.now() > deadline) throw new Error(`${what} did not happen within 5 s`)
      await realSleep(10)
    }
  }

  function withinReal<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return Promise.race([promise, realSleep(ms).then(() => undefined)])
  }

  /** An envelope whose ticket expires exactly `ticketLifeMs` from the (fake) now. */
  function envelope(providerAttemptId: string, ticketLifeMs: number): Record<string, unknown> {
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
    const executionTicket = jwt.sign(
      {
        jti: '77777777-7777-4777-8777-777777777777',
        typ: 'grok-execution-ticket',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash,
        providerAttemptId,
        exp: (Date.now() + ticketLifeMs) / 1000,
      },
      privateKey,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'grok-llm-proxy' }
    )
    return { executionTicket, requestHash, request: raw }
  }

  function countingClient(redeemAnswer: 'granted' | 'ticket_expired'): {
    client: ControlApiClient
    redeems: () => number
  } {
    let redeems = 0
    const client = {
      async redeem(): Promise<RedeemAttemptSuccess> {
        redeems += 1
        if (redeemAnswer === 'ticket_expired') {
          throw new ControlApiClientError('ticket_expired', 'control API request denied')
        }
        return {
          accessToken: 'test-access-ticket-life',
          transport: {
            protocolVersion: 'grok-subscription-transport.v1',
            completionsOrigin: GROK_COMPLETIONS_ORIGIN,
            catalogOrigin: GROK_CATALOG_ORIGIN,
            operation: 'completion_stream',
            servedModel: 'gpt-5.1',
            maxStreamDurationMs: 1_800_000,
          },
          expiryClass: 'short_lived',
          attemptReceipt: 'd'.repeat(64),
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
    return { client, redeems: () => redeems }
  }

  const upstream = (async () =>
    new Response(
      'data: {"type":"response.output_text.delta","delta":"t0"}\n\n' +
        'data: {"type":"response.completed"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )) as typeof fetch

  function failureCount(metricsText: string, code: string): number {
    const line = metricsText
      .split('\n')
      .find(row => row.startsWith(`grok_proxy_attempt_failures_total{code="${code}"}`))
    return line ? Number(line.split(' ').pop()) : 0
  }

  /** Fakes the clock on a whole second, so a ticket's `exp` lands on an exact instant. */
  function fakeClock(): void {
    vi.useFakeTimers({
      now: Math.ceil(Date.now() / 1000) * 1000,
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    })
  }

  /**
   * Frees the held slots and lets any waiter still polling the shared gate
   * finish on the fake clock, so the module gate is empty for the next test.
   */
  async function releaseAndDrain(slots: Array<() => void>): Promise<void> {
    for (const release of slots.splice(0)) release()
    await vi.advanceTimersByTimeAsync(STREAM_LIMITS.maxQueueWaitMs)
    vi.useRealTimers()
  }

  async function saturate(): Promise<Array<() => void>> {
    const slots: Array<() => void> = []
    for (let i = 0; i < STREAM_LIMITS.maxConcurrentStreams; i += 1) {
      slots.push(await streamGate.acquire())
    }
    return slots
  }

  it('T-AC-5-grok answers 503 provider_unavailable at the ticket expiry, without a redeem, while the gate stays saturated', async () => {
    fakeClock()
    const warn = vi.spyOn(logger, 'warn')
    let slots: Array<() => void> = []
    let acquire: ReturnType<typeof vi.spyOn> | undefined
    try {
      slots = await saturate()
      // Pass-through spy: it only counts the handler's calls into the gate.
      const spy = vi.spyOn(streamGate, 'acquire')
      acquire = spy
      const control = countingClient('ticket_expired')
      const apps = createProxyApps(config({ maxBodyBytes: 65_536 }), {
        controlApiClient: control.client,
        fetchFn: upstream,
        lookup,
      })
      const ticketLifeMs = 20_000
      const reply = request(apps.runtimeApp)
        .post(COMPLETIONS)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send(envelope('att-ticket-life', ticketLifeMs))
        .then(res => res)
      await until(() => spy.mock.calls.length === 1, 'the request queueing at the stream gate')

      await vi.advanceTimersByTimeAsync(ticketLifeMs - 1)
      // Witness: the request waited for the ticket's whole life, it was not
      // refused on arrival.
      expect(await withinReal(reply, 100)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      const res = await withinReal(reply, 2_000)
      expect(res?.status).toBe(503)
      expect(res?.body).toEqual({ error: 'provider_unavailable' })

      // A slot that frees after the ticket died is never used to redeem it.
      slots.pop()?.()
      await vi.advanceTimersByTimeAsync(STREAM_LIMITS.maxQueueWaitMs)
      expect(control.redeems()).toBe(0)

      const refusals = warn.mock.calls
        .map(call => call[0] as unknown as Record<string, unknown>)
        .filter(entry => entry?.event === 'grok_proxy_admission_refused')
      expect(refusals).toEqual([
        {
          event: 'grok_proxy_admission_refused',
          reason: 'ticket_life',
          providerAttemptId: 'att-ticket-life',
          hostRef: 'research-host',
        },
      ])
      const metricsText = (await request(apps.probeApp).get('/metrics')).text
      expect(failureCount(metricsText, 'provider_unavailable')).toBe(1)
      expect(failureCount(metricsText, 'request_limit')).toBe(0)
    } finally {
      acquire?.mockRestore()
      await releaseAndDrain(slots)
      warn.mockRestore()
    }
  }, 30_000)

  it('T-PAR-TK-grok serves a request whose ticket is still alive when the gate frees at +50 s of a 60 s ticket', async () => {
    fakeClock()
    let slots: Array<() => void> = []
    let acquire: ReturnType<typeof vi.spyOn> | undefined
    try {
      slots = await saturate()
      const spy = vi.spyOn(streamGate, 'acquire')
      acquire = spy
      const control = countingClient('granted')
      const apps = createProxyApps(config({ maxBodyBytes: 65_536 }), {
        controlApiClient: control.client,
        fetchFn: upstream,
        lookup,
      })
      const reply = request(apps.runtimeApp)
        .post(COMPLETIONS)
        .set('Authorization', `Bearer ${platformToken()}`)
        .send(envelope('att-ticket-alive', 60_000))
        .then(res => res)
      await until(() => spy.mock.calls.length === 1, 'the request queueing at the stream gate')

      await vi.advanceTimersByTimeAsync(50_000)
      expect(await withinReal(reply, 100)).toBeUndefined()
      slots.pop()?.()
      // One stream-gate poll interval.
      await vi.advanceTimersByTimeAsync(10)
      const res = await withinReal(reply, 2_000)
      expect(res?.status).toBe(200)
      expect(res?.text).toContain('data: {"type":"text","text":"t0"}')
      expect(res?.text).toContain('data: {"type":"done","outcome":"success"}')
      expect(control.redeems()).toBe(1)
    } finally {
      acquire?.mockRestore()
      await releaseAndDrain(slots)
    }
  }, 30_000)
})

/**
 * #739 D2 — a body's budget reservation covers the phase in which several
 * copies of it are alive: reading, parsing, hashing and forwarding. That phase
 * ends when the upstream fetch resolves, because the whole request body has
 * been written by then. The reservation is released there instead of when the
 * SSE stream closes; the response's `close` event stays the backstop for every
 * path that never reaches the upstream.
 */
describe('grok-llm-proxy body budget release on upstream acceptance (#739 D2)', () => {
  const lookup = async () => [{ address: '1.2.3.4', family: 4 }]
  const COMPLETIONS = '/internal/runtime/v1/grok/completions'
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = performance.now() + 10_000
    while (!condition()) {
      if (performance.now() > deadline) throw new Error(`${what} did not happen within 10 s`)
      await sleep(10)
    }
  }

  /** A runtime envelope with one user message of `contentChars` and a 60 s ticket. */
  function completionBody(
    contentChars: number,
    providerAttemptId: string,
    executionTicket?: string
  ): string {
    const raw = {
      schemaVersion: 'grok-completion-request.v1',
      requestId: `req-${providerAttemptId}`,
      idempotencyKey: `idem-${providerAttemptId}`,
      provider: 'grok-subscription',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'x'.repeat(contentChars) }],
    }
    const parsed = parseGrokCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashGrokCompletionRequestV1(parsed.value)
    return JSON.stringify({
      executionTicket:
        executionTicket ??
        sign(
          {
            jti: '88888888-8888-4888-8888-888888888888',
            typ: 'grok-execution-ticket',
            hostRef: 'research-host',
            model: 'gpt-5.1',
            requestHash,
            providerAttemptId,
          },
          'grok-llm-proxy'
        ),
      requestHash,
      request: raw,
    })
  }

  function controlClient(redeemAnswer: 'granted' | 'ticket_expired'): {
    client: ControlApiClient
    redeems: () => number
  } {
    let redeems = 0
    const client = {
      async redeem(): Promise<RedeemAttemptSuccess> {
        redeems += 1
        if (redeemAnswer === 'ticket_expired') {
          throw new ControlApiClientError('ticket_expired', 'control API request denied')
        }
        return {
          accessToken: 'test-access-body-release',
          transport: {
            protocolVersion: 'grok-subscription-transport.v1',
            completionsOrigin: GROK_COMPLETIONS_ORIGIN,
            catalogOrigin: GROK_CATALOG_ORIGIN,
            operation: 'completion_stream',
            servedModel: 'gpt-5.1',
            maxStreamDurationMs: 1_800_000,
          },
          expiryClass: 'short_lived',
          attemptReceipt: 'e'.repeat(64),
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
    return { client, redeems: () => redeems }
  }

  type UpstreamProbe = {
    fetchFn: typeof fetch
    calls: () => number
    /** True once the signal the proxy gave the upstream fetch has aborted. */
    aborted: () => boolean
  }

  function upstreamProbe(answer: (signal: AbortSignal) => Promise<Response>): UpstreamProbe {
    let calls = 0
    let seen: AbortSignal | undefined
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls += 1
      const signal = init?.signal
      if (!signal) throw new Error('the upstream fetch carried no abort signal')
      seen = signal
      return answer(signal)
    }) as typeof fetch
    return { fetchFn, calls: () => calls, aborted: () => seen?.aborted === true }
  }

  /** Answers headers and one text delta, then stays open until the fetch aborts. */
  function openStreamUpstream(): UpstreamProbe {
    return upstreamProbe(
      async signal =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","delta":"t0"}\n\n'
                )
              )
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              })
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
    )
  }

  /** Never answers: the fetch stays pending until it aborts. */
  function pendingUpstream(): UpstreamProbe {
    return upstreamProbe(
      signal =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
  }

  /**
   * The runtime app on a real listener, so an SSE stream can be observed while
   * it is still open. The body budget is private to `createProxyApps`; a
   * pass-through spy on `BodyBudget.prototype.acquire` records the instance.
   */
  async function listeningProxy(client: ControlApiClient, fetchFn: typeof fetch) {
    const acquire = vi.spyOn(BodyBudget.prototype, 'acquire')
    const apps = createProxyApps(config({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES }), {
      controlApiClient: client,
      fetchFn,
      lookup,
    })
    let closes = 0
    apps.runtime.on('request', (_req, res) => {
      res.once('close', () => {
        closes += 1
      })
    })
    await new Promise<void>(resolve => apps.runtime.listen(0, '127.0.0.1', () => resolve()))
    const { port } = apps.runtime.address() as AddressInfo
    return {
      port,
      /** Declared sizes the body budget was asked for, in call order. */
      reservations: () => acquire.mock.calls.map(call => call[0]),
      budget: (): BodyBudget => {
        const instance = acquire.mock.contexts[0]
        if (!(instance instanceof BodyBudget)) throw new Error('no body reached the body budget')
        return instance
      },
      /** Responses whose `close` event fired. */
      closes: () => closes,
      close: async () => {
        acquire.mockRestore()
        await apps.close()
      },
    }
  }

  /** POSTs `payload` with a declared length and records the reply as it arrives. */
  function open(port: number, payload: string) {
    let status: number | undefined
    let received = ''
    let ended = false
    const errors: Error[] = []
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: COMPLETIONS,
        agent: false,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${platformToken()}`,
          'content-length': Buffer.byteLength(payload),
        },
      },
      res => {
        status = res.statusCode
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          received += chunk
        })
        res.on('end', () => {
          ended = true
        })
      }
    )
    // Recorded, not ignored: a test that destroys the request expects one.
    req.on('error', err => errors.push(err))
    req.end(payload)
    return {
      status: () => status,
      received: () => received,
      ended: () => ended,
      errors: () => errors,
      destroy: () => req.destroy(),
    }
  }

  it('T-BR-1-grok releases the reservation of a near-cap body once the upstream accepted it, while the SSE stream is still open', async () => {
    const control = controlClient('granted')
    const upstream = openStreamUpstream()
    const proxy = await listeningProxy(control.client, upstream.fetchFn)
    const payload = completionBody(Math.floor(LIMITS.maxRequestBodyBytes * 0.99), 'att-br-1')
    const bytes = Buffer.byteLength(payload)
    // Fixture check: the body is near the 8 MiB cap and still admitted by it.
    expect(bytes).toBeGreaterThan(LIMITS.maxRequestBodyBytes * 0.99)
    expect(bytes).toBeLessThanOrEqual(DEFAULT_MAX_BODY_BYTES)
    const client = open(proxy.port, payload)
    try {
      // Witness: the first frame reached the client, so the upstream accepted
      // the request and the stream is live.
      await until(
        () => client.received().includes('data: {"type":"text","text":"t0"}'),
        'the first SSE frame'
      )
      expect(client.status()).toBe(200)
      expect(client.ended()).toBe(false)
      expect(upstream.calls()).toBe(1)
      expect(control.redeems()).toBe(1)
      expect(proxy.reservations()).toEqual([bytes])
      expect(proxy.budget().inFlightBytes).toBe(0)
    } finally {
      client.destroy()
      await proxy.close()
    }
  }, 30_000)

  it('T-BR-2-grok keeps the reservation while the upstream fetch is pending and releases it when the client leaves', async () => {
    const control = controlClient('granted')
    const upstream = pendingUpstream()
    const proxy = await listeningProxy(control.client, upstream.fetchFn)
    const payload = completionBody(64, 'att-br-2')
    const bytes = Buffer.byteLength(payload)
    const client = open(proxy.port, payload)
    try {
      // Witness: the attempt was redeemed and its upstream fetch started.
      await until(() => upstream.calls() === 1, 'the upstream fetch')
      expect(control.redeems()).toBe(1)
      expect(proxy.reservations()).toEqual([bytes])
      // Not released early: the fetch has not resolved, so the body may still
      // be being written.
      expect(proxy.budget().inFlightBytes).toBe(bytes)

      client.destroy()
      await until(() => upstream.aborted(), 'the client abort reaching the upstream fetch')
      await until(() => proxy.budget().inFlightBytes === 0, 'the reservation release')
      expect(client.status()).toBeUndefined()
    } finally {
      client.destroy()
      await proxy.close()
    }
  }, 30_000)

  it('T-BR-3a-grok releases the reservation of a request refused 403 ticket_invalid when its response closes', async () => {
    const control = controlClient('granted')
    const upstream = openStreamUpstream()
    const proxy = await listeningProxy(control.client, upstream.fetchFn)
    const payload = completionBody(64, 'att-br-3a', 'not-a-signed-ticket')
    const client = open(proxy.port, payload)
    try {
      await until(() => client.ended(), 'the refusal')
      expect(client.status()).toBe(403)
      expect(JSON.parse(client.received())).toEqual({ error: 'ticket_invalid' })
      await until(() => proxy.closes() === 1, "the response's close event")
      expect(client.errors()).toEqual([])
      expect(proxy.reservations()).toEqual([Buffer.byteLength(payload)])
      expect(control.redeems()).toBe(0)
      expect(proxy.budget().inFlightBytes).toBe(0)
    } finally {
      await proxy.close()
    }
  }, 30_000)

  it('T-BR-3b-grok releases the reservation of a request refused 503 by a full stream gate when its response closes', async () => {
    const control = controlClient('granted')
    const upstream = openStreamUpstream()
    const proxy = await listeningProxy(control.client, upstream.fetchFn)
    const slots: Array<() => void> = []
    const queueAbort = new AbortController()
    const waiters: Array<Promise<() => void>> = []
    try {
      for (let i = 0; i < STREAM_LIMITS.maxConcurrentStreams; i += 1) {
        slots.push(await streamGate.acquire())
      }
      for (let i = 0; i < STREAM_LIMITS.maxQueuedRequests; i += 1) {
        waiters.push(streamGate.acquire(queueAbort.signal))
      }
      // Fixture check: the gate has no snapshot, so a probe shows the queue is full.
      await expect(streamGate.acquire()).rejects.toMatchObject({
        name: 'RequestLimitError',
        message: 'stream queue is full',
      })
      const payload = completionBody(64, 'att-br-3b')
      const client = open(proxy.port, payload)
      await until(() => client.ended(), 'the refusal')
      expect(client.status()).toBe(503)
      expect(JSON.parse(client.received())).toEqual({ error: 'provider_unavailable' })
      await until(() => proxy.closes() === 1, "the response's close event")
      expect(client.errors()).toEqual([])
      expect(proxy.reservations()).toEqual([Buffer.byteLength(payload)])
      expect(control.redeems()).toBe(0)
      expect(proxy.budget().inFlightBytes).toBe(0)
    } finally {
      queueAbort.abort()
      await Promise.allSettled(waiters)
      for (const release of slots.splice(0)) release()
      await proxy.close()
    }
  }, 30_000)

  it('T-BR-3c-grok releases the reservation of a request whose redeem failed when its response closes', async () => {
    const control = controlClient('ticket_expired')
    const upstream = openStreamUpstream()
    const proxy = await listeningProxy(control.client, upstream.fetchFn)
    const payload = completionBody(64, 'att-br-3c')
    const client = open(proxy.port, payload)
    try {
      await until(() => client.ended(), 'the refusal')
      expect(client.status()).toBe(403)
      expect(JSON.parse(client.received())).toEqual({ error: 'ticket_expired' })
      await until(() => proxy.closes() === 1, "the response's close event")
      expect(client.errors()).toEqual([])
      // Witness: the path reached the redeem and stopped before the upstream.
      expect(control.redeems()).toBe(1)
      expect(upstream.calls()).toBe(0)
      expect(proxy.reservations()).toEqual([Buffer.byteLength(payload)])
      expect(proxy.budget().inFlightBytes).toBe(0)
    } finally {
      await proxy.close()
    }
  }, 30_000)
})
