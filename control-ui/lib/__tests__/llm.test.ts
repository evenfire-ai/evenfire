import { describe, expect, it } from 'vitest'
import { PROVIDER_IDS } from '@clerum/llm-providers'
import {
  BEDROCK_CREDENTIAL_KEYS,
  LLM_CREDENTIAL_GROUPS,
  LLM_DEFAULT_MODEL_BY_PROVIDER,
  type LlmModelCatalogEntry,
  getAllModelOptions,
  getLlmGroupCompleteness,
  getModelOptions,
  inferProviderFromModels,
  resolveDefaultModel,
  validateLlmSecretData,
} from '../llm'

// The model catalog now comes from the operator allowlist (`/admin/llm-models`),
// so the helpers take the rows as an argument instead of reading a static map.
const CATALOG: LlmModelCatalogEntry[] = [
  { provider: 'openai', model: 'gpt-5.4', enabled: true },
  { provider: 'openai', model: 'gpt-5.4-mini', enabled: true },
  { provider: 'openai', model: 'gpt-5.1-codex', enabled: false },
  { provider: 'claude', model: 'claude-opus-4-7', enabled: true },
  { provider: 'claude', model: 'claude-sonnet-4-6', enabled: true },
  { provider: 'zai', model: 'glm-5.2', enabled: true },
  { provider: 'zai', model: 'glm-5.1', enabled: true },
  { provider: 'bailian', model: 'qwen3-coder-plus', enabled: true },
  { provider: 'bailian', model: 'glm-5.1', enabled: true },
]

describe('getModelOptions', () => {
  it('returns only enabled models for a provider by default', () => {
    expect(getModelOptions(CATALOG, 'openai')).toEqual(['gpt-5.4', 'gpt-5.4-mini'])
  })

  it('includes disabled models when asked', () => {
    expect(getModelOptions(CATALOG, 'openai', { includeDisabled: true })).toEqual([
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.1-codex',
    ])
  })

  it('returns an empty list for a provider with no rows', () => {
    expect(getModelOptions(CATALOG, 'vertex')).toEqual([])
  })
})

describe('getAllModelOptions', () => {
  it('flattens and de-duplicates enabled models across providers', () => {
    const all = getAllModelOptions(CATALOG)
    // glm-5.1 exists for both zai and bailian — appears once.
    expect(all.filter(m => m === 'glm-5.1')).toHaveLength(1)
    expect(all).toContain('gpt-5.4')
    expect(all).toContain('claude-opus-4-7')
    expect(all).not.toContain('gpt-5.1-codex') // disabled
  })
})

describe('resolveDefaultModel', () => {
  it('prefers the static provider default when it is enabled', () => {
    const enabled = getModelOptions(CATALOG, 'claude')
    // Seed the static default into the enabled list to exercise the happy path.
    const claudeDefault = LLM_DEFAULT_MODEL_BY_PROVIDER.claude
    expect(claudeDefault).toBeDefined()
    const withDefault = [...enabled, claudeDefault!]
    expect(resolveDefaultModel('claude', withDefault)).toBe(claudeDefault)
  })

  it('falls back to the first enabled model when the default is not allowed', () => {
    // 'gpt-5.4-mini' (the static openai default) is intentionally absent here.
    expect(resolveDefaultModel('openai', ['gpt-5.4', 'gpt-5.1-codex'])).toBe('gpt-5.4')
  })

  it('returns an empty string when the provider has no enabled models', () => {
    expect(resolveDefaultModel('openai', [])).toBe('')
  })
})

describe('inferProviderFromModels', () => {
  it('recovers the provider from the first model found in the catalog', () => {
    expect(inferProviderFromModels(['glm-5.2'], CATALOG)).toBe('zai')
    expect(inferProviderFromModels(['claude-sonnet-4-6'], CATALOG)).toBe('claude')
    expect(inferProviderFromModels(['gpt-5.4-mini'], CATALOG)).toBe('openai')
    expect(inferProviderFromModels(['qwen3-coder-plus'], CATALOG)).toBe('bailian')
  })

  it('uses the first recognized model when the list is mixed', () => {
    expect(inferProviderFromModels(['unknown-model', 'glm-5.2'], CATALOG)).toBe('zai')
  })

  it('defaults to the first provider option for an empty or unknown list', () => {
    expect(inferProviderFromModels([], CATALOG)).toBe('openai')
    expect(inferProviderFromModels(['some-future-model'], CATALOG)).toBe('openai')
  })
})

