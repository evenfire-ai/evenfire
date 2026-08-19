import { describe, expect, it } from 'vitest'
import {
  type LlmModelCatalogEntry,
  buildPromptBridgeTargetPolicy,
  getCredentialSlotOptions,
  getPromptBridgeCredentialSlotOptions,
  normalizeLlmPolicy,
  providerSupportsFallbackCredentialSlot,
  validateLlmPolicy,
} from '../llm'

const CATALOG: LlmModelCatalogEntry[] = [
  { provider: 'claude', model: 'claude-opus-4-8', enabled: true },
  { provider: 'claude', model: 'claude-legacy', enabled: false },
  { provider: 'openai', model: 'gpt-5.4', enabled: true },
]

describe('providerSupportsFallbackCredentialSlot (client mirror of the backend gate)', () => {
  it('is true for single simple-key providers', () => {
    expect(providerSupportsFallbackCredentialSlot('claude')).toBe(true)
    expect(providerSupportsFallbackCredentialSlot('openai')).toBe(true)
  })

  it('is false for the Bedrock key pair and the Vertex JSON slot', () => {
    expect(providerSupportsFallbackCredentialSlot('bedrock')).toBe(false)
    expect(providerSupportsFallbackCredentialSlot('vertex')).toBe(false)
  })
})

describe('getCredentialSlotOptions (spec R4.5.6)', () => {
  it('returns the provider registry slots by default', () => {
    expect(getCredentialSlotOptions('claude')).toEqual(['claude-api-key'])
  })

  it('returns nothing for providers that can not express a single-key slot', () => {
    // Bedrock (key pair) and Vertex (JSON) can't be a single credentialSlot — the
    // backend 422s any such slot, so the UI must offer none of them.
    expect(getCredentialSlotOptions('bedrock')).toEqual([])
    expect(getCredentialSlotOptions('vertex')).toEqual([])
    expect(
      getCredentialSlotOptions('bedrock', ['aws-access-key-id', 'aws-secret-access-key'])
    ).toEqual([])
  })

  it('adds extra Secret keys that belong to the provider, sorted', () => {
    const opts = getCredentialSlotOptions('claude', [
      'claude-api-key',
      'claude-api-key-fb2',
      'claude-api-key-fb1',
      'openai-api-key',
      'openai-api-key-fb1',
      'claude-project',
    ])
    expect(opts).toEqual(['claude-api-key', 'claude-api-key-fb1', 'claude-api-key-fb2'])
    // Another provider's keys never leak in.
    expect(opts).not.toContain('openai-api-key')
    expect(opts).not.toContain('openai-api-key-fb1')
    expect(opts).not.toContain('claude-project')
  })
})

describe('getPromptBridgeCredentialSlotOptions', () => {
  it('keeps canonical multiline and multi-slot provider identities selectable', () => {
    expect(getPromptBridgeCredentialSlotOptions('vertex')).toEqual(['vertex-service-account-json'])
    expect(getPromptBridgeCredentialSlotOptions('bedrock')).toEqual([
      'aws-access-key-id',
      'aws-secret-access-key',
    ])
  })

  it('allows suffixed extra identities only for single-key providers', () => {
    expect(
      getPromptBridgeCredentialSlotOptions('claude', [
        'claude-api-key',
        'claude-api-key-fb1',
        'claude-project',
        'vertex-service-account-json-fb1',
      ])
    ).toEqual(['claude-api-key', 'claude-api-key-fb1'])
  })
})

describe('buildPromptBridgeTargetPolicy', () => {
  it('derives the default, provider and model inventory from ordered targets', () => {
    const fallback = {
      targetRef: 'fallback-openai',
      provider: 'openai',
      model: 'gpt-5.4',
      credentialSlot: 'openai-api-key-fb1',
    }
    const primary = {
      targetRef: 'primary-claude',
      provider: 'claude',
      model: 'claude-opus-4-8',
      credentialSlot: 'claude-api-key',
    }

    expect(buildPromptBridgeTargetPolicy([primary, fallback])).toEqual({
      provider: 'claude',
      allowedModels: ['claude-opus-4-8', 'gpt-5.4'],
      promptTargets: [primary, fallback],
      defaultTargetRef: 'primary-claude',
    })
  })

  it('does not invent a provider or default for an empty policy', () => {
    expect(buildPromptBridgeTargetPolicy([])).toEqual({
      allowedModels: [],
      promptTargets: [],
    })
  })
})

describe('validateLlmPolicy (client mirror of control-api gate)', () => {
  it('accepts a policy whose fallback models are enabled', () => {
    expect(
      validateLlmPolicy(
        {
          cooldownSeconds: 300,
          triggerOn: ['auth'],
          fallbacks: [{ provider: 'claude', model: 'claude-opus-4-8' }],
        },
        CATALOG
      )
    ).toEqual([])
  })

  it('rejects a model that is not enabled in the allowlist', () => {
    const errs = validateLlmPolicy(
      { fallbacks: [{ provider: 'claude', model: 'claude-legacy' }] },
      CATALOG
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('not enabled in the allowlist')
  })

  it('rejects an empty triggerOn and a negative cooldown', () => {
    const errs = validateLlmPolicy(
      { cooldownSeconds: -5, triggerOn: [], fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }] },
      CATALOG
    )
    expect(errs.some(e => e.includes('at least one'))).toBe(true)
    expect(errs.some(e => e.includes('non-negative'))).toBe(true)
  })

  it('rejects a credentialSlot on a Bedrock/Vertex fallback (mirrors the backend 422)', () => {
    const errs = validateLlmPolicy(
      {
        triggerOn: ['auth'],
        fallbacks: [
          {
            provider: 'bedrock',
            model: 'anthropic.claude-sonnet-4-6-v1:0',
            credentialSlot: 'aws-access-key-id',
          },
        ],
      },
      [
        ...CATALOG,
        { provider: 'bedrock', model: 'anthropic.claude-sonnet-4-6-v1:0', enabled: true },
      ]
    )
    expect(errs.some(e => e.includes('reuse the primary credentials'))).toBe(true)
  })
})

describe('normalizeLlmPolicy (loading spec.llmPolicy)', () => {
  it('returns undefined for empty/garbage input', () => {
    expect(normalizeLlmPolicy(undefined)).toBeUndefined()
    expect(normalizeLlmPolicy({})).toBeUndefined()
    expect(normalizeLlmPolicy({ fallbacks: [] })).toBeUndefined()
    expect(normalizeLlmPolicy('nope')).toBeUndefined()
  })

  it('coerces a raw CR policy into the editor shape with defaults', () => {
    const policy = normalizeLlmPolicy({
      fallbacks: [
        { provider: 'claude', model: 'claude-opus-4-8', credentialSlot: 'claude-api-key-fb1' },
      ],
    })
    expect(policy).toEqual({
      cooldownSeconds: 300,
      triggerOn: ['insufficient_quota', 'auth', 'provider_unavailable', 'rate_limited'],
      fallbacks: [
        { provider: 'claude', model: 'claude-opus-4-8', credentialSlot: 'claude-api-key-fb1' },
      ],
    })
  })

  it('preserves configured cooldown/triggerOn and drops blank slots', () => {
    const policy = normalizeLlmPolicy({
      cooldownSeconds: 60,
      triggerOn: ['auth', 'bogus', 'rate_limited'],
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4', credentialSlot: '   ' }],
    })
    expect(policy?.cooldownSeconds).toBe(60)
    expect(policy?.triggerOn).toEqual(['auth', 'rate_limited'])
    expect(policy?.fallbacks[0].credentialSlot).toBeUndefined()
  })
})
