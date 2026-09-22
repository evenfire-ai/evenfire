/**
 * Hermetic runtime-path e2e (Grok port of
 * codex-llm-proxy/test/runtimePath.hermetic.e2e.test.ts): authorize (mocked
 * control-api redeem) → proxy runtime listener → REAL loopback Grok fixture
 * upstream (an HTTP server on 127.0.0.1 that streams Responses-shaped SSE) →
 * finalize receipt.
 *
 * The full proxy pipeline (platform JWT, execution ticket, request-hash
 * freeze, execution kill switch, origin policy, tool-name mapping, SSE mapping,
 * finalize contract) runs unmocked. Only two injection seams are substituted,
 * both wired to live infrastructure in production:
 *   - ControlApiClient (redeem/finalize) — an in-memory grant table standing
 *     in for control-api's Grok authorizer, keyed by the recipe-shaped hostRef.
 *   - fetchFn/lookup — the frozen cli-chat-proxy.grok.com origin is still
 *     asserted by the unmodified origin policy; only the socket is pointed at
 *     the loopback fixture. No live Grok OAuth or SuperGrok call is made.
 *
 * Unlike the Codex suite there is no shared tests/e2e Grok fixture upstream
 * yet, so the fixture lives in-process here and speaks plain HTTP on loopback
 * (no TLS material needed); the streamed body is still read from a real socket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import {
  hashGrokCompletionRequestV1,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import type { GrokLlmProxyConfig } from '../src/config.js'
import {
  type ControlApiClient,
  ControlApiClientError,
  type FinalizeAttemptSuccess,
  type RedeemAttemptSuccess,
} from '../src/controlApiClient.js'
import { GROK_UPSTREAM_USER_AGENT } from '../src/grokUpstreamHeaders.js'
import { GROK_CATALOG_ORIGIN, GROK_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import { type ProxyServers, createProxyApps } from '../src/server.js'

const ACCESS_TOKEN = 'test-access-hermetic-grok'
const MODEL = 'grok-4-fast'
const RECIPE_HOST_REF = 'sandbox-recipes/e2e-grok-recipe'
const CONNECTED_GRANTS: Record<string, { connectionKey: string; models: string[] }> = {
  [RECIPE_HOST_REF]: { connectionKey: 'e2e-supergrok', models: [MODEL] },
}

// Optional-field MCP tool: only `key` is required. The upstream simulates the
// model calling it; the proxy must carry these exact arguments back.
const UPDATE_TOOL = {
  name: 'eventasks__workitem_update',
  description: 'Update a work item.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      description: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['key'],
  },
}
const CALL_ARGUMENTS = { key: 'BUG-1', description: 'Updated description' }

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function config(overrides: Partial<GrokLlmProxyConfig> = {}): GrokLlmProxyConfig {
  return {
    runtimePort: 0,
    adminPort: 0,
    probePort: 0,
    maxBodyBytes: 1_048_576,
    maxStreamDurationMs: 30_000,
    maxDeadlineMs: 30_000,
    jwtIssuer: 'control-api',
    jwtPublicKey: publicKey,
    executionEnabled: true,
    controlApiBaseUrl: 'http://control-api.invalid/api/v1',
    controlApiServiceName: 'grok-llm-proxy',
    controlApiServiceToken: 'unused-in-hermetic-e2e',
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

function platformToken(hostRef: string): string {
  return sign(
    {
      sub: hostRef,
      hostRefs: [hostRef],
      workflowControlScopes: ['llm:grok:execute'],
      scope: 'workflow:approval:request',
    },
    'workflow-approvals'
  )
}

function executionTicket(input: {
  hostRef: string
  requestHash: string
  providerAttemptId: string
}): string {
  return sign(
    {
      jti: '55555555-5555-4555-8555-555555555555',
      typ: 'grok-execution-ticket',
      hostRef: input.hostRef,
      model: MODEL,
      requestHash: input.requestHash,
      providerAttemptId: input.providerAttemptId,
    },
    'grok-llm-proxy'
  )
}

function completionRequest(): Record<string, unknown> {
  return {
    schemaVersion: 'grok-completion-request.v1',
    requestId: 'req-hermetic-grok-1',
    idempotencyKey: 'idem-hermetic-grok-1',
    provider: 'grok-subscription',
    model: MODEL,
    messages: [{ role: 'user', content: 'Say hello through Grok subscription' }],
  }
}

function sseFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map(part => part.trim())
    .filter(part => part.startsWith('data:'))
    .map(part => JSON.parse(part.slice(5).trim()) as Record<string, unknown>)
}

type RedeemCall = Parameters<ControlApiClient['redeem']>[0]
type FinalizeCall = Parameters<ControlApiClient['finalize']>[0]

function makeControlApiMock(): {
  client: ControlApiClient
  redeems: RedeemCall[]
  finalizes: FinalizeCall[]
} {
  const redeems: RedeemCall[] = []
  const finalizes: FinalizeCall[] = []
  const client = {
    async redeem(input: RedeemCall): Promise<RedeemAttemptSuccess> {
      redeems.push(input)
      const grant = input.hostRef ? CONNECTED_GRANTS[input.hostRef] : undefined
      if (!grant) throw new ControlApiClientError('no_grant', 'no Grok grant is assigned')
      if (!input.model || !grant.models.includes(input.model)) {
        throw new ControlApiClientError('model_not_allowed', 'model is not offered on the grant')
      }
      return {
        accessToken: ACCESS_TOKEN,
        transport: {
          protocolVersion: 'grok-subscription-transport.v1',
          completionsOrigin: GROK_COMPLETIONS_ORIGIN,
          catalogOrigin: GROK_CATALOG_ORIGIN,
          operation: 'completion_stream',
          servedModel: input.model,
          maxStreamDurationMs: 30_000,
        },
        expiryClass: 'short_lived',
        attemptReceipt: 'c'.repeat(64),
      }
    },
    async finalize(input: FinalizeCall): Promise<FinalizeAttemptSuccess> {
      finalizes.push(input)
      return {
        providerAttemptId: input.receipt.providerAttemptId,
        outcome: input.receipt.outcome,
        duplicate: false,
      }
    },
  } as unknown as ControlApiClient
  return { client, redeems, finalizes }
}

// ─── loopback Grok fixture upstream ─────────────────────────────────────────

const counters = { streams: 0, models: 0, rejected: 0 }
/**
 * Per-case overrides for the shared fixture. Left empty the fixture serves the
 * single-call reply every other case in this file asserts; the limit cases set
 * it and clear it again, so no default changes.
 */
