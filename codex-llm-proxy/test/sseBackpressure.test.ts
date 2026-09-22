import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
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
import { createProxyApps, writeSseChunk } from '../src/server.js'

function fakeResponse(writeResult: boolean) {
  const written: string[] = []
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    write(chunk: string) {
      written.push(chunk)
      return writeResult
    },
  })
  return { res, written }
}

async function settled(promise: Promise<unknown>, withinMs = 30): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await new Promise(resolve => setTimeout(resolve, withinMs))
  return done
}

describe('writeSseChunk backpressure', () => {
  it('does not wait when the socket accepted the chunk', async () => {
    const { res, written } = fakeResponse(true)
    const pending = writeSseChunk(res as never, 'data: {}\n\n', new AbortController().signal)
    expect(pending).toBeUndefined()
    expect(written).toEqual(['data: {}\n\n'])
  })

  it('waits for drain when res.write reports a full buffer', async () => {
    const { res } = fakeResponse(false)
    const pending = writeSseChunk(res as never, 'data: {}\n\n', new AbortController().signal)
    expect(pending).toBeInstanceOf(Promise)
    expect(await settled(pending as Promise<void>)).toBe(false)
    res.emit('drain')
    expect(await settled(pending as Promise<void>)).toBe(true)
  })

  it('stops waiting when the client closes or the stream aborts', async () => {
    const closed = fakeResponse(false)
    const onClose = writeSseChunk(closed.res as never, 'x', new AbortController().signal)
    closed.res.emit('close')
    expect(await settled(onClose as Promise<void>)).toBe(true)

    const aborted = fakeResponse(false)
    const abort = new AbortController()
    const onAbort = writeSseChunk(aborted.res as never, 'x', abort.signal)
    abort.abort()
    expect(await settled(onAbort as Promise<void>)).toBe(true)
  })
})

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

function config(): CodexLlmProxyConfig {
  return {
    runtimePort: 0,
    adminPort: 0,
    probePort: 0,
    maxBodyBytes: 1_048_576,
    maxStreamDurationMs: 60_000,
    maxDeadlineMs: 60_000,
    upstreamIdleTimeoutMs: 300_000,
    jwtIssuer: 'control-api',
    jwtPublicKey: publicKey,
    executionEnabled: true,
    controlApiBaseUrl: 'http://control-api.invalid/api/v1',
    controlApiServiceName: 'codex-llm-proxy',
    controlApiServiceToken: 'unused',
  }
}

const DELTA_BYTES = 64 * 1024
const DELTA_COUNT = 1000
const TOTAL_BYTES = DELTA_BYTES * DELTA_COUNT

describe('slow SSE consumer', () => {
  it('stops pulling the upstream while the client is not reading, then delivers everything', async () => {
    const hostRef = 'research-host'
    const raw = {
      schemaVersion: 'codex-completion-request.v1',
      requestId: 'req-backpressure',
      idempotencyKey: 'idem-backpressure',
      provider: 'codex-subscription',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'stream a lot' }],
    }
    const parsed = parseCodexCompletionRequestV1(raw)
    if (!parsed.ok) throw new Error(parsed.message)
    const requestHash = hashCodexCompletionRequestV1(parsed.value)

    const finalizes: string[] = []
    const client = {
      async redeem(): Promise<RedeemAttemptSuccess> {
        return {
          accessToken: 'test-access-backpressure',
          chatgptAccountId: 'acct-backpressure',
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
        finalizes.push(input.receipt.outcome)
        return {
          providerAttemptId: input.receipt.providerAttemptId,
          outcome: input.receipt.outcome,
          duplicate: false,
        }
      },
    } as unknown as ControlApiClient

    const delta = 'x'.repeat(DELTA_BYTES)
    const encoder = new TextEncoder()
    let pulledDeltas = 0
    const fetchFn = (async () => {
      let sentCompleted = false
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulledDeltas < DELTA_COUNT) {
              pulledDeltas += 1
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`
                )
              )
              return
            }
            if (!sentCompleted) {
              sentCompleted = true
              controller.enqueue(
                encoder.encode('data: {"type":"response.completed","response":{"usage":{}}}\n\n')
              )
              return
            }
            controller.close()
          },
        },
        { highWaterMark: 0 }
      )
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch

    const servers = createProxyApps(config(), {
      controlApiClient: client,
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    await new Promise<void>(resolve => servers.runtime.listen(0, '127.0.0.1', () => resolve()))
    const { port } = servers.runtime.address() as AddressInfo
    try {
      const payload = JSON.stringify({
        executionTicket: sign(
          {
            jti: '44444444-4444-4444-8444-444444444444',
            typ: 'codex-execution-ticket',
            hostRef,
            model: 'gpt-5.1',
            requestHash,
            providerAttemptId: 'att-backpressure',
          },
          'codex-llm-proxy'
        ),
        requestHash,
        request: raw,
      })
      const platform = sign(
        {
          sub: `default/${hostRef}`,
          hostRefs: [hostRef],
          workflowControlScopes: ['llm:codex:execute'],
          scope: 'workflow:approval:request',
        },
        'workflow-approvals'
      )

      const text = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/internal/runtime/v1/codex/completions',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${platform}`,
              'content-length': Buffer.byteLength(payload),
            },
          },
          res => {
            // Slow consumer: stop reading immediately and wait for the proxy
            // to settle before asserting how much upstream it consumed.
            res.pause()
            void (async () => {
              let last = -1
              const deadline = Date.now() + 5_000
              while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 250))
                if (pulledDeltas === last) break
                last = pulledDeltas
              }
              try {
                expect(pulledDeltas * DELTA_BYTES).toBeLessThan(TOTAL_BYTES / 2)
              } catch (err) {
                res.destroy()
                reject(err)
                return
              }
              const chunks: Buffer[] = []
              res.on('data', chunk => chunks.push(chunk as Buffer))
              res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
              res.on('error', reject)
              res.resume()
            })()
          }
        )
        req.on('error', reject)
        req.end(payload)
      })

      expect(pulledDeltas).toBe(DELTA_COUNT)
      const frames = text
        .split('\n\n')
        .filter(part => part.startsWith('data: '))
        .map(part => JSON.parse(part.slice(6)) as { type: string; outcome?: string })
      expect(frames.filter(frame => frame.type === 'text')).toHaveLength(DELTA_COUNT)
      expect(frames.at(-1)).toMatchObject({ type: 'done', outcome: 'success' })
      expect(finalizes).toEqual(['success'])
    } finally {
      await servers.close()
    }
  }, 30_000)
})
