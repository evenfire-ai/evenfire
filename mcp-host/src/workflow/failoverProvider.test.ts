import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../core/errors'
import { FinishReason } from '../core/types'
import type { CompletionResponse, ToolCompletionResponse } from '../core/types'
import type { SingleTurnProvider } from '../llm'
import {
  FailoverSingleTurnProvider,
  isFailoverProvider,
  parseWorkflowLlmPolicy,
} from './failoverProvider'

/**
 * Provider-fallback (R5 F6) — workflow-step glue.
 */

const TEXT: CompletionResponse = {
  content: 'done',
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  finish_reason: FinishReason.Stop,
}
const TOOLS: ToolCompletionResponse = {
  content: 'done',
  tool_calls: [],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  finish_reason: FinishReason.Stop,
}

function fakeProvider(opts: {
  onWithTools?: () => Promise<ToolCompletionResponse>
  classify?: { code: LlmErrorCode; retryable: boolean }
}): SingleTurnProvider {
  const classify = opts.classify ?? { code: LlmErrorCode.RateLimited, retryable: true }
  return {
    completeSingleTurn: vi.fn(async () => TEXT),
    completeSingleTurnWithTools: vi.fn(opts.onWithTools ?? (async () => TOOLS)),
    getProviderType: () => 'openai',
    classifyError: () => ({ code: classify.code, retryable: classify.retryable, message: 'x' }),
  } as unknown as SingleTurnProvider
}

describe('parseWorkflowLlmPolicy', () => {
  it('returns null for absent / malformed / empty policies (no failover)', () => {
    expect(parseWorkflowLlmPolicy(undefined)).toBeNull()
    expect(parseWorkflowLlmPolicy({})).toBeNull()
    expect(parseWorkflowLlmPolicy({ fallbacks: [] })).toBeNull()
    // fallback missing apiKey → dropped → zero valid → null
    expect(parseWorkflowLlmPolicy({ fallbacks: [{ provider: 'openai', model: 'm' }] })).toBeNull()
  })

  it('parses a valid policy with defaults for cooldown/triggerOn', () => {
    const policy = parseWorkflowLlmPolicy({
      fallbacks: [{ provider: 'claude', model: 'claude-haiku-4-5', apiKey: 'sk-fb' }],
    })
    expect(policy).not.toBeNull()
    expect(policy!.cooldownSeconds).toBe(300)
    expect(policy!.triggerOn).toEqual([
      'insufficient_quota',
      'auth',
      'provider_unavailable',
      'rate_limited',
    ])
    expect(policy!.fallbacks).toEqual([
      { provider: 'claude', model: 'claude-haiku-4-5', apiKey: 'sk-fb' },
    ])
  })

  it('honours explicit cooldown + triggerOn and drops unknown classes', () => {
    const policy = parseWorkflowLlmPolicy({
      cooldownSeconds: 30,
      triggerOn: ['rate_limited', 'bogus'],
      fallbacks: [{ provider: 'openai', model: 'gpt-x', apiKey: 'sk' }],
    })
    expect(policy!.cooldownSeconds).toBe(30)
    expect(policy!.triggerOn).toEqual(['rate_limited'])
  })

  it('preserves cooldownSeconds: 0 (immediate expiry), not coerced to 300', () => {
    const policy = parseWorkflowLlmPolicy({
      cooldownSeconds: 0,
      fallbacks: [{ provider: 'openai', model: 'gpt-x', apiKey: 'sk' }],
    })
    expect(policy!.cooldownSeconds).toBe(0)
  })

  it('ignores a negative / non-integer cooldown, keeping the default', () => {
    expect(
      parseWorkflowLlmPolicy({
        cooldownSeconds: -5,
        fallbacks: [{ provider: 'openai', model: 'gpt-x', apiKey: 'sk' }],
      })!.cooldownSeconds
    ).toBe(300)
    expect(
      parseWorkflowLlmPolicy({
        cooldownSeconds: 1.5,
        fallbacks: [{ provider: 'openai', model: 'gpt-x', apiKey: 'sk' }],
      })!.cooldownSeconds
    ).toBe(300)
  })
})

