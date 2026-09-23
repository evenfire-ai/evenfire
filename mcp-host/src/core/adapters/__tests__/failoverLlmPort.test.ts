import { describe, expect, it, vi } from 'vitest'
import { SingleTurnProvider } from '../../../llm'
import { FailoverEngine } from '../../../llm/failover/engine'
import type { LlmPolicy } from '../../../llm/failover/types'
import type { LlmUsageEvent } from '../../../usage/usageReporter'
import type { ImageInputCapability } from '../../../visualInput/policy'
import { LlmError, LlmErrorCode } from '../../errors'
import { type ChatMessage, FinishReason, type ToolCompletionRequest } from '../../types'
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

/**
 * The visual destination is a per-attempt property, not a per-session one: a
 * fallback entry is served by its OWN adapter, so the image gate must run again
 * against THAT destination before the request reaches its provider. These tests
 * drive the real wrapper + engine (no hand-built port) so a change in the
 * delegation of `getImageInputCapability` or in the per-attempt gate fails here.
 */
describe('FailoverLlmPort — visual destination failover', () => {
  const GFS_SOURCE = {
    kind: 'gfs' as const,
    drive: 'main',
    resourceId: 'a'.repeat(32),
    gfsUri: `gfs://main/${'a'.repeat(32)}`,
    version: 3,
    name: 'neutral.png',
  }

  const supported = (provider: string, model: string): ImageInputCapability =>
    Object.freeze({
      status: 'supported' as const,
      provider,
      model,
      evidence: `${provider}-model-metadata`,
    })

  function visionAdapter(provider: SingleTurnProvider, model: string, providerName: string) {
    return new LlmPortAdapter(
      provider,
      model,
      providerName,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        capability: {
          state: 'supported',
          evidence: {
            source: 'curated',
            reference: 'https://docs.evenfire.ai/testing/image-input',
            checkedAt: '2026-09-18T00:00:00Z',
          },
        },
      })
    )
  }

  /** A provider that proves image support for exactly one model, or proves none. */
  function visionProvider(
    providerType: string,
    capability: ImageInputCapability,
    outcome: () => Promise<unknown>
  ) {
    return {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(outcome),
      getProviderType: () => providerType,
      getImageInputCapability: vi.fn(() => Promise.resolve(capability)),
      classifyError: (err: unknown) => {
        if (err instanceof LlmError)
          return { code: err.code, retryable: err.retryable, message: err.message }
        return { code: LlmErrorCode.ApiCallFailed, retryable: true, message: 'x' }
      },
    } as unknown as SingleTurnProvider & {
      completeSingleTurnWithTools: ReturnType<typeof vi.fn>
    }
  }

  function imageRequest(): ToolCompletionRequest {
    // Canonical base64 lets the transport guard reach the destination decision.
    return {
      messages: [
        {
          role: 'user',
          content: 'inspect the image',
          contentParts: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'QUJD',
              source: GFS_SOURCE,
            },
          ],
        },
      ],
      tools: [],
    }
  }

  it('rejects a fallback that cannot prove image input before calling its provider', async () => {
    const primaryProvider = visionProvider(
      'openrouter',
      supported('openrouter', 'example/vision-model'),
      () => Promise.reject(new LlmError('429', 'openrouter', LlmErrorCode.RateLimited, true))
    )
    const fallbackProvider = visionProvider('openai', { status: 'unknown' }, () =>
      Promise.resolve(okResponse('gpt-5.4'))
    )
    const switches: { from: string; to: string; reason: string }[] = []
    const engine = new FailoverEngine(policy, { metricInc: labels => switches.push(labels) })
    const wrapped = maybeWrapFailover({
      primaryPort: visionAdapter(primaryProvider, 'example/vision-model', 'openrouter'),
      primaryPair: { provider: 'openrouter', model: 'example/vision-model' },
      engine,
      policy,
      buildFallbackPort: () => new LlmPortAdapter(fallbackProvider, 'gpt-5.4', 'openai'),
    })

    await expect(wrapped.completeWithTools(imageRequest())).rejects.toThrow(
      'Image input support for openai/gpt-5.4'
    )

    // The image reached the primary (which proved support), the engine really
    // switched, and the unproven fallback was refused BEFORE its provider call.
    expect(primaryProvider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    expect(switches).toEqual([
      { from: 'openrouter/example/vision-model', to: 'openai/gpt-5.4', reason: 'rate_limited' },
    ])
    expect(fallbackProvider.completeSingleTurnWithTools).not.toHaveBeenCalled()
    expect(engine.servedBy()).toBeNull()
  })

  it('reports the winner destination capability after a fallback serves the image request', async () => {
    // A real cross-provider fallback: the primary (Claude) proves image support
    // for its own model, and the OpenRouter entry proves it for another one.
    const imagePolicy: LlmPolicy = {
      ...policy,
      fallbacks: [{ provider: 'openrouter', model: 'meta/llama-3.2-11b-vision' }],
    }
    const primaryProvider = visionProvider('claude', supported('claude', 'claude-sonnet-4-6'), () =>
      Promise.reject(new LlmError('402', 'claude', LlmErrorCode.InsufficientQuota, false))
    )
    const fallbackProvider = visionProvider(
      'openrouter',
      supported('openrouter', 'meta/llama-3.2-11b-vision'),
      () => Promise.resolve(okResponse('meta/llama-3.2-11b-vision'))
    )
    let now = 1000
    const engine = new FailoverEngine(imagePolicy, { metricInc: () => {}, now: () => now })
    const wrapped = maybeWrapFailover({
      primaryPort: visionAdapter(primaryProvider, 'claude-sonnet-4-6', 'claude'),
      primaryPair: { provider: 'claude', model: 'claude-sonnet-4-6' },
      engine,
      policy: imagePolicy,
      buildFallbackPort: () =>
        visionAdapter(fallbackProvider, 'meta/llama-3.2-11b-vision', 'openrouter'),
    })

    // Before any call, the only destination this session has proven is the primary.
    await expect(wrapped.getImageInputCapability!()).resolves.toEqual(
      supported('claude', 'claude-sonnet-4-6')
    )

    const response = await wrapped.completeWithTools(imageRequest())

    expect(response.content).toBe('served-by-meta/llama-3.2-11b-vision')
    expect(fallbackProvider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    const [messages, , options] = fallbackProvider.completeSingleTurnWithTools.mock.calls[0]
    expect(options.verifyImageInput).toBe(true)
    expect(
      (messages as ChatMessage[]).some(m => m.contentParts?.some(p => p.type === 'image'))
    ).toBe(true)
    expect(engine.servedBy()).toEqual({
      provider: 'openrouter',
      model: 'meta/llama-3.2-11b-vision',
      fallback: true,
    })

    // The winning destination answers for ITS OWN model, with its own evidence.
    await expect(wrapped.getImageInputCapability!()).resolves.toEqual(
      supported('openrouter', 'meta/llama-3.2-11b-vision')
    )
    now += imagePolicy.cooldownSeconds * 1000 + 1
    await expect(wrapped.getImageInputCapability!()).resolves.toEqual(
      supported('claude', 'claude-sonnet-4-6')
    )
  })

  it.each(['before', 'during', 'late-success'] as const)(
    'does not dispatch fallback or accept a result after cancellation: %s',
    async phase => {
      const controller = new AbortController()
      const primaryProvider = fakeProvider('claude', async () => {
        controller.abort()
        if (phase === 'late-success') return okResponse('claude-sonnet-4-6')
        throw new LlmError('aborted upstream', 'claude', LlmErrorCode.ApiCallFailed, true)
      })
      const buildFallbackPort = vi.fn(
        () =>
          new LlmPortAdapter(
            fakeProvider('openai', async () => okResponse('gpt-5.4')),
            'gpt-5.4',
            'openai'
          )
      )
      const metricInc = vi.fn()
      const engine = new FailoverEngine(policy, { metricInc })
      const wrapped = maybeWrapFailover({
        primaryPort: new LlmPortAdapter(primaryProvider, 'claude-sonnet-4-6', 'claude'),
        primaryPair: { provider: 'claude', model: 'claude-sonnet-4-6' },
        engine,
        policy,
        buildFallbackPort,
      })
      if (phase === 'before') controller.abort()
      await expect(
        wrapped.completeWithTools({
          messages: [{ role: 'user', content: 'cancelled task' }],
          tools: [],
          signal: controller.signal,
        })
      ).rejects.toThrow()
      expect(primaryProvider.completeSingleTurnWithTools).toHaveBeenCalledTimes(
        phase === 'before' ? 0 : 1
      )
      expect(buildFallbackPort).not.toHaveBeenCalled()
      expect(metricInc).not.toHaveBeenCalled()
      expect(engine.servedBy()).toBeNull()
    }
  )
})
