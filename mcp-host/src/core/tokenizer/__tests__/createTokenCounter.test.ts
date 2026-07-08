/**
 * Tests for the `createTokenCounter` dispatch in `core/tokenizer/index.ts`.
 *
 * The dispatch is now registry-driven (P3 of the provider-registry refactor):
 *   - capability-first: a provider that ships `createTokenCounter()` (Claude)
 *     wins regardless of its descriptor hint.
 *   - otherwise it dispatches by `descriptorFor(type).tokenizer`:
 *       'openai'   → OpenAITokenCounter
 *       'fallback' → FallbackTokenCounter
 *   - 'native' / unknown types never throw — they fall back safely.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LlmProvider } from '../../../llm/registryCore'
import type { SingleTurnProvider } from '../../../llm/types'
import { FallbackTokenCounter } from '../fallbackTokenCounter'
import { createTokenCounter } from '../index'
import { OpenAITokenCounter } from '../openaiTokenCounter'

function stubProvider(type: string, extra: Partial<SingleTurnProvider> = {}): SingleTurnProvider {
  return {
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(),
    getProviderType: () => type as LlmProvider,
    ...extra,
  } as unknown as SingleTurnProvider
}

describe('createTokenCounter dispatch', () => {
  it("uses the provider's own factory when it ships createTokenCounter (Claude)", () => {
    const sentinel = { providerName: 'claude' } as unknown as ReturnType<typeof createTokenCounter>
    const createFn = vi.fn(() => sentinel)
    const provider = stubProvider('claude', {
      createTokenCounter: createFn,
    } as Partial<SingleTurnProvider>)

    const counter = createTokenCounter(provider, 'claude-sonnet-4-6', { offline: true })

    expect(createFn).toHaveBeenCalledWith('claude-sonnet-4-6', { offline: true })
    expect(counter).toBe(sentinel)
  })

  it("dispatches tokenizer:'openai' to OpenAITokenCounter", () => {
    const counter = createTokenCounter(stubProvider('openai'), 'gpt-5.4-mini')
    expect(counter).toBeInstanceOf(OpenAITokenCounter)
    expect(counter.providerName).toBe('openai')
  })

  it("dispatches tokenizer:'fallback' providers to FallbackTokenCounter (zai)", () => {
    const counter = createTokenCounter(stubProvider('zai'), 'glm-5.1')
    expect(counter).toBeInstanceOf(FallbackTokenCounter)
    expect(counter.providerName).toBe('zai')
  })

  it("dispatches tokenizer:'fallback' providers to FallbackTokenCounter (bailian)", () => {
    const counter = createTokenCounter(stubProvider('bailian'), 'qwen3-coder-plus')
    expect(counter).toBeInstanceOf(FallbackTokenCounter)
    expect(counter.providerName).toBe('bailian')
  })

  it("falls back safely (no throw) for a 'native' provider missing its factory", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // claude has tokenizer:'native' but here the stub does NOT ship
    // createTokenCounter — must not throw, must fall back.
    const counter = createTokenCounter(stubProvider('claude'), 'claude-sonnet-4-6')
    expect(counter).toBeInstanceOf(FallbackTokenCounter)
    expect(counter.providerName).toBe('claude')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('falls back safely (no throw) for an unknown provider type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const counter = createTokenCounter(stubProvider('made-up-provider'), 'whatever')
    expect(counter).toBeInstanceOf(FallbackTokenCounter)
    // Security: the label must be the bounded literal 'unknown', NOT the raw
    // provider string — otherwise a regression to FallbackTokenCounter(type, …)
    // reintroduces unbounded Prometheus label cardinality.
    expect(counter.providerName).toBe('unknown')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
