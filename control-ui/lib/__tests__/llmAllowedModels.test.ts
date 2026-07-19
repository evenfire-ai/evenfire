import { describe, expect, it } from 'vitest'
import {
  type HostAllowedModel,
  type LlmModelCatalogEntry,
  allowedModelsForProvider,
  buildAllowedModelsSpec,
  constrainModelOptions,
  isProviderAllowUnrestricted,
  normalizeAllowedModels,
} from '../llm'

const CATALOG: LlmModelCatalogEntry[] = [
  { provider: 'openai', model: 'gpt-5.4-mini', enabled: true },
  { provider: 'openai', model: 'gpt-5.4', enabled: true },
  { provider: 'openai', model: 'gpt-legacy', enabled: false },
  { provider: 'claude', model: 'claude-sonnet-4-6', enabled: true },
  { provider: 'claude', model: 'claude-opus-4-6', enabled: true },
]

describe('allowedModelsForProvider (spec Topic 3a)', () => {
  it('returns the per-provider subset, de-duplicated and in order', () => {
    const allowed: HostAllowedModel[] = [
      { provider: 'openai', model: 'gpt-5.4' },
      { provider: 'claude', model: 'claude-opus-4-6' },
      { provider: 'openai', model: 'gpt-5.4' },
    ]
    expect(allowedModelsForProvider(allowed, 'openai')).toEqual(['gpt-5.4'])
    expect(allowedModelsForProvider(allowed, 'claude')).toEqual(['claude-opus-4-6'])
    expect(allowedModelsForProvider(allowed, 'zai')).toEqual([])
  })
})

describe('isProviderAllowUnrestricted (empty or all-enabled = unrestricted)', () => {
  it('empty selection is unrestricted', () => {
    expect(isProviderAllowUnrestricted([], ['a', 'b'])).toBe(true)
  })
  it('selecting every enabled model is treated as unrestricted', () => {
    expect(isProviderAllowUnrestricted(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(isProviderAllowUnrestricted(['b', 'a'], ['a', 'b'])).toBe(true)
  })
  it('a strict subset is restricted', () => {
    expect(isProviderAllowUnrestricted(['a'], ['a', 'b'])).toBe(false)
  })
  it('a subset with an unknown global (catalog unavailable) stays restricted', () => {
    expect(isProviderAllowUnrestricted(['a'], [])).toBe(false)
  })
})

describe('constrainModelOptions (dropdown options)', () => {
  it('falls back to the full enabled allowlist when unrestricted', () => {
    expect(constrainModelOptions(CATALOG, [], 'openai')).toEqual(['gpt-5.4-mini', 'gpt-5.4'])
  })
  it('narrows to the subset when the provider is restricted', () => {
    const allowed: HostAllowedModel[] = [{ provider: 'openai', model: 'gpt-5.4' }]
    expect(constrainModelOptions(CATALOG, allowed, 'openai')).toEqual(['gpt-5.4'])
  })
  it('all-enabled selected collapses back to the full enabled allowlist', () => {
    const allowed: HostAllowedModel[] = [
      { provider: 'openai', model: 'gpt-5.4-mini' },
      { provider: 'openai', model: 'gpt-5.4' },
    ]
    expect(constrainModelOptions(CATALOG, allowed, 'openai')).toEqual(['gpt-5.4-mini', 'gpt-5.4'])
  })
})

describe('buildAllowedModelsSpec (emit only genuine subsets)', () => {
  it('omits everything when unrestricted (absent=all-global holds)', () => {
    expect(buildAllowedModelsSpec([], CATALOG)).toEqual([])
  })
  it('drops a provider where every enabled model is selected', () => {
    const allowed: HostAllowedModel[] = [
      { provider: 'openai', model: 'gpt-5.4-mini' },
      { provider: 'openai', model: 'gpt-5.4' },
    ]
    expect(buildAllowedModelsSpec(allowed, CATALOG)).toEqual([])
  })
  it('emits only the restricted provider, leaving unrestricted ones out', () => {
    const allowed: HostAllowedModel[] = [
      { provider: 'openai', model: 'gpt-5.4' },
      // claude fully selected → unrestricted → omitted
      { provider: 'claude', model: 'claude-sonnet-4-6' },
      { provider: 'claude', model: 'claude-opus-4-6' },
    ]
    expect(buildAllowedModelsSpec(allowed, CATALOG)).toEqual([
      { provider: 'openai', model: 'gpt-5.4' },
    ])
  })
  it('preserves a subset verbatim when the catalog failed to load (empty)', () => {
    const allowed: HostAllowedModel[] = [{ provider: 'openai', model: 'gpt-5.4' }]
    expect(buildAllowedModelsSpec(allowed, [])).toEqual([{ provider: 'openai', model: 'gpt-5.4' }])
  })
})

describe('normalizeAllowedModels (hydrate from spec)', () => {
  it('returns [] for absent/non-array input', () => {
    expect(normalizeAllowedModels(undefined)).toEqual([])
    expect(normalizeAllowedModels(null)).toEqual([])
    expect(normalizeAllowedModels({})).toEqual([])
  })
  it('keeps valid pairs, trims, drops malformed, de-duplicates', () => {
    const raw = [
      { provider: 'openai', model: ' gpt-5.4 ' },
      { provider: 'openai', model: 'gpt-5.4' }, // duplicate after trim
      { provider: 'claude' }, // missing model
      { model: 'orphan' }, // missing provider
      'nope',
      null,
    ]
    expect(normalizeAllowedModels(raw)).toEqual([{ provider: 'openai', model: 'gpt-5.4' }])
  })
  it('preserves a model that has since left the global allowlist (R3.7)', () => {
    const raw = [{ provider: 'openai', model: 'gpt-legacy' }]
    expect(normalizeAllowedModels(raw)).toEqual([{ provider: 'openai', model: 'gpt-legacy' }])
  })
})
