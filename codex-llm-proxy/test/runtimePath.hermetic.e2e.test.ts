/**
 * Hermetic runtime-path e2e: authorize (mocked control-api redeem) → proxy
 * runtime listener → REAL fixture ChatGPT upstream
 * (tests/e2e/fixtures/codex-subscription/test-upstream/server.mjs, spawned as
 * a child process over TLS on loopback) → finalize receipt.
 *
 * This is the load-bearing transport evidence for
 * scripts/e2e/e2e-codex-subscription-runtime.sh: the same fixture upstream the
 * in-cluster manifest deploys serves the stream here, and the full proxy
 * pipeline (platform JWT, execution ticket, request-hash freeze, origin
 * policy, SSE mapping, finalize retry contract) runs unmocked. Only two seams
 * are substituted, both injection points that production wires to live
 * infrastructure:
 *   - ControlApiClient (redeem/finalize) — an in-memory grant table standing
 *     in for control-api's authorizer, keyed by the same recipe-shaped
 *     hostRef + connection-key identity used by
 *     `clerum.io/codex-connection-ref` (claim 1).
 *   - fetchFn/lookup — the frozen chatgpt.com origin is still asserted by the
 *     unmodified origin policy; the socket is then pointed at the loopback
 *     fixture instead of the public internet. No live ChatGPT OAuth is used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import {
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import type { CodexLlmProxyConfig } from '../src/config.js'
import {
  type ControlApiClient,
  ControlApiClientError,
  type FinalizeAttemptSuccess,
  type RedeemAttemptSuccess,
} from '../src/controlApiClient.js'
import { CODEX_CATALOG_ORIGIN, CODEX_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import { type ProxyServers, createProxyApps } from '../src/server.js'
import { eventaskUpdateTool, optionalMcpTools } from './fixtures/optionalMcpTools.js'

// Model output is simulated only at the external TLS boundary. The production
// proxy must carry these exact arguments without synthesizing label edits.
const OPTIONAL_CALL_ARGUMENTS = {
  key: 'BUG-1',
  actor: 'test-agent',
  description: 'Updated description',
}

const FIXTURE_UPSTREAM = fileURLToPath(
  new URL('../../tests/e2e/fixtures/codex-subscription/test-upstream/server.mjs', import.meta.url)
)
const UPSTREAM_PORT = 18443 + (process.pid % 1000)
const UPSTREAM_BASE = `https://127.0.0.1:${UPSTREAM_PORT}`

// Grant table the mocked control-api authorizer redeems against. The key is
// the same recipe-level connection identity persisted by the
// `clerum.io/codex-connection-ref` annotation (claim 1): SDK / workflow
// callers attest as `namespace/recipe`, and only an existing connected grant
// offering the requested model may be redeemed.
const RECIPE_HOST_REF = 'sandbox-recipes/e2e-codex-recipe'
const CONNECTED_GRANTS: Record<string, { connectionKey: string; models: string[] }> = {
  [RECIPE_HOST_REF]: { connectionKey: 'e2e-team-plus', models: ['gpt-5.3-codex'] },
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function config(): CodexLlmProxyConfig {
  return {
    runtimePort: 0,
    adminPort: 0,
    probePort: 0,
    maxBodyBytes: 1_048_576,
    maxVisualBodyBytes: 24 * 1024 * 1024,
    maxStreamDurationMs: 30_000,
    maxDeadlineMs: 30_000,
    jwtIssuer: 'control-api',
    jwtPublicKey: publicKey,
    executionEnabled: true,
    controlApiBaseUrl: '',
    controlApiServiceName: 'codex-llm-proxy',
    controlApiServiceToken: '',
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
      workflowControlScopes: ['llm:codex:execute'],
      scope: 'workflow:approval:request',
    },
    'workflow-approvals'
  )
}

function executionTicket(input: {
  hostRef: string
  model: string
  requestHash: string
  providerAttemptId: string
}): string {
  return sign(
    {
      jti: '22222222-2222-4222-8222-222222222222',
      typ: 'codex-execution-ticket',
      hostRef: input.hostRef,
      model: input.model,
      requestHash: input.requestHash,
      providerAttemptId: input.providerAttemptId,
    },
    'codex-llm-proxy'
  )
}

function completionRequest(model: string): Record<string, unknown> {
  return {
    schemaVersion: 'codex-completion-request.v1',
    requestId: 'req-hermetic-1',
    idempotencyKey: 'idem-hermetic-1',
    provider: 'codex-subscription',
    model,
    messages: [{ role: 'user', content: 'Say hello through Codex subscription' }],
  }
}

/** SSE `data:` payloads written by the proxy runtime response. */
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
      // Fail closed exactly like control-api: an unassigned / unknown recipe
      // grant never redeems, and never aliases deployment-default.
      if (!grant) throw new ControlApiClientError('no_grant', 'no Codex grant is assigned')
      if (!input.model || !grant.models.includes(input.model)) {
        throw new ControlApiClientError('model_not_allowed', 'model is not offered on the grant')
      }
      return {
        accessToken: 'test-access-hermetic',
        chatgptAccountId: 'acct-e2e-hermetic',
        transport: {
          protocolVersion: 'codex-subscription-transport.v1',
          completionsOrigin: CODEX_COMPLETIONS_ORIGIN,
          catalogOrigin: CODEX_CATALOG_ORIGIN,
          operation: 'completion_stream',
          servedModel: input.model,
          maxStreamDurationMs: 30_000,
        },
        expiryClass: 'short_lived',
        attemptReceipt: 'b'.repeat(64),
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

/**
 * Reroute the frozen chatgpt.com origin to the loopback fixture. The URL
 * given to fetchFn has already passed the unmodified origin policy
 * (assertAllowedUpstreamUrl + assertResolvedUpstream); only the socket
 * destination changes, mirroring what the in-cluster NetworkPolicy/DNS pin
 * would do for a test upstream. TLS is verified against the run-generated
 * CA (SAN IP:127.0.0.1); certificate validation is never disabled.
 */
function rewriteFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const parsed = new URL(String(url))
  expect(parsed.origin).toBe('https://chatgpt.com')
  const target = new URL(parsed.pathname + parsed.search, UPSTREAM_BASE)
  return trustedLoopbackFetch(target, init)
}

