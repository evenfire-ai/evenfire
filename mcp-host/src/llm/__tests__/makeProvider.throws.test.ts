/**
 * Throw-path coverage for `makeProvider`'s data-driven dispatch.
 *
 * The factory returns early for direct-SDK providers (openai, claude) and
 * otherwise builds any provider carrying a `baseURL` as OpenAI-compatible. The
 * final `throw` is the defensive arm for a future *divergent* provider that is
 * neither native nor OpenAI-compatible (no `baseURL`) and was added to
 * `PROVIDERS` without its own factory case. No real provider hits it today, so
 * we mock `descriptorFor` to return a baseURL-less descriptor and confirm the
 * throw fires (rather than silently constructing a broken client).
 */
import { describe, expect, it, vi } from 'vitest'
import { makeProvider } from '../registry'
import type { LlmProvider } from '../registryCore'

vi.mock('../registryCore', async importOriginal => {
  const actual = await importOriginal<typeof import('../registryCore')>()
  return {
    ...actual,
    descriptorFor: (p: string) =>
      p === 'phantom'
        ? {
            id: 'phantom',
            credentialSlots: [{ dataKey: 'x', envName: 'X', required: true }],
            defaultModel: 'm',
            tokenizer: 'fallback',
          }
        : actual.descriptorFor(p as never),
  }
})

describe('makeProvider — divergent provider without a factory', () => {
  it('throws "no factory registered" for a non-native provider with no baseURL', () => {
    expect(() => makeProvider('phantom' as LlmProvider, { x: 'sk-x' })).toThrow(
      /no factory registered/
    )
  })
})

describe('makeProvider — Codex broker', () => {
  it('fails closed when the execution flag is off', () => {
    delete process.env.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED
    expect(() => makeProvider('codex-subscription', {})).toThrow(/is disabled/)
  })

  it('fails closed without runtime authorizer/proxy dependencies when the flag is on', () => {
    process.env.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED = 'true'
    expect(() => makeProvider('codex-subscription', {})).toThrow(
      /requires an explicit model and runtime authorizer/
    )
    delete process.env.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED
  })
})