describe('FailoverSingleTurnProvider', () => {
  it('switches to the fallback on an eligible failure and reports the served pair', async () => {
    const primary = fakeProvider({
      onWithTools: () => Promise.reject(new Error('429')),
      classify: { code: LlmErrorCode.RateLimited, retryable: true },
    })
    const fallback = fakeProvider({ onWithTools: () => Promise.resolve(TOOLS) })
    const buildFallback = vi.fn(() => fallback)

    const provider = new FailoverSingleTurnProvider({
      primary,
      primaryPair: { provider: 'openai', model: 'gpt-primary' },
      policy: {
        cooldownSeconds: 300,
        triggerOn: ['rate_limited'],
        fallbacks: [{ provider: 'claude', model: 'claude-fb', apiKey: 'sk-fb' }],
      },
      buildFallback,
    })

    const res = await provider.completeSingleTurnWithTools([], [])
    expect(res.content).toBe('done')
    expect(buildFallback).toHaveBeenCalledTimes(1)
    expect(provider.servedBy()).toEqual({ provider: 'claude', model: 'claude-fb' })
    expect(isFailoverProvider(provider)).toBe(true)
  })

  it('does NOT switch on a non-eligible failure and rethrows the ORIGINAL error', async () => {
    const original = new Error('400 bad request')
    const primary = fakeProvider({
      onWithTools: () => Promise.reject(original),
      classify: { code: LlmErrorCode.ApiCallFailed, retryable: false }, // 400 → not eligible
    })
    const buildFallback = vi.fn(() => fakeProvider({}))

    const provider = new FailoverSingleTurnProvider({
      primary,
      primaryPair: { provider: 'openai', model: 'gpt-primary' },
      policy: {
        cooldownSeconds: 300,
        triggerOn: ['rate_limited', 'provider_unavailable'],
        fallbacks: [{ provider: 'claude', model: 'claude-fb', apiKey: 'sk-fb' }],
      },
      buildFallback,
    })

    await expect(provider.completeSingleTurnWithTools([], [])).rejects.toBe(original)
    expect(buildFallback).not.toHaveBeenCalled()
    // Still serving the primary (never switched).
    expect(provider.servedBy()).toEqual({ provider: 'openai', model: 'gpt-primary' })
  })

  it('serves the primary when it succeeds', async () => {
    const primary = fakeProvider({ onWithTools: () => Promise.resolve(TOOLS) })
    const provider = new FailoverSingleTurnProvider({
      primary,
      primaryPair: { provider: 'openai', model: 'gpt-primary' },
      policy: {
        cooldownSeconds: 300,
        triggerOn: ['rate_limited'],
        fallbacks: [{ provider: 'claude', model: 'claude-fb', apiKey: 'sk-fb' }],
      },
      buildFallback: () => fakeProvider({}),
    })

    await provider.completeSingleTurnWithTools([], [])
    expect(provider.servedBy()).toEqual({ provider: 'openai', model: 'gpt-primary' })
  })

  it('skips an unconstructible fallback (builder returns null) and propagates the last error', async () => {
    const err = new Error('429')
    const primary = fakeProvider({
      onWithTools: () => Promise.reject(err),
      classify: { code: LlmErrorCode.RateLimited, retryable: true },
    })
    const provider = new FailoverSingleTurnProvider({
      primary,
      primaryPair: { provider: 'openai', model: 'gpt-primary' },
      policy: {
        cooldownSeconds: 300,
        triggerOn: ['rate_limited'],
        fallbacks: [{ provider: 'claude', model: 'claude-fb', apiKey: 'sk-fb' }],
      },
      buildFallback: () => null, // credential absent → skip
    })

    await expect(provider.completeSingleTurnWithTools([], [])).rejects.toBe(err)
  })

  it('does NOT fail over on a cooperative abort (step deadline) — propagates + no switch', async () => {
    const abort = new Error('step-timeout')
    const controller = new AbortController()
    controller.abort('step-timeout')
    const primary = fakeProvider({
      onWithTools: () => Promise.reject(abort),
      // Would be eligible if classified — but the aborted signal short-circuits.
      classify: { code: LlmErrorCode.ApiCallFailed, retryable: true },
    })
    const buildFallback = vi.fn(() => fakeProvider({}))

    const provider = new FailoverSingleTurnProvider({
      primary,
      primaryPair: { provider: 'openai', model: 'gpt-primary' },
      policy: {
        cooldownSeconds: 300,
        triggerOn: ['provider_unavailable'],
        fallbacks: [{ provider: 'claude', model: 'claude-fb', apiKey: 'sk-fb' }],
      },
      buildFallback,
    })

    await expect(
      provider.completeSingleTurnWithTools([], [], { signal: controller.signal })
    ).rejects.toBe(abort)
    expect(buildFallback).not.toHaveBeenCalled()
    expect(provider.servedBy()).toEqual({ provider: 'openai', model: 'gpt-primary' })
  })
})
