/**
 * Provider registry invariants.
 *
 * Locks down behaviors that the rest of mcp-host derives from `PROVIDERS`:
 * the dev auto-detection priority order (§5.4/§5.9), the prototype-pollution
 * guard in `isLlmProvider` (§1), and the factory fail-safe (§5.7).
 */
import { describe, expect, it, vi } from 'vitest'
import { brokerInternalUrl, fallbackSlotId } from '@clerum/egress-policy'
import { config } from '../../config'
import type { ModelConfig } from '../../types'
import { apiKeysFromEnv, createLLMProvider } from '../index'
import { makeProvider } from '../registry'
import { ALL_PROVIDERS, descriptorFor, isLlmProvider, primarySlot } from '../registryCore'

/** Read the OpenAI SDK client baseURL the way the bailian invariant test does. */
function effectiveBaseURL(provider: unknown): string {
  return (provider as { client: { baseURL: string } }).client.baseURL
}

describe('provider registry — auto-detection order (§5.9)', () => {
  it('preserves the dev priority prefix openai > claude > zai > bailian > vertex > bedrock', () => {
    // A registry reordering must not silently change dev provider priority. The
    // four originals keep positions 0-3, the own-SDK newcomers (vertex, bedrock,
    // R4) hold 4-5; the R6 OpenAI-compatible additions (openrouter…novita) and
    // the light-driver azure append AFTER, so the historical priority is
    // preserved. Lock the prefix rather than the full list so pure-data
    // additions do not churn this assertion.
    expect(ALL_PROVIDERS.slice(0, 6)).toEqual([
      'openai',
      'claude',
      'zai',
      'bailian',
      'vertex',
      'bedrock',
    ])
  })

  it('registers all 23 static providers plus the Codex broker', () => {
    expect(
      ALL_PROVIDERS.filter(p => descriptorFor(p).authMode === 'static-credentials')
    ).toHaveLength(23)
    expect(ALL_PROVIDERS).toContain('codex-subscription')
    expect(ALL_PROVIDERS).toHaveLength(24)
    for (const p of [
      'openrouter',
      'gemini',
      'deepseek',
      'groq',
      'together',
      'fireworks',
      'mistral',
      'xai',
      'cerebras',
      'deepinfra',
      'perplexity',
      'moonshot',
      'nebius',
      'novita',
      'minimax',
      'azure',
      'openai-compatible',
    ] as const) {
      expect(ALL_PROVIDERS).toContain(p)
    }
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

  // The taskExecutor image-gate keeps a task's image attachments iff
  // `isLlmProvider(providerType)` (taskExecutor.ts). Recognizing vertex/bedrock
  // here is what stops the gate from silently dropping their images (R4).
  it('recognizes the own-SDK newcomers (image-gate: vertex/bedrock keep images)', () => {
    expect(isLlmProvider('vertex')).toBe(true)
    expect(isLlmProvider('bedrock')).toBe(true)
  })
})

describe('createLLMProvider — fail-safe (§5.7)', () => {
  it('returns null for an unknown provider', () => {
    const result = createLLMProvider(
      { openai: { 'openai-api-key': 'sk-test' } },
      {
        provider: 'mystery' as 'openai',
        name: 'whatever',
      }
    )
    expect(result).toBeNull()
  })

  it('logs unknown providers without a format string or raw newlines', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    createLLMProvider(
      { openai: { 'openai-api-key': 'sk-test' } },
      {
        provider: 'mystery\n[injected]' as 'openai',
        name: 'whatever',
      }
    )
    const logged = spy.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    spy.mockRestore()
    expect(logged).toContain('[LLM] Unknown provider')
    expect(logged).not.toContain('mystery')
    expect(logged).not.toContain('%s')
    expect(logged).not.toMatch(/mystery\n/)
  })

  it('returns null when the matching key is missing', () => {
    const result = createLLMProvider(
      { claude: { 'claude-api-key': 'sk-claude' } },
      {
        provider: 'openai',
        name: 'gpt-5.4-mini',
      }
    )
    expect(result).toBeNull()
  })

  it('returns null when the matching key is empty', () => {
    const result = createLLMProvider(
      { openai: { 'openai-api-key': '' } },
      {
        provider: 'openai',
        name: 'gpt-5.4-mini',
      }
    )
    expect(result).toBeNull()
  })

  it('constructs a provider when the matching key is present', () => {
    const result = createLLMProvider(
      { openai: { 'openai-api-key': 'sk-test' } },
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
    const result = createLLMProvider(
      { zai: { 'zai-api-key': 'sk-zai' } },
      { provider: 'zai', name: 'glm-5.1' }
    )
    expect(result).not.toBeNull()
    expect(result?.getProviderType()).toBe('zai')
  })

  // Symmetric to the zai case. Also asserts the constructed provider's default
  // model + baseURL come from the registry descriptor, catching drift in
  // registryCore.bailian.defaultModel/baseURL. Reads the inherited private
  // fields the same way the bailian provider test exercises construction.
  it('constructs an OpenAI-compatible provider (bailian) through the registry', () => {
    const result = createLLMProvider(
      { bailian: { 'bailian-api-key': 'sk-x' } },
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

describe('openai-compatible — dials the per-Host egress broker (never the LAN endpoint)', () => {
  // The LAN baseURL is used ONLY for its pathname; the effective endpoint is the
  // broker Service. Expected URL derived with the SHARED helper (real producer,
  // same hash HCC uses), not hand-written.
  const LAN_BASEURL = 'http://10.0.0.5:8000/v1'

  it('primary: effective baseURL is the broker URL derived with the shared hash', () => {
    const provider = createLLMProvider(
      { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
      { provider: 'openai-compatible', name: 'llama-3.3-70b', baseURL: LAN_BASEURL }
    )
    expect(provider).not.toBeNull()
    expect(provider?.getProviderType()).toBe('openai-compatible')

    const expected = brokerInternalUrl(config.hostName, 'primary', {
      namespace: config.llmEgressNamespace,
      port: config.brokerPort,
      pathname: '/v1',
    })
    expect(effectiveBaseURL(provider)).toBe(expected)
    // Never the raw LAN endpoint.
    expect(effectiveBaseURL(provider)).not.toContain('10.0.0.5')
    expect(expected).toContain('.svc.cluster.local:')
  })

  it('canonicalizes a provider carrying surrounding whitespace and still routes to the broker', () => {
    // Defense-in-depth: a padded 'openai-compatible ' used to fail isLlmProvider
    // and return null, while HCC (which trims) had already provisioned a broker
    // for the trimmed form — the two sides disagreed. .trim() aligns them.
    const provider = createLLMProvider(
      { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
      { provider: 'openai-compatible ' as ModelConfig['provider'], name: 'm', baseURL: LAN_BASEURL }
    )
    expect(provider).not.toBeNull()
    expect(provider?.getProviderType()).toBe('openai-compatible')
  })

  it('a fallback uses its OWN broker (distinct slotId → distinct hash)', () => {
    const primary = createLLMProvider(
      { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
      { provider: 'openai-compatible', name: 'm', baseURL: LAN_BASEURL }
    )
    // Same LAN endpoint but slotId 'fallback-1' → different derived broker.
    const fb = createLLMProvider(
      { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
      { provider: 'openai-compatible', name: 'm', baseURL: LAN_BASEURL },
      { openaiCompatibleSlotId: fallbackSlotId(1) }
    )
    const expectedFb = brokerInternalUrl(config.hostName, fallbackSlotId(1), {
      namespace: config.llmEgressNamespace,
      port: config.brokerPort,
      pathname: '/v1',
    })
    expect(effectiveBaseURL(fb)).toBe(expectedFb)
    // The primary broker and the fallback broker are NOT the same Service.
    expect(effectiveBaseURL(fb)).not.toBe(effectiveBaseURL(primary))
  })

  it('fail-closed: an unparseable LAN baseURL builds NO provider (no public default)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider = createLLMProvider(
      { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
      { provider: 'openai-compatible', name: 'm', baseURL: 'not a url' }
    )
    spy.mockRestore()
    expect(provider).toBeNull()
  })

  it('fail-closed: a missing LAN baseURL builds NO provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider = createLLMProvider(
      { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
      { provider: 'openai-compatible', name: 'm' }
    )
    spy.mockRestore()
    expect(provider).toBeNull()
  })

  it('fail-closed: a missing Host name builds NO provider (cannot derive broker)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const saved = config.hostName
    try {
      ;(config as { hostName: string }).hostName = ''
      const provider = createLLMProvider(
        { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
        { provider: 'openai-compatible', name: 'm', baseURL: LAN_BASEURL }
      )
      expect(provider).toBeNull()
    } finally {
      ;(config as { hostName: string }).hostName = saved
      spy.mockRestore()
    }
  })
})

describe('openai-compatible — excluded from env-key autodetection', () => {
  it('apiKeysFromEnv never selects openai-compatible even with its env key set', () => {
    const keys = apiKeysFromEnv({
      OPENAI_COMPATIBLE_API_KEY: 'should-not-count',
      OPENAI_API_KEY: 'sk-test',
    })
    expect(keys.openai).toBeDefined()
    expect(keys['openai-compatible']).toBeUndefined()
    // The startDevMode selection (`ALL_PROVIDERS.find(p => keys[p])`) picks openai.
    expect(ALL_PROVIDERS.find(p => keys[p])).toBe('openai')
  })

  it('apiKeysFromEnv leaves the bag empty when ONLY the openai-compatible key is set', () => {
    const keys = apiKeysFromEnv({ OPENAI_COMPATIBLE_API_KEY: 'x' })
    expect(keys['openai-compatible']).toBeUndefined()
    // Nothing auto-selectable → startDevMode would throw its "requires a key" error.
    expect(ALL_PROVIDERS.find(p => keys[p])).toBeUndefined()
  })
})

describe('codex-subscription zero-slot broker', () => {
  it('exposes oauth-broker/dynamic metadata with no slots or defaultModel', () => {
    expect(descriptorFor('codex-subscription')).toMatchObject({
      authMode: 'oauth-broker',
      modelCatalogMode: 'dynamic',
      credentialSlots: [],
      nonSecretEnv: [],
    })
    expect(descriptorFor('codex-subscription').credentialSlots).toEqual([])
    expect(descriptorFor('codex-subscription').defaultModel).toBeUndefined()
  })

  it('rejects the static credential helper for a broker', () => {
    expect(() => primarySlot(descriptorFor('codex-subscription'))).toThrow(
      /static credential helper/
    )
  })

  it('does not autodetect Codex from env API keys', () => {
    const keys = apiKeysFromEnv({
      OPENAI_API_KEY: 'sk-test',
      CODEX_SUBSCRIPTION_API_KEY: 'should-not-count',
    })
    expect(keys.openai).toBeDefined()
    expect(keys['codex-subscription']).toBeUndefined()
  })

  it('fails closed when constructing Codex without runtime dependencies', () => {
    process.env.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED = 'true'
    expect(() => makeProvider('codex-subscription', {})).toThrow(
      /requires an explicit model and runtime authorizer/
    )
    const provider = createLLMProvider({}, { provider: 'codex-subscription', name: 'gpt-5.1' })
    expect(provider?.getProviderType()).toBe('codex-subscription')
    delete process.env.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED
  })
})
