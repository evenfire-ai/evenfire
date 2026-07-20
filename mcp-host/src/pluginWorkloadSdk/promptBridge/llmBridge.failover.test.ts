import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { FinishReason } from '../../core/types'
import type { SingleTurnProvider, createLLMProvider } from '../../llm'
import type { ApiKeys, ModelConfig } from '../../types'
import { PluginWorkloadError } from '../domain/errors'
import { LlmBridge, type LlmBridgeContext } from './llmBridge'

/**
 * Provider-fallback (R5 F6) — promptBridge `LlmBridge`.
 *
 * The bridge switches only among the caller-supplied `fallbackModels` (which
 * the handler derives from the grant's `allowedModels`) and NEVER switches
 * provider — so a fallback model is, by construction, always inside the grant.
 */

const OK = {
  content: 'ok',
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  finish_reason: FinishReason.Stop,
}

class FakeProvider implements Partial<SingleTurnProvider> {
  constructor(
    private readonly behavior: () => Promise<typeof OK>,
    private readonly classify: { code: LlmErrorCode; retryable: boolean } = {
      code: LlmErrorCode.RateLimited,
      retryable: true,
    }
  ) {}

  completeSingleTurn = vi.fn(async () => this.behavior())

  classifyError(_err: unknown) {
    return { code: this.classify.code, retryable: this.classify.retryable, message: 'x' }
  }
}

function makeContext(): LlmBridgeContext {
  const keys: ApiKeys = { openai: { 'openai-api-key': 'sk-test' } } as unknown as ApiKeys
  return { keys, provider: 'openai' as ModelConfig['provider'], defaultModel: 'gpt-primary' }
}

/** Build a bridge whose per-model provider behavior is driven by `byModel`. */
function makeBridge(byModel: Record<string, FakeProvider>) {
  const calls: string[] = []
  const createProvider = ((_keys: ApiKeys, modelConfig: ModelConfig) => {
    calls.push(modelConfig.name)
    return (byModel[modelConfig.name] ?? null) as unknown as SingleTurnProvider | null
  }) as typeof createLLMProvider
  const bridge = new LlmBridge(() => makeContext(), { createProvider })
  return { bridge, calls }
}

const baseReq = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  timeoutMs: 5_000,
}

describe('LlmBridge provider-fallback (R5 F6)', () => {
  it('switches to a fallback model within the grant on an eligible failure', async () => {
    const primary = new FakeProvider(() => Promise.reject(new Error('429')), {
      code: LlmErrorCode.RateLimited,
      retryable: true,
    })
    const fallback = new FakeProvider(() => Promise.resolve(OK))
    const { bridge, calls } = makeBridge({ 'gpt-primary': primary, 'gpt-fallback': fallback })

    const result = await bridge.complete({
      ...baseReq,
      model: 'gpt-primary',
      fallbackModels: ['gpt-fallback'],
    })

    // The winning (served) pair is the fallback, and only it is returned.
    expect(result.model).toBe('gpt-fallback')
    expect(result.content).toBe('ok')
    expect(calls).toEqual(['gpt-primary', 'gpt-fallback'])
    expect(primary.completeSingleTurn).toHaveBeenCalledTimes(1)
    expect(fallback.completeSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('does NOT switch when no fallbackModels are provided — original error propagates', async () => {
    const primary = new FakeProvider(() => Promise.reject(new Error('429')), {
      code: LlmErrorCode.RateLimited,
      retryable: true,
    })
    const { bridge, calls } = makeBridge({ 'gpt-primary': primary })

    await expect(bridge.complete({ ...baseReq, model: 'gpt-primary' })).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(calls).toEqual(['gpt-primary'])
  })

  it('does NOT switch on a non-eligible (400/validation) failure — propagates immediately', async () => {
    const primary = new FakeProvider(() => Promise.reject(new Error('bad request')), {
      code: LlmErrorCode.ApiCallFailed,
      retryable: false, // 400 → not eligible
    })
    const fallback = new FakeProvider(() => Promise.resolve(OK))
    const { bridge, calls } = makeBridge({ 'gpt-primary': primary, 'gpt-fallback': fallback })

    await expect(
      bridge.complete({ ...baseReq, model: 'gpt-primary', fallbackModels: ['gpt-fallback'] })
    ).rejects.toBeInstanceOf(PluginWorkloadError)
    // The fallback is never attempted.
    expect(calls).toEqual(['gpt-primary'])
    expect(fallback.completeSingleTurn).not.toHaveBeenCalled()
  })

  it('returns exactly one result (only the winner) so the handler meters once', async () => {
    const primary = new FakeProvider(() => Promise.reject(new Error('429')))
    const fallback = new FakeProvider(() =>
      Promise.resolve({ ...OK, usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 } })
    )
    const { bridge } = makeBridge({ 'gpt-primary': primary, 'gpt-fallback': fallback })

    const result = await bridge.complete({
      ...baseReq,
      model: 'gpt-primary',
      fallbackModels: ['gpt-primary', 'gpt-fallback'], // primary deduped out
    })

    expect(result.model).toBe('gpt-fallback')
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 })
  })

  it('propagates the last error when every fallback also fails', async () => {
    const primary = new FakeProvider(() => Promise.reject(new Error('429')))
    const fallback = new FakeProvider(() => Promise.reject(new Error('429 again')))
    const { bridge, calls } = makeBridge({ 'gpt-primary': primary, 'gpt-fallback': fallback })

    await expect(
      bridge.complete({ ...baseReq, model: 'gpt-primary', fallbackModels: ['gpt-fallback'] })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(calls).toEqual(['gpt-primary', 'gpt-fallback'])
  })
})
