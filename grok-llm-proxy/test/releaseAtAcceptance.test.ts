import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashGrokCompletionRequest } from '@clerum/grok-provider-attempt-contract'
import type { GrokLlmProxyConfig } from '../src/config.js'
import type { RedeemAttemptSuccess } from '../src/controlApiClient.js'
import {
  type StreamGrokCompletionInput,
  streamGrokCompletion,
} from '../src/grokTransport.js'
import { GROK_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import { streamGate, visualStreamGate } from '../src/requestLimits.js'
import { type ProxyRuntimeDeps, createProxyApps } from '../src/server.js'

// A live stream keeps the handler frame, the transport frame and the input
// object for as long as the upstream answers (V8 keeps the locals of a
// suspended async function). If any of them still names the parsed request
// after the upstream accepted the body, one body-sized tree stays resident per
// live stream, and the 8-wide stream gate multiplies it. These tests hold the
// tree only through a WeakRef and require a forced GC to collect it.

// The transport streams from the contract's parsed copy, not from the object
// the caller passed, so a WeakRef on the caller's tree cannot see a holder of
// the copy. This wrapper records the copy's tools array as each parse returns.
const parsedCopies = vi.hoisted(() => ({ refs: [] as WeakRef<object>[] }))

vi.mock('@clerum/grok-provider-attempt-contract', async importOriginal => {
  const actual = await importOriginal<typeof import('@clerum/grok-provider-attempt-contract')>()
  return {
    ...actual,
    parseGrokCompletionRequest: (input: unknown) => {
      const result = actual.parseGrokCompletionRequest(input)
      if (result.ok && Array.isArray(result.value.tools)) {
        parsedCopies.refs.push(new WeakRef(result.value.tools))
      }
      return result
    },
  }
})

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

async function collectedWithin(ref: WeakRef<object>): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    collect()
    if (ref.deref() === undefined) return true
  }
  return false
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function sign(payload: Record<string, unknown>, audience: string): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience,
    expiresIn: 60,
  })
}

function config(): GrokLlmProxyConfig {
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
  }
}