async function upstreamCounters(): Promise<Record<string, number>> {
  const res = await trustedLoopbackFetch(`${UPSTREAM_BASE}/internal/counters`)
  return (await res.json()) as Record<string, number>
}

let upstream: ChildProcess | undefined
let workdir: string
let servers: ProxyServers | undefined
let fixtureCa: Buffer | undefined
let tlsPaths: { certPath: string; keyPath: string } | undefined

/**
 * Spawn the fixture upstream on `port` with the run-generated certificate.
 * The fixture reads its canned reply from the environment at startup, so a
 * case that needs a different reply spawns its own process.
 */
async function spawnFixtureUpstream(
  port: number,
  extraEnv: Record<string, string>
): Promise<ChildProcess> {
  if (!tlsPaths) throw new Error('fixture TLS material is not ready')
  const child = spawn(process.execPath, [FIXTURE_UPSTREAM], {
    env: {
      ...process.env,
      CODEX_TEST_UPSTREAM_PORT: String(port),
      CODEX_TEST_UPSTREAM_CERT_PATH: tlsPaths.certPath,
      CODEX_TEST_UPSTREAM_KEY_PATH: tlsPaths.keyPath,
      CODEX_TEST_UPSTREAM_TOOL_CALL: JSON.stringify({
        name: eventaskUpdateTool.name,
        arguments: OPTIONAL_CALL_ARGUMENTS,
      }),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture upstream did not start')), 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`fixture upstream exited early (code ${code})`))
    })
  })
  return child
}

async function stopFixtureUpstream(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })
}

function trustedLoopbackFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (!fixtureCa) {
    return Promise.reject(new Error('fixture CA is not ready'))
  }
  const target = new URL(String(url))
  const headers: Record<string, string> = {}
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
        ca: fixtureCa,
        rejectUnauthorized: true,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () => {
          const headerBag = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headerBag.set(key, value)
            else if (Array.isArray(value)) headerBag.set(key, value.join(', '))
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers: headerBag,
            })
          )
        })
      }
    )
    req.on('error', reject)
    const body = init?.body
    if (body == null) {
      req.end()
      return
    }
    if (typeof body === 'string' || body instanceof Uint8Array || Buffer.isBuffer(body)) {
      req.end(body)
      return
    }
    reject(new Error('unsupported request body in hermetic fixture fetch'))
  })
}

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'codex-hermetic-'))
  const certPath = join(workdir, 'tls.crt')
  const keyPath = join(workdir, 'tls.key')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' }
  )
  fixtureCa = readFileSync(certPath)
  tlsPaths = { certPath, keyPath }
  upstream = await spawnFixtureUpstream(UPSTREAM_PORT, {})
}, 30_000)

