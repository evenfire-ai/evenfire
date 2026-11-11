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
import { afterEach, describe, expect, it, vi } from 'vitest'
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

// The switch is on by default: unset, empty and `true` pass the gate, `false`
// closes it and any other value refuses to build the provider. "Passes the
// gate" is observed through the next check, the missing model/authorizer
// error, which only code past the gate can raise.
for (const [provider, flag] of [
  ['grok-subscription', 'MCP_HOST_GROK_SUBSCRIPTION_ENABLED'],
  ['codex-subscription', 'MCP_HOST_CODEX_SUBSCRIPTION_ENABLED'],
] as const) {
  describe(`makeProvider — ${provider} switch`, () => {
    afterEach(() => {
      delete process.env[flag]
    })

    it('passes the gate when the switch is unset, empty or true', () => {
      for (const value of [undefined, '', 'true']) {
        if (value === undefined) delete process.env[flag]
        else process.env[flag] = value
        expect(() => makeProvider(provider, {}), String(value)).toThrow(
          /requires an explicit model and runtime authorizer/
        )
      }
    })

    it('fails closed when the switch is false', () => {
      process.env[flag] = 'false'
      expect(() => makeProvider(provider, {})).toThrow(/is disabled/)
    })

    it('refuses a switch value that is neither true nor false', () => {
      for (const value of ['TRUE', '0', 'off']) {
        process.env[flag] = value
        expect(() => makeProvider(provider, {}), value).toThrow(
          new RegExp(`${flag} must be 'true' or 'false'`)
        )
      }
    })
  })
}
