import { describe, expect, it, vi } from 'vitest'
import { attachmentContextWindow } from '../attachmentContextWindow'

describe('attachment budget across provider failover', () => {
  it('uses the exact fallback model catalog window, including a smaller non-default model', () => {
    const catalog = vi.fn((provider: string, model: string) => {
      if (provider === 'claude' && model === 'public-small-model') return 32_000
      if (provider === 'deepseek' && model === 'public-large-model') return 256_000
      return undefined
    })
    expect(
      attachmentContextWindow(
        128_000,
        'openai',
        [
          { provider: 'deepseek', model: 'public-large-model' },
          { provider: 'claude', model: 'public-small-model' },
        ],
        catalog,
        100_000
      )
    ).toBe(32_000)
    expect(catalog).toHaveBeenCalledWith('claude', 'public-small-model')
  })

  it('keeps the session model window for same-provider credential failover', () => {
    const catalog = vi.fn(() => 1)
    expect(
      attachmentContextWindow(
        128_000,
        'openai',
        [{ provider: 'openai', model: 'inert-other-model', credentialSlot: 'other-slot' }],
        catalog,
        100_000
      )
    ).toBe(128_000)
    expect(catalog).not.toHaveBeenCalled()
  })

  it('never widens the primary window and resolves missing metadata by the existing policy', () => {
    expect(
      attachmentContextWindow(
        8_000,
        'openai',
        [{ provider: 'claude', model: 'public-model' }],
        undefined,
        100_000
      )
    ).toBe(8_000)
    expect(
      attachmentContextWindow(
        128_000,
        'openai',
        [{ provider: 'claude', model: 'public-model' }],
        undefined,
        100_000
      )
    ).toBe(100_000)
  })

  it('rejects unusable catalog windows rather than enlarging or ignoring the bound', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        attachmentContextWindow(
          128_000,
          'openai',
          [{ provider: 'claude', model: 'public-model' }],
          () => value,
          100_000
        )
      ).toThrow('positive safe integer')
    }
  })
})
