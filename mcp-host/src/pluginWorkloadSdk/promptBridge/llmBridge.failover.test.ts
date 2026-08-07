import { describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import { LlmErrorCode } from '../../core/errors'
import { FinishReason } from '../../core/types'
import type { SingleTurnProvider, createLLMProvider } from '../../llm'
import type { ApiKeys, ModelConfig } from '../../types'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { PluginWorkloadError } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'
import { recordCircuitBreakerState } from '../metrics'
import { LlmBridge, type PromptBridgeCredentialResolver } from './llmBridge'

const OK = {
  content: 'ok',
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  finish_reason: FinishReason.Stop,
}
const primary: PromptBridgeTarget = {
  targetRef: 'primary-zai',
  provider: 'zai',
  model: 'glm-5.1',
  credentialSlot: 'zai-api-key',
}
const fallback: PromptBridgeTarget = {
  targetRef: 'fallback-openai',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  credentialSlot: 'openai-api-key',
}

class FakeProvider implements Partial<SingleTurnProvider> {
  constructor(
    private readonly behavior: () => Promise<typeof OK>,
    private readonly classification: { code: LlmErrorCode; retryable: boolean } = {
      code: LlmErrorCode.RateLimited,
      retryable: true,
    }
  ) {}

  completeSingleTurn = vi.fn(async () => this.behavior())
  classifyError() {
    return { ...this.classification, message: 'redacted' }
  }
}

function makeBridge(
  providers: Record<string, FakeProvider>,
  resolve?: PromptBridgeCredentialResolver['resolve'],
  createBreaker?: (target: PromptBridgeTarget) => CircuitBreaker,
  maxResponseBytes?: number
) {
  const providerCalls: string[] = []
  const credentialCalls: string[] = []
  const resolver: PromptBridgeCredentialResolver = {
    resolve:
      resolve ??
      vi.fn(async ({ target }) => {
        credentialCalls.push(target.targetRef)
        const key = `${target.provider}-api-key`
        return {
          target,
          keys: { [target.provider]: { [key]: `secret-${target.targetRef}` } } as ApiKeys,
          llmSecretName: `${target.provider}-secret`,
        }
      }),
  }
  const createProvider = ((_keys: ApiKeys, model: ModelConfig) => {
    providerCalls.push(`${model.provider}/${model.name}`)
    return (providers[model.name] ?? null) as unknown as SingleTurnProvider | null
  }) as typeof createLLMProvider
  return {
    bridge: new LlmBridge(resolver, {
      createProvider,
      createBreaker,
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    }),
    providerCalls,
    credentialCalls,
    resolver,
  }
}

const request = {
  invocationId: 'inv-1',
  attemptGeneration: 1,
  targets: [{ target: primary }, { target: fallback }],
  policyRevision: 1,
  policyHash: 'a'.repeat(64),
  credentialTicketIssuer: {
    issue: vi.fn(async ({ target }: { target: PromptBridgeTarget }) => ({
      credentialTicket: `fresh-${target.targetRef}`,
    })),
  },
  messages: [{ role: 'user' as const, content: 'hi' }],
  timeoutMs: 5_000,
}

describe('LlmBridge authorized multi-provider fallback', () => {
  it('redeems credentials per attempt and serves the next authorized provider', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('provider response')))
    const second = new FakeProvider(() => Promise.resolve(OK))
    const { bridge, providerCalls, credentialCalls } = makeBridge({
      [primary.model]: first,
      [fallback.model]: second,
    })

    const result = await bridge.complete(request)

    expect(credentialCalls).toEqual([primary.targetRef, fallback.targetRef])
    expect(providerCalls).toEqual([
      `${primary.provider}/${primary.model}`,
      `${fallback.provider}/${fallback.model}`,
    ])
    expect(result).toMatchObject({
      servedTarget: fallback,
      fallbackUsed: true,
      model: fallback.model,
      usage: { inputTokens: 3, outputTokens: 4 },
      attemptCount: 2,
    })
  })

  it('stops after every authorized target has an eligible failure', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('primary unavailable')))
    const second = new FakeProvider(() => Promise.reject(new Error('fallback unavailable')))
    const { bridge, providerCalls, credentialCalls } = makeBridge({
      [primary.model]: first,
      [fallback.model]: second,
    })

    await expect(bridge.complete(request)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      reason: 'rate_limited',
    })
    expect(credentialCalls).toEqual([primary.targetRef, fallback.targetRef])
    expect(providerCalls).toEqual([
      `${primary.provider}/${primary.model}`,
      `${fallback.provider}/${fallback.model}`,
    ])
    expect(JSON.stringify(providerCalls)).not.toContain('secret-')
  })

  it('treats a successful response without authoritative usage as an unknown spend', async () => {
    const missingUsage = new FakeProvider(() => Promise.resolve({ ...OK, usage_reported: false }))
    const { bridge, providerCalls, credentialCalls } = makeBridge({
      [primary.model]: missingUsage,
    })

    await expect(
      bridge.complete({ ...request, targets: [{ target: primary }] })
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'outcome_unknown',
      providerMayHaveExecuted: true,
    })
    expect(credentialCalls).toEqual([primary.targetRef])
    expect(providerCalls).toEqual([`${primary.provider}/${primary.model}`])
  })

  it('closes a reserved SDK-only attempt when credential resolution fails before the provider', async () => {
    const resolve = vi.fn(async () => {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'authorized provider credentials are unavailable',
        false,
        'credential_unavailable',
        false
      )
    })
    const { bridge, providerCalls } = makeBridge({}, resolve)
    const providerAttemptReporter = { report: vi.fn().mockResolvedValue(undefined) }
    const credentialTicketIssuer = {
      issue: vi.fn(async () => ({
        credentialTicket: 'fresh-primary',
        providerAttemptId: 'attempt-primary',
        providerAttemptIndex: 1,
      })),
    }

    await expect(
      bridge.complete({
        ...request,
        credentialTicketIssuer,
        providerAttemptReporter,
      })
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
      providerAttempt: {
        providerAttemptId: 'attempt-primary',
        providerAttemptIndex: 1,
        target: primary,
        attemptCount: 1,
        fallbackUsed: false,
      },
    })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(providerCalls).toEqual([])
    expect(providerAttemptReporter.report).toHaveBeenCalledWith({
      providerAttemptId: 'attempt-primary',
      providerAttemptIndex: 1,
      status: 'failed',
    })

    await expect(
      bridge.complete({
        ...request,
        acknowledgementMode: 'atomic_terminal_finalization',
        credentialTicketIssuer,
        providerAttemptReporter,
      })
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'credential_unavailable',
      providerAttempt: { providerAttemptId: 'attempt-primary' },
    })
    expect(providerAttemptReporter.report).toHaveBeenCalledTimes(2)
  })

  it('defers only the successful terminal ACK in atomic finalization mode', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OK))
    const { bridge } = makeBridge({ [primary.model]: provider })
    const providerAttemptReporter = { report: vi.fn().mockResolvedValue(undefined) }
    const credentialTicketIssuer = {
      issue: vi.fn(async () => ({
        credentialTicket: 'fresh-primary',
        providerAttemptId: 'attempt-primary',
        providerAttemptIndex: 1,
      })),
    }

    const atomic = await bridge.complete({
      ...request,
      targets: [{ target: primary }],
      acknowledgementMode: 'atomic_terminal_finalization',
      credentialTicketIssuer,
      providerAttemptReporter,
    })
    expect(atomic.providerAttemptAcknowledgement).toBe('owned_by_finalizer')
    expect(providerAttemptReporter.report).not.toHaveBeenCalled()

    const perAttempt = await bridge.complete({
      ...request,
      targets: [{ target: primary }],
      acknowledgementMode: 'per_attempt',
      credentialTicketIssuer,
      providerAttemptReporter,
    })
    expect(perAttempt.providerAttemptAcknowledgement).toBe('confirmed')
    expect(providerAttemptReporter.report).toHaveBeenCalledWith({
      providerAttemptId: 'attempt-primary',
      providerAttemptIndex: 1,
      status: 'complete',
    })
  })

  it('reissues a fresh target-bound ticket immediately before each credential resolution', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('provider response')))
    const second = new FakeProvider(() => Promise.resolve(OK))
    const issue = vi.fn(async ({ target }: { target: PromptBridgeTarget }) => ({
      credentialTicket: `fresh-${target.targetRef}`,
    }))
    const resolve = vi.fn(async ({ target, credentialTicket }) => {
      expect(credentialTicket).toBe(`fresh-${target.targetRef}`)
      return {
        target,
        keys: {
          [target.provider]: { [`${target.provider}-api-key`]: 'provider-secret' },
        } as ApiKeys,
        llmSecretName: 'provider-secret',
      }
    })
    const { bridge } = makeBridge({ [primary.model]: first, [fallback.model]: second }, resolve)

    await bridge.complete({ ...request, credentialTicketIssuer: { issue } })

    expect(issue).toHaveBeenNthCalledWith(1, {
      invocationId: 'inv-1',
      attemptGeneration: 1,
      target: primary,
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
    })
    expect(issue).toHaveBeenNthCalledWith(2, {
      invocationId: 'inv-1',
      attemptGeneration: 1,
      target: fallback,
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
    })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('does not fall back when JIT ticket issuance fails', async () => {
    const issue = vi.fn(async () => {
      throw new PluginWorkloadError('provider_unavailable', 'ticket unavailable', true)
    })
    const { bridge, credentialCalls } = makeBridge({})
    await expect(
      bridge.complete({ ...request, credentialTicketIssuer: { issue } })
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true })
    expect(issue).toHaveBeenCalledOnce()
    expect(credentialCalls).toEqual([])
  })

  it('bounds JIT ticket issuance to the request deadline', async () => {
    const issue = vi.fn(() => new Promise<{ credentialTicket: string }>(() => undefined))
    const { bridge, credentialCalls } = makeBridge({})
    await expect(
      bridge.complete({ ...request, timeoutMs: 5, credentialTicketIssuer: { issue } })
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true })
    expect(credentialCalls).toEqual([])
  })

  it('does not fallback on a provider error outside triggerOn', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('429')))
    const second = new FakeProvider(() => Promise.resolve(OK))
    const { bridge, providerCalls } = makeBridge({
      [primary.model]: first,
      [fallback.model]: second,
    })

    await expect(bridge.complete({ ...request, triggerOn: ['auth'] })).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(providerCalls).toEqual([`${primary.provider}/${primary.model}`])
  })

  it('does not use auth failures as an implicit fallback trigger', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('401')), {
      code: LlmErrorCode.AuthenticationFailed,
      retryable: false,
    })
    const second = new FakeProvider(() => Promise.resolve(OK))
    const { bridge, providerCalls } = makeBridge({
      [primary.model]: first,
      [fallback.model]: second,
    })

    await expect(bridge.complete(request)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
      reason: 'auth',
    })
    expect(providerCalls).toEqual([`${primary.provider}/${primary.model}`])
  })

  it('surfaces only a safe provider reason and never the provider body', async () => {
    const failing = new FakeProvider(() =>
      Promise.reject(new Error('provider secret response body must stay private'))
    )
    const { bridge } = makeBridge({ [primary.model]: failing })

    await expect(
      bridge.complete({ ...request, targets: [{ target: primary }] })
    ).rejects.toMatchObject({ code: 'provider_unavailable', reason: 'rate_limited' })

    try {
      await bridge.complete({ ...request, targets: [{ target: primary }] })
    } catch (error) {
      expect(error).toBeInstanceOf(PluginWorkloadError)
      expect((error as PluginWorkloadError).toBody()).toEqual({
        error: 'provider_unavailable',
        message: 'LLM provider error: LLM_RATE_LIMITED',
        retryable: true,
        reason: 'rate_limited',
      })
      expect(JSON.stringify((error as PluginWorkloadError).toBody())).not.toContain(
        'provider secret'
      )
    }
  })

  it('fails terminally when an authorized target cannot construct its provider', async () => {
    const { bridge } = makeBridge({})
    await expect(bridge.complete(request)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
    })
  })

  it('never attempts a target outside the exact authorized list', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('429')))
    const { bridge, providerCalls } = makeBridge({ [primary.model]: first })
    await expect(
      bridge.complete({ ...request, targets: [request.targets[0]] })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(providerCalls).toEqual([`${primary.provider}/${primary.model}`])
  })

  it('isolates target breakers so a failing primary still reaches a healthy fallback', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('429')))
    const second = new FakeProvider(() => Promise.resolve(OK))
    const breakers = new Map<string, CircuitBreaker>()
    const { bridge } = makeBridge(
      { [primary.model]: first, [fallback.model]: second },
      undefined,
      target => {
        const breaker = new CircuitBreaker({ minSamples: 4 })
        breakers.set(target.targetRef, breaker)
        return breaker
      }
    )

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await bridge.complete({ ...request, invocationId: `inv-${attempt}` })
      expect(result.servedTarget).toEqual(fallback)
    }
    expect(breakers.get(primary.targetRef)?.isOpen()).toBe(false)

    const fourth = await bridge.complete({ ...request, invocationId: 'inv-4' })
    expect(fourth.servedTarget).toEqual(fallback)
    expect(fourth.fallbackUsed).toBe(true)
    expect(breakers.get(primary.targetRef)?.isOpen()).toBe(true)
    expect(first.completeSingleTurn).toHaveBeenCalledTimes(4)
    expect(second.completeSingleTurn).toHaveBeenCalledTimes(4)
  })

  it('skips credential redemption for an open primary and isolates the fallback target', async () => {
    const first = new FakeProvider(() => Promise.reject(new Error('429')))
    const second = new FakeProvider(() => Promise.resolve(OK))
    const breakers = new Map<string, CircuitBreaker>()
    const { bridge, credentialCalls } = makeBridge(
      { [primary.model]: first, [fallback.model]: second },
      undefined,
      target => {
        const breaker = new CircuitBreaker({ minSamples: 4 })
        if (target.targetRef === primary.targetRef) {
          for (let attempt = 0; attempt < 4; attempt += 1) breaker.record(false)
        }
        breakers.set(target.targetRef, breaker)
        return breaker
      }
    )

    const providerAttemptReporter = { report: vi.fn() }
    const credentialTicketIssuer = {
      issue: vi.fn(async ({ target }: { target: PromptBridgeTarget }) => ({
        credentialTicket: `fresh-${target.targetRef}`,
        providerAttemptId: `attempt-${target.targetRef}`,
        providerAttemptIndex: target.targetRef === primary.targetRef ? 1 : 2,
      })),
    }

    const result = await bridge.complete({
      ...request,
      credentialTicketIssuer,
      providerAttemptReporter,
    })

    expect(result.servedTarget).toEqual(fallback)
    expect(credentialCalls).toEqual([fallback.targetRef])
    expect(first.completeSingleTurn).not.toHaveBeenCalled()
    expect(second.completeSingleTurn).toHaveBeenCalledOnce()
    expect(breakers.get(primary.targetRef)?.isOpen()).toBe(true)
    expect(breakers.get(fallback.targetRef)?.isOpen()).toBe(false)
    expect(providerAttemptReporter.report).toHaveBeenNthCalledWith(1, {
      providerAttemptId: `attempt-${primary.targetRef}`,
      providerAttemptIndex: 1,
      status: 'skipped',
    })
    expect(providerAttemptReporter.report).toHaveBeenNthCalledWith(2, {
      providerAttemptId: `attempt-${fallback.targetRef}`,
      providerAttemptIndex: 2,
      status: 'complete',
    })
  })

  it('preserves a provider completion when its audit acknowledgement fails', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OK))
    const { bridge } = makeBridge({ [primary.model]: provider })
    const providerAttemptReporter = {
      report: vi.fn().mockRejectedValue(new Error('control-api unavailable')),
    }
    const credentialTicketIssuer = {
      issue: vi.fn(async () => ({
        credentialTicket: 'fresh-primary',
        providerAttemptId: 'attempt-primary',
        providerAttemptIndex: 1,
      })),
    }

    const result = await bridge.complete({
      ...request,
      targets: [{ target: primary }],
      credentialTicketIssuer,
      providerAttemptReporter,
    })

    expect(result).toMatchObject({
      servedTarget: primary,
      content: OK.content,
      usage: { inputTokens: 3, outputTokens: 4 },
      providerAttemptAcknowledgement: 'failed',
    })
    expect(provider.completeSingleTurn).toHaveBeenCalledOnce()
    expect(providerAttemptReporter.report).toHaveBeenCalledWith({
      providerAttemptId: 'attempt-primary',
      providerAttemptIndex: 1,
      status: 'complete',
    })
  })

  it('does not turn a post-provider response rejection into a revivable failure', async () => {
    const provider = new FakeProvider(() => Promise.resolve({ ...OK, content: 'too-large' }))
    const { bridge, providerCalls } = makeBridge(
      { [primary.model]: provider },
      undefined,
      undefined,
      4
    )
    const providerAttemptReporter = { report: vi.fn().mockResolvedValue(undefined) }

    await expect(
      bridge.complete({
        ...request,
        targets: [{ target: primary }],
        credentialTicketIssuer: {
          issue: vi.fn(async () => ({
            credentialTicket: 'fresh-primary',
            providerAttemptId: 'attempt-primary',
            providerAttemptIndex: 1,
          })),
        },
        providerAttemptReporter,
      })
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
      reason: 'outcome_unknown',
      providerMayHaveExecuted: true,
    })
    expect(providerCalls).toEqual([`${primary.provider}/${primary.model}`])
    expect(providerAttemptReporter.report).toHaveBeenCalledWith({
      providerAttemptId: 'attempt-primary',
      providerAttemptIndex: 1,
      status: 'provider_unavailable',
    })
  })

  it('publishes circuit state under the effective target label', async () => {
    const target = { ...primary, targetRef: `metric-${Date.now()}` }
    const failing = new FakeProvider(() => Promise.reject(new Error('429')))
    const { bridge } = makeBridge(
      { [target.model]: failing },
      undefined,
      effectiveTarget =>
        new CircuitBreaker({
          minSamples: 4,
          onStateChange: open =>
            recordCircuitBreakerState(`llm-provider:${effectiveTarget.targetRef}`, open),
        })
    )

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        bridge.complete({
          ...request,
          invocationId: `metric-${attempt}`,
          targets: [{ target }],
        })
      ).rejects.toMatchObject({ code: 'provider_unavailable' })
    }

    const metric = register.getSingleMetric('clerum_plugin_workload_sdk_circuit_breaker_state')
    const data = await metric?.get()
    expect(
      data?.values.find(
        value =>
          value.labels.gateway === `llm-provider:${target.targetRef}` &&
          value.labels.state === 'open'
      )?.value
    ).toBe(1)
  })
})