afterAll(async () => {
  await servers?.close()
  upstream?.kill('SIGTERM')
  rmSync(workdir, { recursive: true, force: true })
})

describe('hermetic authorize → proxy → fixture upstream → finalize', () => {
  it('streams a completion through the fixture upstream and finalizes a success receipt', async () => {
    const { client, redeems, finalizes } = makeControlApiMock()
    const upstreamBodies: Array<Record<string, unknown>> = []
    servers = createProxyApps(config(), {
      controlApiClient: client,
      fetchFn: (url, init) => {
        // Observe only: adding strict here would hide a broken serializer.
        upstreamBodies.push(JSON.parse(String(init?.body)))
        return rewriteFetch(url, init)
      },
      lookup: async () => [{ address: '104.18.32.47', family: 4 }],
    })
    const before = await upstreamCounters()

    const raw = {
      ...completionRequest('gpt-5.3-codex'),
      tools: structuredClone(optionalMcpTools),
    }
    const original = structuredClone(raw)
    const parsed = parseCodexCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashCodexCompletionRequestV1(parsed.value)
    const providerAttemptId = 'att-hermetic-1'

    const res = await request(servers.runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
      .set('Authorization', `Bearer ${platformToken(RECIPE_HOST_REF)}`)
      .send({
        executionTicket: executionTicket({
          hostRef: RECIPE_HOST_REF,
          model: 'gpt-5.3-codex',
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
        id: 'call-hermetic-optional',
        name: eventaskUpdateTool.name,
        arguments: OPTIONAL_CALL_ARGUMENTS,
      },
    ])
    expect(upstreamBodies).toHaveLength(1)
    expect(upstreamBodies[0]?.tools).toEqual(
      optionalMcpTools.map(tool => ({
        type: 'function',
        ...tool,
        strict: false,
      }))
    )
    expect(raw).toEqual(original)
    expect(hashCodexCompletionRequestV1(parsed.value)).toBe(requestHash)
    const done = frames.find(frame => frame.type === 'done')
    expect(done).toBeDefined()
    expect(done?.outcome).toBe('success')
    expect(done?.usage).toEqual({ inputTokens: 3, outputTokens: 1 })

    // One redemption against the recipe-shaped grant identity, no live OAuth.
    expect(redeems).toHaveLength(1)
    expect(redeems[0]).toMatchObject({
      requestHash,
      model: 'gpt-5.3-codex',
      hostRef: RECIPE_HOST_REF,
      operation: 'completion_stream',
    })

    // Finalize carries the physical receipt for the exact attempt and usage.
    expect(finalizes).toHaveLength(1)
    expect(finalizes[0]?.attemptReceipt).toBe('b'.repeat(64))
    expect(finalizes[0]?.receipt).toEqual({
      schemaVersion: 'codex-attempt-receipt.v1',
      providerAttemptId,
      requestHash,
      outcome: 'success',
      usage: { inputTokens: 3, outputTokens: 1 },
    })

    // The REAL fixture upstream served exactly one stream for this test.
    const after = await upstreamCounters()
    expect(after.streams).toBe((before.streams ?? 0) + 1)

    // Secret hygiene: neither the upstream credential nor receipts leak into
    // the client-visible stream.
    expect(res.text).not.toMatch(/test-access-hermetic|attemptReceipt|refresh/i)

    await servers.close()
    servers = undefined
  })

  it('fails closed before touching the upstream when the recipe grant is unassigned', async () => {
    const { client, redeems, finalizes } = makeControlApiMock()
    servers = createProxyApps(config(), {
      controlApiClient: client,
      fetchFn: rewriteFetch,
      lookup: async () => [{ address: '104.18.32.47', family: 4 }],
    })
    const before = await upstreamCounters()

    const unassignedHostRef = 'sandbox-recipes/e2e-codex-recipe-unassigned'
    const raw = completionRequest('gpt-5.3-codex')
    const parsed = parseCodexCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashCodexCompletionRequestV1(parsed.value)

    const res = await request(servers.runtimeApp)
      .post('/internal/runtime/v1/codex/completions')
      .set('Authorization', `Bearer ${platformToken(unassignedHostRef)}`)
      .send({
        executionTicket: executionTicket({
          hostRef: unassignedHostRef,
          model: 'gpt-5.3-codex',
          requestHash,
          providerAttemptId: 'att-hermetic-2',
        }),
        requestHash,
        request: raw,
      })

    // Redemption fails before the first stream write, so the denial is a
    // plain 403 with the authorizer's stable code — never a partial stream.
    expect(res.status).toBe(403)
    // The staged SSE headers are replaced by a JSON response.
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ error: 'no_grant' })
    expect(redeems).toHaveLength(1)
    expect(finalizes).toHaveLength(0)

    const after = await upstreamCounters()
    expect(after.streams).toBe(before.streams ?? 0)

    await servers.close()
    servers = undefined
  })
})