const upstreamPlan: { toolCallCount?: number; omitText?: boolean } = {}
const upstreamBodies: Array<Record<string, unknown>> = []
let upstream: Server | undefined
let upstreamBase = ''
let servers: ProxyServers | undefined

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function handleUpstream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://grok-test-upstream.local')
  if (
    req.headers.authorization !== `Bearer ${ACCESS_TOKEN}` ||
    !String(req.headers['user-agent'] ?? '').startsWith(GROK_UPSTREAM_USER_AGENT) ||
    // Mirror the live gate: refuse a request that carries no client version.
    !/^\d+\.\d+\.\d+/.test(String(req.headers['x-grok-client-version'] ?? ''))
  ) {
    counters.rejected += 1
    json(res, 401, { error: 'unauthorized' })
    return
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    counters.models += 1
    json(res, 200, { data: [{ id: MODEL, object: 'model' }] })
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
    upstreamBodies.push(body)
    const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>) : []
    counters.streams += 1
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    // The proxy dispatches on the `type` INSIDE each data payload.
    if (!upstreamPlan.omitText) {
      res.write(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`
      )
    }
    const wireTool = tools[0]?.name
    if (wireTool) {
      const count = upstreamPlan.toolCallCount ?? 1
      for (let index = 0; index < count; index += 1) {
        res.write(
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id:
                upstreamPlan.toolCallCount === undefined
                  ? 'call-hermetic-grok'
                  : `call-hermetic-${index}`,
              name: wireTool,
              arguments: JSON.stringify(CALL_ARGUMENTS),
            },
          })}\n\n`
        )
      }
    }
    res.end(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 3, output_tokens: 1 } },
      })}\n\n`
    )
    return
  }
  json(res, 404, { error: 'not_found' })
}

/**
 * Reroute the frozen cli-chat-proxy.grok.com origin to the loopback fixture.
 * The URL given to fetchFn already passed the unmodified origin policy; only
 * the socket destination changes.
 */
function rewriteFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const parsed = new URL(String(url))
  expect(parsed.origin).toBe('https://cli-chat-proxy.grok.com')
  return fetch(new URL(parsed.pathname + parsed.search, upstreamBase), init)
}

const lookup = async () => [{ address: '104.18.32.47', family: 4 }]

beforeAll(async () => {
  upstream = createServer((req, res) => {
    handleUpstream(req, res).catch(err => {
      json(res, 500, { error: err instanceof Error ? err.message : 'upstream_error' })
    })
  })
  await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', () => resolve()))
  const { port } = upstream.address() as AddressInfo
  upstreamBase = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await servers?.close()
  await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()))
})

describe('hermetic Grok authorize → proxy → fixture upstream → finalize', () => {
  it('streams a completion through the fixture upstream and finalizes a success receipt', async () => {
    const { client, redeems, finalizes } = makeControlApiMock()
    servers = createProxyApps(config(), { controlApiClient: client, fetchFn: rewriteFetch, lookup })
    const beforeStreams = counters.streams
    upstreamBodies.length = 0

    const raw = { ...completionRequest(), tools: [structuredClone(UPDATE_TOOL)] }
    const original = structuredClone(raw)
    const parsed = parseGrokCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashGrokCompletionRequestV1(parsed.value)
    const providerAttemptId = 'att-hermetic-grok-1'

    const res = await request(servers.runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken(RECIPE_HOST_REF)}`)
      .send({
        executionTicket: executionTicket({
          hostRef: RECIPE_HOST_REF,
          requestHash,
          providerAttemptId,
        }),
        requestHash,
        request: raw,
      })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = sseFrames(res.text)
    expect(frames).toContainEqual({ type: 'text', text: 'hello' })
    expect(frames.filter(frame => frame.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        id: 'call-hermetic-grok',
        name: UPDATE_TOOL.name,
        arguments: CALL_ARGUMENTS,
      },
    ])
    // The stream ends in a done frame carrying the success outcome and usage.
    expect(frames.at(-1)).toEqual({
      type: 'done',
      outcome: 'success',
      usage: { inputTokens: 3, outputTokens: 1 },
    })

    expect(upstreamBodies).toHaveLength(1)
    expect(upstreamBodies[0]).toMatchObject({ model: MODEL, stream: true, store: false })
    expect(upstreamBodies[0]?.tools).toEqual([{ type: 'function', ...UPDATE_TOOL, strict: false }])
    expect(raw).toEqual(original)

    expect(redeems).toHaveLength(1)
    expect(redeems[0]).toMatchObject({
      requestHash,
      model: MODEL,
      hostRef: RECIPE_HOST_REF,
      operation: 'completion_stream',
    })
    expect(finalizes).toHaveLength(1)
    expect(finalizes[0]?.attemptReceipt).toBe('c'.repeat(64))
    expect(finalizes[0]?.receipt).toEqual({
      schemaVersion: 'grok-attempt-receipt.v1',
      providerAttemptId,
      requestHash,
      outcome: 'success',
      usage: { inputTokens: 3, outputTokens: 1 },
    })
    expect(counters.streams).toBe(beforeStreams + 1)
    expect(res.text).not.toMatch(/test-access-hermetic|attemptReceipt|refresh/i)

    await servers.close()
    servers = undefined
  })

  it('fails closed before touching the upstream when the recipe grant is unassigned', async () => {
    const { client, redeems, finalizes } = makeControlApiMock()
    servers = createProxyApps(config(), { controlApiClient: client, fetchFn: rewriteFetch, lookup })
    const beforeStreams = counters.streams

    const unassignedHostRef = 'sandbox-recipes/e2e-grok-recipe-unassigned'
    const raw = completionRequest()
    const parsed = parseGrokCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashGrokCompletionRequestV1(parsed.value)

    const res = await request(servers.runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken(unassignedHostRef)}`)
      .send({
        executionTicket: executionTicket({
          hostRef: unassignedHostRef,
          requestHash,
          providerAttemptId: 'att-hermetic-grok-2',
        }),
        requestHash,
        request: raw,
      })

    expect(res.status).toBe(403)
    expect(JSON.parse(res.text)).toEqual({ error: 'no_grant' })
    expect(redeems).toHaveLength(1)
    expect(finalizes).toHaveLength(0)
    expect(counters.streams).toBe(beforeStreams)

    await servers.close()
    servers = undefined
  })

  it('lists the catalog through the admin listener with a valid permit', async () => {
    servers = createProxyApps(config(), { fetchFn: rewriteFetch, lookup })
    const beforeModels = counters.models
    const permit = sign(
      { sub: 'admin-1', typ: 'grok-admin-permit', operation: 'catalog_list' },
      'grok-llm-proxy-admin'
    )
    const res = await request(servers.adminApp)
      .post('/internal/admin/v1/grok/models')
      .set('Authorization', `Bearer ${permit}`)
      .send({ accessToken: ACCESS_TOKEN })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ outcome: 'ready', models: [{ model: MODEL }] })
    expect(counters.models).toBe(beforeModels + 1)

    await servers.close()
    servers = undefined
  })

  it('never reaches the upstream while the execution kill switch is off', async () => {
    const { client, redeems } = makeControlApiMock()
    servers = createProxyApps(config({ executionEnabled: false }), {
      controlApiClient: client,
      fetchFn: rewriteFetch,
      lookup,
    })
    const beforeStreams = counters.streams
    const raw = completionRequest()
    const parsed = parseGrokCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashGrokCompletionRequestV1(parsed.value)

    const res = await request(servers.runtimeApp)
      .post('/internal/runtime/v1/grok/completions')
      .set('Authorization', `Bearer ${platformToken(RECIPE_HOST_REF)}`)
      .send({
        executionTicket: executionTicket({
          hostRef: RECIPE_HOST_REF,
          requestHash,
          providerAttemptId: 'att-hermetic-grok-off',
        }),
        requestHash,
        request: raw,
      })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'disabled' })
    expect(redeems).toHaveLength(0)
    expect(counters.streams).toBe(beforeStreams)

    await servers.close()
    servers = undefined
  })
})

describe('hermetic per-response tool-call limit', () => {
  // The handler-level suite exercises mapError against a supertest response.
  // This is the only level where the staged SSE headers, the real mapError and
  // the real response object meet on the runtime listener.
  async function runWithToolCallCount(
    count: number,
    providerAttemptId: string,
    options: { omitText: boolean }
  ) {
    upstreamPlan.toolCallCount = count
    upstreamPlan.omitText = options.omitText
    const { client, redeems, finalizes } = makeControlApiMock()
    const proxy = createProxyApps(config(), {
      controlApiClient: client,
      fetchFn: rewriteFetch,
      lookup,
    })
    const beforeStreams = counters.streams
    try {
      const raw = { ...completionRequest(), tools: [structuredClone(UPDATE_TOOL)] }
      const parsed = parseGrokCompletionRequestV1(raw)
      if (!parsed.ok) throw new Error(parsed.message)
      const requestHash = hashGrokCompletionRequestV1(parsed.value)
      const res = await request(proxy.runtimeApp)
        .post('/internal/runtime/v1/grok/completions')
        .set('Authorization', `Bearer ${platformToken(RECIPE_HOST_REF)}`)
        .send({
          executionTicket: executionTicket({
            hostRef: RECIPE_HOST_REF,
            requestHash,
            providerAttemptId,
          }),
          requestHash,
          request: raw,
        })
      return { res, redeems, finalizes, streams: counters.streams - beforeStreams }
    } finally {
      await proxy.close()
      delete upstreamPlan.toolCallCount
      delete upstreamPlan.omitText
    }
  }

  it('rejects 65 calls before any text with 422 tool_call_limit_exceeded', async () => {
    const { res, redeems, finalizes, streams } = await runWithToolCallCount(65, 'att-limit-65', {
      omitText: true,
    })

    // Liveness witness: the fixture really served the 65-call stream.
    expect(streams).toBe(1)
    // One assertion so a regression reports the status and the code together.
    expect({
      status: res.status,
      contentType: res.headers['content-type'],
      body: res.body,
    }).toEqual({
      status: 422,
      contentType: expect.stringMatching(/^application\/json/),
      body: { error: 'tool_call_limit_exceeded' },
    })
    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.text).not.toContain('"type":"tool_call"')
    expect(redeems).toHaveLength(1)
    expect(finalizes).toHaveLength(1)
    expect(finalizes[0]?.receipt).toMatchObject({
      providerAttemptId: 'att-limit-65',
      outcome: 'error',
    })
  })

  it('rejects 65 calls after streamed text with an SSE tool_call_limit_exceeded frame', async () => {
    const { res, redeems, finalizes, streams } = await runWithToolCallCount(
      65,
      'att-limit-65-text',
      { omitText: false }
    )

    expect(streams).toBe(1)
    // The text delta already reached the client, so the status is committed.
    expect(res.status).toBe(200)
    const frames = sseFrames(res.text)
    // Liveness witness: the stream was live before the limit tripped.
    expect(frames[0]).toEqual({ type: 'text', text: 'hello' })
    expect(frames.filter(frame => frame.type === 'tool_call')).toHaveLength(0)
    expect(frames.filter(frame => frame.type === 'done')).toHaveLength(0)
    expect(frames[frames.length - 1]).toMatchObject({
      type: 'error',
      code: 'tool_call_limit_exceeded',
    })
    expect(redeems).toHaveLength(1)
    expect(finalizes).toHaveLength(1)
    expect(finalizes[0]?.receipt).toMatchObject({
      providerAttemptId: 'att-limit-65-text',
      outcome: 'error',
    })
  })

  it('delivers exactly 64 calls in one response', async () => {
    const { res, redeems, finalizes, streams } = await runWithToolCallCount(64, 'att-limit-64', {
      omitText: true,
    })

    expect(streams).toBe(1)
    expect(res.status).toBe(200)
    const frames = sseFrames(res.text)
    const toolCalls = frames.filter(frame => frame.type === 'tool_call')
    expect(toolCalls).toHaveLength(64)
    expect(toolCalls.map(frame => frame.id)).toEqual(
      Array.from({ length: 64 }, (_, index) => `call-hermetic-${index}`)
    )
    expect(frames.find(frame => frame.type === 'done')?.outcome).toBe('success')
    expect(redeems).toHaveLength(1)
    expect(finalizes).toHaveLength(1)
    expect(finalizes[0]?.receipt).toMatchObject({
      providerAttemptId: 'att-limit-64',
      outcome: 'success',
    })
  })
})
