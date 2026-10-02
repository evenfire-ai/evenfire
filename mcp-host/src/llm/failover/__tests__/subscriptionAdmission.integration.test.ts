import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { type RequestListener, createServer } from 'node:http'
import { type Socket, connect as connectTcp } from 'node:net'
import { LlmErrorCode } from '../../../core/errors'
import { CodexLlmProxyClient } from '../../codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../../codexSubscription'
import { GrokLlmProxyClient } from '../../grokLlmProxyClient'
import { GrokSubscriptionProvider } from '../../grokSubscription'
import { type ClassifiedLike, FailoverEngine } from '../engine'
import type { FailoverTarget, ModelPair } from '../types'

type Gate = {
  acquire(signal?: AbortSignal, deadlineAt?: number): Promise<() => void>
  snapshot(): { running: number; queued: number }
}
type Budget = { readonly inFlightBytes: number; readonly queued: number }
type ProxyLimitModule = {
  streamGate: Gate
  visualStreamGate: Gate
  STREAM_LIMITS: { maxConcurrentStreams: number; maxQueuedRequests: number }
  VISUAL_STREAM_LIMITS: { maxConcurrentStreams: number; maxQueuedRequests: number }
  VISUAL_PER_HOST_MAX_ADMITTED: number
  BodyBudget: {
    prototype: {
      acquire(bytes: number, signal?: AbortSignal, deadlineAt?: number): Promise<() => void>
    }
  }
}
type ProxyModule = {
  createProxyApps(
    config: Record<string, unknown>,
    deps: Record<string, unknown>
  ): { runtimeApp: RequestListener; close(): Promise<void> }
}
type StreamInput = {
  executionTicket: string
  requestHash: string
  redeem(input: unknown): Promise<unknown>
  onFrame(frame: { type: 'text'; text: string }): Promise<unknown>
}
type LocalProducer =
  | 'visual_host_share'
  | 'visual_gate'
  | 'stream_queue_full'
  | 'stream_queue_wait'
  | 'body_queue_full'
  | 'demotion_queue_full'
