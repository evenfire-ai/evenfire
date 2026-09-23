/**
 * #731 R3-2 - body admission before `express.json`.
 *
 * At an 8 MiB request cap, parsing every body the stream gate lets in (8
 * running plus 16 queued) holds about five copies of each in memory, far past
 * the proxy's 256Mi. These tests drive the real runtime app over HTTP and use
 * the control-api `redeem` call as the witness: it runs only after the whole
 * body was read, JSON-parsed, contract-parsed and hash-checked, so the number
 * of attempts held there is the number of bodies in memory.
 */
import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  LIMITS,
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import type { CodexLlmProxyConfig } from '../src/config.js'
import type {
  ControlApiClient,
  FinalizeAttemptSuccess,
  RedeemAttemptSuccess,
} from '../src/controlApiClient.js'
import { CODEX_CATALOG_ORIGIN, CODEX_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import { DEFAULT_MAX_BODY_BYTES, STREAM_LIMITS } from '../src/requestLimits.js'
import { createProxyApps } from '../src/server.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const HOST_REF = 'research-host'
const COMPLETIONS_PATH = '/internal/runtime/v1/codex/completions'
/** The admission budget holds this many bodies of the configured maximum size. */
const BUDGET_BODIES = 3

function sign(payload: Record<string, unknown>, audience: string): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience,
    expiresIn: 60,
  })
}

function config(maxBodyBytes: number): CodexLlmProxyConfig {
  return {
    runtimePort: 0,
    adminPort: 0,
    probePort: 0,
    maxBodyBytes,
    maxVisualBodyBytes: LIMITS.maxVisualRequestBodyBytes,
    maxStreamDurationMs: 60_000,
    maxDeadlineMs: 60_000,
    jwtIssuer: 'control-api',
    jwtPublicKey: publicKey,
    executionEnabled: true,
    controlApiBaseUrl: 'http://control-api.invalid/api/v1',
    controlApiServiceName: 'codex-llm-proxy',
    controlApiServiceToken: 'unused',
  }
}

const platformToken = sign(
  {
    sub: `default/${HOST_REF}`,
    hostRefs: [HOST_REF],
    workflowControlScopes: ['llm:codex:execute'],
    scope: 'workflow:approval:request',
  },
  'workflow-approvals'
)

/** A runtime envelope whose request carries one user message of `contentChars`. */
function completionBody(contentChars: number, attempt: string): string {
  const raw = {
    schemaVersion: 'codex-completion-request.v1',
    requestId: `req-${attempt}`,
    idempotencyKey: `idem-${attempt}`,
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    messages: [{ role: 'user', content: 'x'.repeat(contentChars) }],
  }
  const parsed = parseCodexCompletionRequestV1(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  const requestHash = hashCodexCompletionRequestV1(parsed.value)
  return JSON.stringify({
    executionTicket: sign(
      {
        jti: randomUUID(),
        typ: 'codex-execution-ticket',
        hostRef: HOST_REF,
        model: 'gpt-5.1',
        requestHash,
        providerAttemptId: `att-${attempt}`,
      },
      'codex-llm-proxy'
    ),
    requestHash,
    request: raw,
  })
}

/**
 * A proxy whose `redeem` holds every attempt until `releaseAll`, so an attempt
 * that reached it keeps its parsed body in memory.
 */
async function heldProxy(maxBodyBytes: number) {
  let redeemed = 0
  let holding = true
  const held: Array<() => void> = []
  const client = {
    async redeem(): Promise<RedeemAttemptSuccess> {
      redeemed += 1
      if (holding) await new Promise<void>(resolve => held.push(resolve))
      return {
        accessToken: 'test-access-admission',
        chatgptAccountId: 'acct-admission',
        transport: {
          protocolVersion: 'codex-subscription-transport.v1',
          completionsOrigin: CODEX_COMPLETIONS_ORIGIN,
          catalogOrigin: CODEX_CATALOG_ORIGIN,
          operation: 'completion_stream',
          servedModel: 'gpt-5.1',
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
  })
  await new Promise<void>(resolve => servers.runtime.listen(0, '127.0.0.1', () => resolve()))
  const { port } = servers.runtime.address() as AddressInfo
  return {
    port,
    redeemed: () => redeemed,
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

describe('codex-llm-proxy body admission (#731 R3-2)', () => {
  it('T-R3-2a holds at most three near-cap bodies at once and admits the rest as they finish', async () => {
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

  it('T-R3-2b refuses a body of undeclared length with 411 before reading it', async () => {
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

  it('T-R3-2c answers provider_unavailable once the admission queue is full', async () => {
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
})