describe('hermetic per-response tool-call limit', () => {
  // Each case owns an upstream on its own port: the fixture reads the repeat
  // count at startup, so the shared upstream above cannot serve these replies.
  const LIMIT_UPSTREAM_PORT = UPSTREAM_PORT + 1

  async function runWithToolCallCount(
    count: number,
    providerAttemptId: string,
    options: { omitText: boolean }
  ) {
    const limitUpstream = await spawnFixtureUpstream(LIMIT_UPSTREAM_PORT, {
      CODEX_TEST_UPSTREAM_TOOL_CALL_COUNT: String(count),
      ...(options.omitText ? { CODEX_TEST_UPSTREAM_OMIT_TEXT: '1' } : {}),
    })
    const base = `https://127.0.0.1:${LIMIT_UPSTREAM_PORT}`
    const { client, redeems, finalizes } = makeControlApiMock()
    const proxy = createProxyApps(config(), {
      controlApiClient: client,
      fetchFn: (url, init) => {
        const parsed = new URL(String(url))
        expect(parsed.origin).toBe('https://chatgpt.com')
        return trustedLoopbackFetch(new URL(parsed.pathname + parsed.search, base), init)
      },
      lookup: async () => [{ address: '104.18.32.47', family: 4 }],
    })
    try {
      // The request presents the fixture's tool name, so the upstream serves
      // the stream instead of refusing with fixture_tool_not_declared.
      const raw = {
        ...completionRequest('gpt-5.3-codex'),
        tools: structuredClone(optionalMcpTools),
      }
      const parsed = parseCodexCompletionRequestV1(raw)
      if (!parsed.ok) throw new Error(parsed.message)
      const requestHash = hashCodexCompletionRequestV1(parsed.value)
      const res = await request(proxy.runtimeApp)
        .post('/internal/runtime/v1/codex/completions')
        .set('Authorization', `Bearer ${platformToken(RECIPE_HOST_REF)}`)
        .send({
          executionTicket: executionTicket({
            hostRef: RECIPE_HOST_REF,
            model: 'gpt-5.3-codex',
            requestHash,
            providerAttemptId,
          }),
          requestHash,
          request: raw,
        })
      const counters = (await (
        await trustedLoopbackFetch(`${base}/internal/counters`)
      ).json()) as Record<string, number>
      return { res, redeems, finalizes, counters }
    } finally {
      await proxy.close()
      await stopFixtureUpstream(limitUpstream)
    }
  }

  it('rejects 257 calls before any text with 422 tool_call_limit_exceeded', async () => {
    const { res, redeems, finalizes, counters } = await runWithToolCallCount(
      257,
      'att-hermetic-limit-257',
      { omitText: true }
    )

    // Liveness witness: the upstream really served the 257-call stream.
    expect(counters.streams).toBe(1)
    // One assertion so a regression reports both the status and the code.
    expect({
      status: res.status,
      contentType: res.headers['content-type'],
      body: res.body,
    }).toEqual({
      status: 422,
      contentType: expect.stringMatching(/^application\/json/),
      body: { error: 'tool_call_limit_exceeded' },
    })
    expect(res.text).not.toContain('"type":"tool_call"')
    expect(redeems).toHaveLength(1)
    expect(finalizes).toHaveLength(1)
    expect(finalizes[0]?.receipt).toMatchObject({
      providerAttemptId: 'att-hermetic-limit-257',
      outcome: 'error',
    })
  })

  it('rejects 257 calls after streamed text with an SSE tool_call_limit_exceeded frame', async () => {
    const { res, redeems, finalizes, counters } = await runWithToolCallCount(
      257,
      'att-hermetic-limit-257-text',
      { omitText: false }
    )

    expect(counters.streams).toBe(1)
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
      providerAttemptId: 'att-hermetic-limit-257-text',
      outcome: 'error',
    })
  })

  it('delivers exactly 256 calls in one response', async () => {
    const { res, redeems, finalizes, counters } = await runWithToolCallCount(
      256,
      'att-hermetic-limit-256',
      { omitText: true }
    )

    expect(counters.streams).toBe(1)
    expect(res.status).toBe(200)
    const frames = sseFrames(res.text)
    const toolCalls = frames.filter(frame => frame.type === 'tool_call')
    expect(toolCalls).toHaveLength(256)
    expect(toolCalls.map(frame => frame.id)).toEqual(
      Array.from({ length: 256 }, (_, index) => `call-hermetic-${index}`)
    )
    expect(frames.find(frame => frame.type === 'done')?.outcome).toBe('success')
    expect(redeems).toHaveLength(1)
    expect(finalizes).toHaveLength(1)
    expect(finalizes[0]?.receipt).toMatchObject({
      providerAttemptId: 'att-hermetic-limit-256',
      outcome: 'success',
    })
  })
})

