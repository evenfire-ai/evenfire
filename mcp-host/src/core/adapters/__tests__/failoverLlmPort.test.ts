import { describe, expect, it, vi } from 'vitest'
import { SingleTurnProvider } from '../../../llm'
import { FailoverEngine } from '../../../llm/failover/engine'
import type { LlmPolicy } from '../../../llm/failover/types'
import type { LlmUsageEvent } from '../../../usage/usageReporter'
import { LlmError, LlmErrorCode } from '../../errors'
import { FinishReason } from '../../types'
import { maybeWrapFailover } from '../failoverLlmPort'
import { AdapterStaticContext, LlmPortAdapter } from '../llmPortAdapter'

const STATIC_CTX: AdapterStaticContext = {
  host_ref: 'trader',
  context_ref: 'ctx',
  llm_secret_name: 'chatllm-api-keys',
}

/** A provider whose tool-call either resolves or rejects with a classified error. */
function fakeProvider(providerType: string, behavior: () => Promise<unknown>): SingleTurnProvider {
  return {
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(() => behavior()),
    getProviderType: () => providerType,
    classifyError: (err: unknown) => {
      if (err instanceof LlmError)
        return { code: err.code, retryable: err.retryable, message: err.message }
      return { code: LlmErrorCode.ApiCallFailed, retryable: true, message: 'x' }
    },
  } as unknown as SingleTurnProvider
}

function okResponse(model: string) {
  return {
    content: `served-by-${model}`,
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    finish_reason: FinishReason.Stop,
  }
}

const policy: LlmPolicy = {
  cooldownSeconds: 300,
  triggerOn: ['insufficient_quota', 'auth', 'provider_unavailable', 'rate_limited'],
  fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
}