const MODEL = 'grok-4.6'
const REQUEST = {
  schemaVersion: 'grok-completion-request.v1' as const,
  requestId: 'req-release-001',
  idempotencyKey: 'idem-release-001',
  provider: 'grok-subscription' as const,
  model: MODEL,
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [
    {
      name: 'release__probe',
      description: 'probe',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
  ],
}

function redeemSuccess(): RedeemAttemptSuccess {
  const encoded = Buffer.from(
    JSON.stringify({
      sub: 'live',
      'https://api.x.ai/auth': { grok_account_id: 'acct_live_1' },
    })
  ).toString('base64url')
  return {
    accessToken: `hdr.${encoded}.sig`,
    transport: {
      protocolVersion: 'grok-subscription-transport.v1',
      completionsOrigin: GROK_COMPLETIONS_ORIGIN,
      catalogOrigin: 'https://cli-chat-proxy.grok.com/v1/models',
      operation: 'completion_stream',
      servedModel: MODEL,
      maxStreamDurationMs: 1_800_000,
    },
    expiryClass: 'short_lived',
    attemptReceipt: 'a'.repeat(64),
  }
}

/**
 * Builds the input in its own frame, so the test's async frame never holds the
 * tree: only `input.request` and the WeakRef name it.
 */
function transportInput(witness: {
  fetchReached: boolean
  collectedInFetch: boolean
  parsedCollectedInFetch: boolean
}): {
  input: StreamGrokCompletionInput
  ref: WeakRef<object>
} {
  const requestHash = hashGrokCompletionRequest(REQUEST)
  const tree = JSON.parse(JSON.stringify(REQUEST)) as typeof REQUEST
  // The tools array is what the contract parse and the upstream payload read.
  const ref = new WeakRef(tree.tools)
  const input: StreamGrokCompletionInput = {
    executionTicket: 'ticket-release',
    requestHash,
    request: tree,
    ticket: {
      jti: 'jti-release',
      hostRef: 'research-host',
      model: MODEL,
      requestHash,
      providerAttemptId: 'att-release',
    },
    maxDeadlineMs: 300_000,
    redeem: async () => redeemSuccess(),
    finalize: async () => ({
      providerAttemptId: 'att-release',
      outcome: 'success' as const,
      duplicate: false,
    }),
    fetchFn: (async () => {
      // Runs after the upstream body was built; the stream is not read yet.
      witness.fetchReached = true
      witness.collectedInFetch = await collectedWithin(ref)
      witness.parsedCollectedInFetch = await collectedWithin(parsedCopies.refs[0])
      return new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch,
    lookup: async () => [{ address: '104.18.32.47', family: 4 }],
  }
  return { input, ref }
}

describe('the parsed request is released once the upstream body is built', () => {
  it('the transport keeps no reference to the tree while it waits on the upstream', async () => {
    parsedCopies.refs.length = 0
    const witness = { fetchReached: false, collectedInFetch: false, parsedCollectedInFetch: false }
    const { input, ref } = transportInput(witness)
    const pending = streamGrokCompletion(input)
    // The server drops its own reference at acceptance; the transport's own
    // holders are what this test measures, so the input's is dropped here.
    input.request = undefined
    // Liveness witnesses: the parse ran and produced its own copy, and that
    // copy was alive until the collector could run.
    expect(parsedCopies.refs).toHaveLength(1)
    expect(parsedCopies.refs[0].deref()).toBeDefined()
    expect(ref.deref()).toBeDefined()
    await pending
    // Liveness witness: the fetch was reached, so the body had been built.
    expect(witness.fetchReached).toBe(true)
    expect(witness.collectedInFetch).toBe(true)
    expect(witness.parsedCollectedInFetch).toBe(true)
  })
})

describe('the handler releases the parsed request at onUpstreamAccepted', () => {
  const serversToClose: Array<{ close: () => Promise<void> }> = []
  const listeners: Array<ReturnType<typeof createServer>> = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const server of serversToClose.splice(0)) await server.close()
    await Promise.all(
      listeners.splice(0).map(
        listener =>
          new Promise<void>((resolve, reject) =>
            listener.close(err => (err ? reject(err) : resolve()))
          )
      )
    )
    expect(visualStreamGate.snapshot()).toMatchObject({ running: 0, queued: 0 })
    expect(streamGate.snapshot()).toMatchObject({ running: 0, queued: 0 })
  })

  it('leaves the tree collectable while the stream stays open', async () => {
    const witness: {
      entered: boolean
      measured: boolean
      aliveBeforeAccept: boolean
      collectedAfterAccept: boolean
    } = { entered: false, measured: false, aliveBeforeAccept: false, collectedAfterAccept: false }
    let finish: () => void = () => undefined
    const stream: NonNullable<ProxyRuntimeDeps['streamCompletion']> = async input => {
      witness.entered = true
      // The tools array is shared by the zod copy the stream receives and by the
      // body parser's original, so it is alive while either one is referenced.
      const ref = new WeakRef((input.request as { tools: object }).tools)
      witness.aliveBeforeAccept = ref.deref() !== undefined
      input.onUpstreamAccepted?.()
      witness.collectedAfterAccept = await collectedWithin(ref)
      const held = new Promise<void>(resolve => {
        finish = resolve
      })
      witness.measured = true
      await held
      return { outcome: 'canceled' as const }
    }
    const servers = createProxyApps(config(), { streamCompletion: stream })
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')

    const ticket = sign(
      {
        jti: '22222222-2222-4222-8222-000000000001',
        typ: 'grok-execution-ticket',
        hostRef: 'research-host',
        model: MODEL,
        requestHash: 'a'.repeat(64),
        providerAttemptId: 'att-release-server',
      },
      'grok-llm-proxy'
    )
    const platform = sign(
      {
        sub: 'default/research-host',
        hostRefs: ['research-host'],
        workflowControlScopes: ['llm:grok:execute'],
        scope: 'workflow:approval:request',
      },
      'workflow-approvals'
    )
    const response = fetch(`http://127.0.0.1:${address.port}/internal/runtime/v1/grok/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platform}`, 'content-type': 'application/json' },
      body: JSON.stringify({ executionTicket: ticket, requestHash: 'a'.repeat(64), request: REQUEST }),
    })
    const started = Date.now()
    while (!witness.measured) {
      if (Date.now() - started > 5_000) throw new Error('the stream seam was not reached')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    try {
      // Liveness witnesses: the seam was entered, the tree was alive when the
      // stub took its reference, and the acceptance hook ran.
      expect(witness.entered).toBe(true)
      expect(witness.aliveBeforeAccept).toBe(true)
      expect(witness.collectedAfterAccept).toBe(true)
    } finally {
      finish()
    }
    expect((await response).status).toBe(200)
  })
})