const LOCAL_PRODUCERS: LocalProducer[] = [
  'visual_host_share',
  'visual_gate',
  'stream_queue_full',
  'stream_queue_wait',
  'body_queue_full',
  'demotion_queue_full',
]
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(label)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
async function fixture(variant: 'grok' | 'codex') {
  // Runtime imports preserve Host's production compiler boundary. This test
  // exercises actual proxy HTTP producers, Host decoding and failover state.
  const base = `../../../../../${variant}-llm-proxy/src/`
  const proxyModule = await vi.importActual<ProxyModule>(`${base}server.ts`)
  const limits = await vi.importActual<ProxyLimitModule>(`${base}requestLimits.ts`)
  const model = variant === 'grok' ? 'grok-4.6' : 'gpt-5.3-codex'
  const provider = `${variant}-subscription`
  const platform = jwt.sign(
    {
      sub: 'default/admission-host',
      hostRefs: ['admission-host'],
      workflowControlScopes: [`llm:${variant}:execute`],
      scope: 'workflow:approval:request',
    },
    privateKey,
    { algorithm: 'RS256', issuer: 'control-api', audience: 'workflow-approvals', expiresIn: 60 }
  )
  const redeem = vi.fn(async () => undefined)
  // Refusals must never reach this transport seam. A later accepted route uses
  // it as a positive route/Host witness, not as real upstream compatibility.
  const stream = vi.fn(async (input: StreamInput) => {
    await input.redeem({ executionTicket: input.executionTicket, requestHash: input.requestHash })
    await input.onFrame({ type: 'text', text: 'primary route recovered' })
    return { outcome: 'success' as const }
  })
  const apps = proxyModule.createProxyApps(
    {
      runtimePort: 0,
      adminPort: 0,
      probePort: 0,
      maxBodyBytes: 4096,
      maxVisualBodyBytes: 8192,
      maxStreamDurationMs: 1000,
      maxDeadlineMs: 1000,
      upstreamIdleTimeoutMs: 1000,
      heartbeatIntervalMs: 15000,
      jwtIssuer: 'control-api',
      jwtPublicKey: publicKey,
      executionEnabled: true,
      controlApiBaseUrl: '',
      controlApiServiceName: `${variant}-llm-proxy`,
      controlApiServiceToken: '',
    },
    { controlApiClient: { redeem }, streamCompletion: stream, bodyReadDeadlineMs: 5000 }
  )
  const listener = createServer(apps.runtimeApp).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('the proxy has no local listener')
  const port = address.port
  const path = `/internal/runtime/v1/${variant}/completions`
  const url = `http://127.0.0.1:${port}${path}`
  const sockets: Socket[] = []
  const held: Array<() => void> = []
  const queued: Array<Promise<void>> = []
  let restoreQueueClock: (() => void) | undefined
  let padded = false
  const hostFetch = vi.fn<typeof fetch>().mockImplementation((input, init) =>
    fetch(input, {
      ...init,
      // A padded caller can have large wire bytes and a small logical V1 body.
      ...(padded ? { body: `${String(init?.body)}${' '.repeat(5000)}` } : {}),
      signal: init?.signal ?? AbortSignal.timeout(5000),
    })
  )
  const clientOptions = { runtimeUrl: url, readPlatformJwt: () => platform, fetchFn: hostFetch }
  const client =
    variant === 'grok'
      ? new GrokLlmProxyClient(clientOptions)
      : new CodexLlmProxyClient(clientOptions)
  const authorize = vi.fn(async (input: { requestHash: string }) => {
    const id = randomUUID()
    return {
      providerAttemptId: id,
      requestHash: input.requestHash,
      executionTicket: jwt.sign(
        {
          jti: id,
          typ: `${variant}-execution-ticket`,
          hostRef: 'admission-host',
          model,
          requestHash: input.requestHash,
          providerAttemptId: id,
        },
        privateKey,
        {
          algorithm: 'RS256',
          issuer: 'control-api',
          audience: `${variant}-llm-proxy`,
          expiresIn: 60,
        }
      ),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
  })
  const deps = {
    authorizer: { authorize },
    proxy: client,
    attemptContext: () => ({
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
      hostRef: 'admission-host',
    }),
  }
  const primaryProvider =
    variant === 'grok'
      ? new GrokSubscriptionProvider(model, deps as never)
      : new CodexSubscriptionProvider(model, deps as never)
  const primary: ModelPair = { provider, model }
  const onSwitch = vi.fn(),
    metricInc = vi.fn()
  const engine = new FailoverEngine(
    {
      cooldownSeconds: 300,
      triggerOn: ['provider_unavailable', 'rate_limited'],
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
    },
    { onSwitch, metricInc }
  )
  const fallback = vi.fn(async () => ({ content: 'fallback' }))
  const built: FailoverTarget[] = []
  let classified: ClassifiedLike | undefined
  const run = (content: string) =>
    engine.run<{ content: string }>(
      primary,
      target => {
        built.push(target)
        return target.kind === 'primary'
          ? () => primaryProvider.completeSingleTurn([{ role: 'user', content }])
          : fallback
      },
      err => {
        classified = primaryProvider.classifyError(err)
        return classified
      }
    )
  const stopCapacity = async () => {
    padded = false
    for (const socket of sockets.splice(0)) socket.destroy()
    for (const release of held.splice(0)) release()
    await Promise.all(queued.splice(0))
    restoreQueueClock?.()
    restoreQueueClock = undefined
    await until(() => {
      const ordinary = limits.streamGate.snapshot(),
        visual = limits.visualStreamGate.snapshot()
      return (
        ordinary.running === 0 &&
        ordinary.queued === 0 &&
        visual.running === 0 &&
        visual.queued === 0
      )
    }, 'the proxy admission fixture did not drain')
  }
  cleanup.push(async () => {
    await stopCapacity()
    listener.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      listener.close(err => (err ? reject(err) : resolve()))
    )
    await apps.close()
  })
  function park(count: number, declared: number): void {
    for (let index = 0; index < count; index += 1) {
      const socket = connectTcp(port, '127.0.0.1')
      sockets.push(socket)
      socket.once('connect', () =>
        socket.write(
          `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `Authorization: Bearer ${platform}\r\nContent-Type: application/json\r\nContent-Length: ${declared}\r\n\r\n{`
        )
      )
      socket.on('error', err => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') throw err
      })
      socket.resume()
    }
  }
  async function fill(gate: Gate, width: number, waiters: number): Promise<void> {
    for (let index = 0; index < width; index += 1) held.push(await gate.acquire())
    for (let index = 0; index < waiters; index += 1)
      queued.push(gate.acquire().then(release => release()))
    await until(() => gate.snapshot().queued === waiters, 'the actual stream gate was not filled')
  }
  async function block(kind: LocalProducer): Promise<void> {
    if (kind === 'visual_host_share') {
      park(limits.VISUAL_PER_HOST_MAX_ADMITTED, 6000)
      await until(() => {
        const s = limits.visualStreamGate.snapshot()
        return s.running + s.queued === limits.VISUAL_PER_HOST_MAX_ADMITTED
      }, 'the actual principal share was not filled')
    } else if (kind === 'visual_gate') {
      await fill(
        limits.visualStreamGate,
        limits.VISUAL_STREAM_LIMITS.maxConcurrentStreams,
        limits.VISUAL_STREAM_LIMITS.maxQueuedRequests
      )
    } else if (kind === 'stream_queue_full') {
      await fill(
        limits.streamGate,
        limits.STREAM_LIMITS.maxConcurrentStreams,
        limits.STREAM_LIMITS.maxQueuedRequests
      )
    } else if (kind === 'stream_queue_wait') {
      // Shorten only the actual gate clock; producer and HTTP path stay real.
      const oldClock: unknown = Reflect.get(limits.streamGate, 'maxQueueWaitMs')
      Reflect.set(limits.streamGate, 'maxQueueWaitMs', 35)
      restoreQueueClock = () => {
        Reflect.set(limits.streamGate, 'maxQueueWaitMs', oldClock)
      }
      await fill(limits.streamGate, limits.STREAM_LIMITS.maxConcurrentStreams, 0)
    } else {
      const acquisitions = vi.spyOn(limits.BodyBudget.prototype, 'acquire')
      park(3, 4096)
      await until(
        () => (acquisitions.mock.contexts[0] as Budget | undefined)?.inFlightBytes === 3 * 4096,
        'the ordinary readers did not take the byte budget'
      )
      const budget = acquisitions.mock.contexts[0] as Budget
      park(limits.STREAM_LIMITS.maxQueuedRequests, 4096)
      await until(
        () => budget.queued === limits.STREAM_LIMITS.maxQueuedRequests,
        'the actual body queue was not filled'
      )
      padded = kind === 'demotion_queue_full'
    }
  }
  return {
    block,
    stopCapacity,
    run,
    engine,
    primary,
    authorize,
    redeem,
    stream,
    hostFetch,
    fallback,
    built,
    onSwitch,
    metricInc,
    classified: () => classified,
  }
}
describe.each(['grok', 'codex'] as const)(
  '%s subscription HTTP admission and failover',
  variant => {
    it.each(LOCAL_PRODUCERS)(
      'local %s keeps the next turn on primary without redeem or failover',
      async kind => {
        const f = await fixture(variant)
        await f.block(kind)
        const content = kind.startsWith('visual_') ? 'x'.repeat(5000) : 'bounded text'
        const code = kind.startsWith('visual_') ? kind : 'proxy_capacity_exceeded'
        await expect(f.run(content)).rejects.toMatchObject({ code, dispatched: true })
        expect(f.classified()).toMatchObject({
          code: LlmErrorCode.ApiCallFailed,
          retryable: false,
          providerCode: code,
          providerDispatched: true,
        })
        expect(f.authorize).toHaveBeenCalledTimes(1)
        expect(f.hostFetch).toHaveBeenCalledTimes(1)
        expect(f.redeem).not.toHaveBeenCalled()
        expect(f.stream).not.toHaveBeenCalled()
        expect(f.built.map(target => target.kind)).toEqual(['primary'])
        expect(f.fallback).not.toHaveBeenCalled()
        expect(f.onSwitch).not.toHaveBeenCalled()
        expect(f.metricInc).not.toHaveBeenCalled()
        expect(f.engine.planTargets(f.primary)[0]?.kind).toBe('primary')
        await f.stopCapacity()
        expect((await f.run('next ordinary text')).content).toBe('primary route recovered')
        expect(f.authorize).toHaveBeenCalledTimes(2)
        expect(f.hostFetch).toHaveBeenCalledTimes(2)
        expect(f.redeem).toHaveBeenCalledTimes(1)
        expect(f.stream).toHaveBeenCalledTimes(1)
        expect(f.built.map(target => target.kind)).toEqual(['primary', 'primary'])
        expect(f.fallback).not.toHaveBeenCalled()
        expect(f.engine.servedBy()).toEqual({ ...f.primary, fallback: false })
      }
    )
  }
)
