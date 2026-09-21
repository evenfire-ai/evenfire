import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hashCodexCompletionRequest,
  parseCodexCompletionRequest,
} from '@clerum/llm-provider-attempt-contract'
import { type CodexLlmProxyConfig } from '../src/config.js'
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

function config(): CodexLlmProxyConfig {
  return {
    runtimePort: 8080,
    adminPort: 8081,
    probePort: 9090,
    maxBodyBytes: 1_048_576,
    maxVisualBodyBytes: 24 * 1024 * 1024,
    maxStreamDurationMs: 300_000,
    maxDeadlineMs: 300_000,
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
  schemaVersion: 'codex-completion-request.v1' | 'codex-completion-request.v2'
) {
  ticketSeq += 1
  return {
    schemaVersion,
    requestId: `req-gate-${ticketSeq}`,
    idempotencyKey: `idem-gate-${ticketSeq}`,
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    messages: [{ role: 'user', content: 'hi' }],
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
  schemaVersion: 'codex-completion-request.v1' | 'codex-completion-request.v2'
): { token: string; body: string } {
  const raw = completionRequest(schemaVersion)
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
  schemaVersion: 'codex-completion-request.v1' | 'codex-completion-request.v2'
): Promise<Response> {
  const { token, body } = completionPayload(schemaVersion)
  return fetch(`http://127.0.0.1:${port}/internal/runtime/v1/codex/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body,
  })
}

describe('visual stream-gate handoff', () => {
  const hangs: Array<{ release: () => void }> = []
  const serversToClose: Array<{ close: () => Promise<void> }> = []
  const listeners: Array<ReturnType<typeof createServer>> = []

  afterEach(async () => {
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

  it('releases the visual slot for V1 and keeps it for V2; a saturated visual gate is 503', async () => {
    expect(VISUAL_STREAM_LIMITS.maxConcurrentStreams).toBe(2)
    expect(STREAM_LIMITS.maxConcurrentStreams).toBe(8)

    const hang = hangStream()
    hangs.push(hang)
    const servers = createProxyApps(config(), { streamCompletion: hang.impl })
    serversToClose.push(servers)
    const listener = createServer(servers.runtimeApp).listen(0)
    listeners.push(listener)
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    const port = address.port

    const v1 = postCompletion(port, 'codex-completion-request.v1')
    await waitFor(
      () => streamGate.snapshot().running === 1 && visualStreamGate.snapshot().running === 0,
      'V1 did not release the visual gate before taking streamGate'
    )

    const firstVisual = postCompletion(port, 'codex-completion-request.v2')
    const secondVisual = postCompletion(port, 'codex-completion-request.v2')
    await waitFor(
      () => visualStreamGate.snapshot().running === 2 && streamGate.snapshot().running === 1,
      'V2 did not keep the visual gate through the stream'
    )

    const queued = Array.from({ length: VISUAL_STREAM_LIMITS.maxQueuedRequests }, () =>
      postCompletion(port, 'codex-completion-request.v2')
    )
    await waitFor(
      () => visualStreamGate.snapshot().queued === VISUAL_STREAM_LIMITS.maxQueuedRequests,
      'visual queue did not fill to 8'
    )
    const overflow = await postCompletion(port, 'codex-completion-request.v2')
    expect(overflow.status).toBe(503)
    expect(await overflow.json()).toEqual({ error: 'provider_unavailable' })

    hang.release()
    await Promise.all([v1, firstVisual, secondVisual, ...queued])
  })
})