describe('hermetic catalog re-read', () => {
  // The catalog is read once at sign-in, so a model the vendor publishes later
  // reaches a grant only through a re-read. This is the one place in the
  // repository where that re-read can be exercised against an upstream we
  // control: the catalog origin is frozen to chatgpt.com by originPolicy, and
  // only the in-process fetch seam below redirects the socket. The lane that
  // deploys this same fixture into the cluster never points any component at
  // it, and the Control UI Playwright lane deploys no upstream at all.
  const CATALOG_UPSTREAM_PORT = UPSTREAM_PORT + 2
  const PUBLISHED_AFTER_HANDSHAKE = 'gpt-5.3-codex-mini'

  function adminPermit(): string {
    return sign(
      { sub: 'admin-hermetic', typ: 'codex-admin-permit', operation: 'catalog_list' },
      'codex-llm-proxy-admin'
    )
  }

  it('returns a model the upstream published after the grant was connected', async () => {
    // The fixture reads its model list at startup, so this case owns its
    // upstream. The grant seeded in CONNECTED_GRANTS carries only
    // gpt-5.3-codex; the second id exists upstream and nowhere else.
    const catalogUpstream = await spawnFixtureUpstream(CATALOG_UPSTREAM_PORT, {
      CODEX_TEST_UPSTREAM_EXTRA_MODEL: PUBLISHED_AFTER_HANDSHAKE,
    })
    const base = `https://127.0.0.1:${CATALOG_UPSTREAM_PORT}`
    const proxy = createProxyApps(config(), {
      fetchFn: (url, init) => {
        const parsed = new URL(String(url))
        expect(parsed.origin).toBe('https://chatgpt.com')
        expect(parsed.pathname).toBe(new URL(CODEX_CATALOG_ORIGIN).pathname)
        return trustedLoopbackFetch(new URL(parsed.pathname + parsed.search, base), init)
      },
      lookup: async () => [{ address: '104.18.32.47', family: 4 }],
    })
    try {
      const before = (await (
        await trustedLoopbackFetch(`${base}/internal/counters`)
      ).json()) as Record<string, number>

      const res = await request(proxy.adminApp)
        .post('/internal/admin/v1/codex/models')
        .set('Authorization', `Bearer ${adminPermit()}`)
        .send({ accessToken: 'test-access-hermetic-catalog' })

      const after = (await (
        await trustedLoopbackFetch(`${base}/internal/counters`)
      ).json()) as Record<string, number>
      // Liveness witness: the route reached the upstream for this call. Without
      // it, a handler that answered from anything cached would satisfy the
      // model assertions below.
      expect(after.models - before.models).toBe(1)

      expect(res.status).toBe(200)
      // The grant's own model is asserted alongside the new one: a reply that
      // lost it would be a different failure than one that never gained the
      // second id, and one assertion reports both.
      expect(res.body).toEqual({
        outcome: 'ready',
        models: [{ model: 'gpt-5.3-codex' }, { model: PUBLISHED_AFTER_HANDSHAKE }],
      })
      expect(CONNECTED_GRANTS[RECIPE_HOST_REF]?.models).not.toContain(PUBLISHED_AFTER_HANDSHAKE)
    } finally {
      await proxy.close()
      await stopFixtureUpstream(catalogUpstream)
    }
  })
})