describe('FailoverLlmPort — adapter-per-attempt metering', () => {
  it('meters ONLY the winning call, with the fallback pair', async () => {
    const events: LlmUsageEvent[] = []
    const reporter = { enqueue: (e: LlmUsageEvent) => events.push(e) } as {
      enqueue: (e: LlmUsageEvent) => void
    }

    // Primary (claude) throws a rate-limit; fallback (openai) succeeds.
    const primaryProvider = fakeProvider('claude', () =>
      Promise.reject(new LlmError('429', 'claude', LlmErrorCode.RateLimited, true))
    )
    const fallbackProvider = fakeProvider('openai', () => Promise.resolve(okResponse('gpt-5.4')))

    const primaryPort = new LlmPortAdapter(
      primaryProvider,
      'claude-sonnet-4-6',
      'claude',
      reporter as never,
      STATIC_CTX,
      { source_kind: 'agent' } as never
    )

    const engine = new FailoverEngine(policy, { metricInc: () => {} })
    const wrapped = maybeWrapFailover({
      primaryPort,
      primaryPair: { provider: 'claude', model: 'claude-sonnet-4-6' },
      engine,
      policy,
      buildFallbackPort: () =>
        new LlmPortAdapter(fallbackProvider, 'gpt-5.4', 'openai', reporter as never, STATIC_CTX, {
          source_kind: 'agent',
        } as never),
    })

    const res = await wrapped.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })

    expect(res.content).toBe('served-by-gpt-5.4')
    // Exactly ONE usage event — the winner — and it carries the FALLBACK pair.
    expect(events).toHaveLength(1)
    expect(events[0].provider).toBe('openai')
    expect(events[0].model).toBe('gpt-5.4')
    expect(engine.servedBy()).toEqual({ provider: 'openai', model: 'gpt-5.4', fallback: true })
  })

  it('reports the port-served model (same-provider fallback serves the session model, not entry.model)', async () => {
    // R5.7 / FIX-2: a SAME-provider fallback serves the SESSION model. The
    // adapter is built with servedModel = primaryModel, so its modelName() (not
    // the CRD entry.model) must drive servedBy + the winning usage event.
    const events: LlmUsageEvent[] = []
    const reporter = { enqueue: (e: LlmUsageEvent) => events.push(e) } as {
      enqueue: (e: LlmUsageEvent) => void
    }
    // Entry model is the "wrong" one the engine plans; the built port serves the
    // session model instead.
    const sameProviderPolicy: LlmPolicy = {
      ...policy,
      fallbacks: [{ provider: 'claude', model: 'claude-haiku-4-5' }],
    }
    const primaryPort = new LlmPortAdapter(
      fakeProvider('claude', () =>
        Promise.reject(new LlmError('429', 'claude', LlmErrorCode.RateLimited, true))
      ),
      'claude-sonnet-4-6',
      'claude',
      reporter as never,
      STATIC_CTX,
      { source_kind: 'agent' } as never
    )
    const engine = new FailoverEngine(sameProviderPolicy, { metricInc: () => {} })
    const wrapped = maybeWrapFailover({
      primaryPort,
      primaryPair: { provider: 'claude', model: 'claude-sonnet-4-6' },
      engine,
      policy: sameProviderPolicy,
      // Built with the SESSION model (as taskExecutor does for a same-provider entry).
      buildFallbackPort: () =>
        new LlmPortAdapter(
          fakeProvider('claude', () => Promise.resolve(okResponse('claude-sonnet-4-6'))),
          'claude-sonnet-4-6',
          'claude',
          reporter as never,
          STATIC_CTX,
          { source_kind: 'agent' } as never
        ),
    })

    const res = await wrapped.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })

    expect(res.content).toBe('served-by-claude-sonnet-4-6')
    // servedBy + the usage event carry the SESSION model, not entry.model.
    expect(engine.servedBy()).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      fallback: true,
    })
    expect(events).toHaveLength(1)
    expect(events[0].model).toBe('claude-sonnet-4-6')
  })

  it('indexes buildFallbackPort against the SAME full fallback list the engine iterates', async () => {
    // Regression for the boot-fallback index-misalignment blocker: the engine
    // emits full-list indices; buildFallbackPort must read the same list.
    const twoEntry: LlmPolicy = {
      ...policy,
      fallbacks: [
        { provider: 'openai', model: 'gpt-5.4' }, // index 0
        { provider: 'zai', model: 'glm-5.1' }, // index 1
      ],
    }
    const primaryPort = new LlmPortAdapter(
      fakeProvider('claude', () =>
        Promise.reject(new LlmError('429', 'claude', LlmErrorCode.RateLimited, true))
      ),
      'claude-sonnet-4-6',
      'claude'
    )
    const engine = new FailoverEngine(twoEntry, { metricInc: () => {} })
    const builtIndexes: number[] = []
    const wrapped = maybeWrapFailover({
      primaryPort,
      primaryPair: { provider: 'claude', model: 'claude-sonnet-4-6' },
      engine,
      policy: twoEntry,
      buildFallbackPort: index => {
        builtIndexes.push(index)
        const entry = twoEntry.fallbacks[index]
        // index 0 unconstructible; index 1 serves — asserts entry lookup aligns.
        if (index === 0) return null
        return new LlmPortAdapter(
          fakeProvider(entry.provider, () => Promise.resolve(okResponse(entry.model))),
          entry.model,
          entry.provider
        )
      },
    })
    const res = await wrapped.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    expect(res.content).toBe('served-by-glm-5.1')
    expect(builtIndexes).toEqual([0, 1])
    expect(engine.servedBy()).toEqual({ provider: 'zai', model: 'glm-5.1', fallback: true })
  })

  it('returns the primary port unchanged when the policy has no fallbacks', () => {
    const primaryPort = new LlmPortAdapter(
      fakeProvider('claude', () => Promise.resolve(okResponse('x'))),
      'm',
      'claude'
    )
    const engine = new FailoverEngine({ ...policy, fallbacks: [] }, { metricInc: () => {} })
    const wrapped = maybeWrapFailover({
      primaryPort,
      primaryPair: { provider: 'claude', model: 'm' },
      engine,
      policy: { ...policy, fallbacks: [] },
      buildFallbackPort: () => null,
    })
    expect(wrapped).toBe(primaryPort)
  })
})