describe('LLM_CREDENTIAL_GROUPS (spec R4.5.1/R4.5.2)', () => {
  it('renders one group per canonical provider, derived from the package', () => {
    // Derived from the package so this never drifts as providers are added
    // (R6 expanded the set to 21). One group per canonical id, in order.
    expect(LLM_CREDENTIAL_GROUPS.map(g => g.provider)).toEqual([...PROVIDER_IDS])
  })

  it('models single-slot providers as one field', () => {
    const openai = LLM_CREDENTIAL_GROUPS.find(g => g.provider === 'openai')!
    expect(openai.slots.map(s => s.dataKey)).toEqual(['openai-api-key'])
    expect(openai.slots[0].multiline).toBe(false)
  })

  it('models Bedrock as the access-key pair', () => {
    const bedrock = LLM_CREDENTIAL_GROUPS.find(g => g.provider === 'bedrock')!
    expect(bedrock.slots.map(s => s.dataKey)).toEqual([
      'aws-access-key-id',
      'aws-secret-access-key',
    ])
    expect(bedrock.nonSecretEnv).toContain('AWS_REGION')
  })

  it('models Vertex as a multiline service-account JSON slot with env hints', () => {
    const vertex = LLM_CREDENTIAL_GROUPS.find(g => g.provider === 'vertex')!
    expect(vertex.slots.map(s => s.dataKey)).toEqual(['vertex-service-account-json'])
    expect(vertex.slots[0].multiline).toBe(true)
    expect(vertex.nonSecretEnv).toEqual(expect.arrayContaining(['VERTEX_PROJECT_ID']))
  })

  it('models Codex as a zero-slot broker with no static default model', () => {
    const codex = LLM_CREDENTIAL_GROUPS.find(g => g.provider === 'codex-subscription')!
    expect(codex.slots).toEqual([])
    expect(codex.nonSecretEnv).toEqual([])
    expect(LLM_DEFAULT_MODEL_BY_PROVIDER['codex-subscription']).toBeUndefined()
    expect(resolveDefaultModel('codex-subscription', ['gpt-5.1'])).toBe('gpt-5.1')
  })
})

describe('getLlmGroupCompleteness (spec R4.5.5)', () => {
  const bedrock = LLM_CREDENTIAL_GROUPS.find(g => g.provider === 'bedrock')!
  const openai = LLM_CREDENTIAL_GROUPS.find(g => g.provider === 'openai')!

  it('marks a single-slot provider usable once its key is present', () => {
    expect(getLlmGroupCompleteness(openai, () => false)).toEqual({
      present: 0,
      total: 1,
      usable: false,
    })
    expect(getLlmGroupCompleteness(openai, () => true).usable).toBe(true)
  })

  it('is usable for Bedrock only when both required slots are present', () => {
    expect(getLlmGroupCompleteness(bedrock, k => k === 'aws-access-key-id')).toEqual({
      present: 1,
      total: 2,
      usable: false,
    })
    expect(getLlmGroupCompleteness(bedrock, () => true)).toEqual({
      present: 2,
      total: 2,
      usable: true,
    })
  })
})

describe('validateLlmSecretData (spec R4.5.3)', () => {
  it('accepts an empty payload and single-key providers', () => {
    expect(validateLlmSecretData({})).toEqual([])
    expect(validateLlmSecretData({ 'openai-api-key': 'sk-x' })).toEqual([])
  })

  it('rejects a half-written Bedrock pair', () => {
    const errors = validateLlmSecretData({ 'aws-access-key-id': 'AKIA' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/aws-secret-access-key/)
  })

  it('accepts the full Bedrock pair', () => {
    expect(
      validateLlmSecretData({
        'aws-access-key-id': 'AKIA',
        'aws-secret-access-key': 'secret',
      })
    ).toEqual([])
    // Guard against a divergent hardcoded key list.
    expect(BEDROCK_CREDENTIAL_KEYS).toEqual(['aws-access-key-id', 'aws-secret-access-key'])
  })

  it('rejects malformed Vertex JSON', () => {
    expect(validateLlmSecretData({ 'vertex-service-account-json': 'nope' })[0]).toMatch(/JSON/)
  })

  it('rejects Vertex JSON missing required fields', () => {
    const errors = validateLlmSecretData({
      'vertex-service-account-json': JSON.stringify({ type: 'service_account' }),
    })
    expect(errors[0]).toMatch(/client_email/)
  })

  it('accepts a well-formed Vertex service-account JSON', () => {
    expect(
      validateLlmSecretData({
        'vertex-service-account-json': JSON.stringify({
          client_email: 'sa@p.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
        }),
      })
    ).toEqual([])
  })
})
