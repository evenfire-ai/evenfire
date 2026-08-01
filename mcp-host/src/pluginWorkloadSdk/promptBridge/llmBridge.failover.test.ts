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
  createBreaker?: (target: PromptBridgeTarget) => CircuitBreaker
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
    bridge: new LlmBridge(resolver, { createProvider, createBreaker }),
    providerCalls,
    credentialCalls,
    resolver,
  }
}

const request = {
  invocationId: 'inv-1',
  targets: [
    { target: primary, credentialTicket: 'ticket-primary' },
    { target: fallback, credentialTicket: 'ticket-fallback' },
  ],
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
    })
  })

  it('treats credential resolution failure as terminal and never redeems a fallback', async () => {
    const resolve = vi.fn(async () => {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'authorized provider credentials are unavailable',
        false
      )
    })
    const { bridge, providerCalls } = makeBridge({}, resolve)

    await expect(bridge.complete(request)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
    })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(providerCalls).toEqual([])
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

    const result = await bridge.complete(request)

    expect(result.servedTarget).toEqual(fallback)
    expect(credentialCalls).toEqual([fallback.targetRef])
    expect(first.completeSingleTurn).not.toHaveBeenCalled()
    expect(second.completeSingleTurn).toHaveBeenCalledOnce()
    expect(breakers.get(primary.targetRef)?.isOpen()).toBe(true)
    expect(breakers.get(fallback.targetRef)?.isOpen()).toBe(false)
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
          targets: [{ target, credentialTicket: `ticket-${attempt}` }],
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
