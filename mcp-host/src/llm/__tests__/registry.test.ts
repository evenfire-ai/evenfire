/**
 * Provider registry invariants.
 *
 * Locks down behaviors that the rest of mcp-host derives from `PROVIDERS`:
 * the dev auto-detection priority order (§5.4/§5.9), the prototype-pollution
 * guard in `isLlmProvider` (§1), and the factory fail-safe (§5.7).
 */
import { describe, expect, it } from 'vitest'
import { createLLMProvider } from '../index'
import { ALL_PROVIDERS, descriptorFor, isLlmProvider } from '../registryCore'

describe('provider registry — auto-detection order (§5.9)', () => {
  it('preserves the dev priority order openai > claude > zai > bailian', () => {
    // A registry reordering must not silently change dev provider priority.
    expect(ALL_PROVIDERS).toEqual(['openai', 'claude', 'zai', 'bailian'])
  })

  it('openai is first (the dev default when multiple keys are present)', () => {
    expect(ALL_PROVIDERS[0]).toBe('openai')
  })

  it('first-present-key-wins selects by ALL_PROVIDERS order, not insertion order', () => {
    // Mirrors the runtime selection in main.ts (`ALL_PROVIDERS.find(p => keys[p])`).
    const select = (keys: Partial<Record<string, string>>) => ALL_PROVIDERS.find(p => keys[p])
    // Earlier provider wins even when a later key is listed first.
    expect(select({ zai: 'z', openai: 'o' })).toBe('openai')
    expect(select({ bailian: 'b', claude: 'c' })).toBe('claude')
    // Only a later key present → that one is chosen.
    expect(select({ zai: 'z' })).toBe('zai')
    expect(select({ bailian: 'b' })).toBe('bailian')
  })
})

describe('descriptor id === key invariant', () => {
  it('every descriptor reports its own key as id', () => {
    // CoreProviderDescriptor.id is typed `string` and OpenAICompatibleProvider
    // returns `cfg.id as LlmProvider`, so a typo (key `bailian`, id `'balian'`)
    // would compile and report the wrong provider. Lock id === key here.
    for (const p of ALL_PROVIDERS) {
      expect(descriptorFor(p).id).toBe(p)
    }
  })
})

describe('isLlmProvider — prototype-pollution guard (§1)', () => {
  it('accepts every registered provider id', () => {
    for (const p of ALL_PROVIDERS) {
      expect(isLlmProvider(p)).toBe(true)
    }
  })

  it('rejects inherited Object.prototype keys', () => {
    // Uses hasOwnProperty, not `in`, so prototype-chain keys do not pass.
    expect(isLlmProvider('constructor')).toBe(false)
    expect(isLlmProvider('__proto__')).toBe(false)
    expect(isLlmProvider('hasOwnProperty')).toBe(false)
  })

  it('rejects unknown strings', () => {
    expect(isLlmProvider('gpt')).toBe(false)
    expect(isLlmProvider('')).toBe(false)
  })
})

describe('createLLMProvider — fail-safe (§5.7)', () => {
  it('returns null for an unknown provider', () => {
    const result = createLLMProvider(
      { openai: 'sk-test' },
      {
        provider: 'mystery' as 'openai',
        name: 'whatever',
      }
    )
    expect(result).toBeNull()
  })

  it('returns null when the matching key is missing', () => {
    const result = createLLMProvider(
      { claude: 'sk-claude' },
      {
        provider: 'openai',
        name: 'gpt-5.4-mini',
      }
    )
    expect(result).toBeNull()
  })

  it('returns null when the matching key is empty', () => {
    const result = createLLMProvider(
      { openai: '' },
      {
        provider: 'openai',
        name: 'gpt-5.4-mini',
      }
    )
    expect(result).toBeNull()
  })

  it('constructs a provider when the matching key is present', () => {
    const result = createLLMProvider(
      { openai: 'sk-test' },
      {
        provider: 'openai',
        name: 'gpt-5.4-mini',
      }
    )
    expect(result).not.toBeNull()
    expect(result?.getProviderType()).toBe('openai')
  })

  // Covers the OpenAI-compatible factory arm end-to-end: the registry's
  // descriptor.baseURL lookup + OpenAICompatibleProvider construction. The
  // provider-specific tests build OpenAICompatibleProvider directly, so this is
  // the only path exercising makeProvider's OpenAI-compatible (baseURL) branch.
  it('constructs an OpenAI-compatible provider (zai) through the registry', () => {
    const result = createLLMProvider({ zai: 'sk-zai' }, { provider: 'zai', name: 'glm-5.1' })
    expect(result).not.toBeNull()
    expect(result?.getProviderType()).toBe('zai')
  })

  // Symmetric to the zai case. Also asserts the constructed provider's default
  // model + baseURL come from the registry descriptor, catching drift in
  // registryCore.bailian.defaultModel/baseURL. Reads the inherited private
  // fields the same way the bailian provider test exercises construction.
  it('constructs an OpenAI-compatible provider (bailian) through the registry', () => {
    const result = createLLMProvider(
      { bailian: 'sk-x' },
      { provider: 'bailian', name: 'qwen3-coder-plus' }
    )
    expect(result).not.toBeNull()
    expect(result?.getProviderType()).toBe('bailian')

    const desc = descriptorFor('bailian')
    // Private field on OpenAIProvider (inherited); read for invariant assertion.
    const internals = result as unknown as {
      defaultModel: string
      client: { baseURL: string }
    }
    expect(internals.defaultModel).toBe(desc.defaultModel)
    expect(internals.client.baseURL).toBe(desc.baseURL)
  })
})
