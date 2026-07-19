import { describe, expect, it } from 'vitest'
import { getActiveCredentialKeys, projectCredentialDraft, validateLlmSecretData } from '../llm'

describe('getActiveCredentialKeys (spec Topic 1b — provider-domain projection)', () => {
  it('is just the primary provider slots when there is no policy', () => {
    expect(Array.from(getActiveCredentialKeys('openai', undefined))).toEqual(['openai-api-key'])
  })

  it('unions a different-provider fallback via its canonical slots (Bedrock pair)', () => {
    const keys = getActiveCredentialKeys('openai', {
      fallbacks: [{ provider: 'bedrock', model: '' }],
    })
    expect(Array.from(keys).sort()).toEqual([
      'aws-access-key-id',
      'aws-secret-access-key',
      'openai-api-key',
    ])
  })

  it('uses a same-provider fallback EXTRA slot when credentialSlot is set', () => {
    const keys = getActiveCredentialKeys('claude', {
      fallbacks: [{ provider: 'claude', model: '', credentialSlot: 'claude-api-key-fb1' }],
    })
    expect(Array.from(keys).sort()).toEqual(['claude-api-key', 'claude-api-key-fb1'])
  })
})

describe('projectCredentialDraft (spec Topic 1b — no stale write / no stale block)', () => {
  it('drops keys outside the active domain, trims, and filters empties', () => {
    const draft = {
      'openai-api-key': ' sk-live ',
      'aws-access-key-id': 'AKIA-orphan', // left behind by a removed Bedrock fallback
      'claude-api-key': '   ', // whitespace only
    }
    const active = getActiveCredentialKeys('openai', undefined)
    expect(projectCredentialDraft(draft, active)).toEqual({ 'openai-api-key': 'sk-live' })
  })

  it('a lone Bedrock key from a removed fallback no longer trips cross-slot validation', () => {
    // A half-filled Bedrock pair WOULD fail validation…
    expect(validateLlmSecretData({ 'aws-access-key-id': 'AKIA' })).toHaveLength(1)
    // …but once projected onto a domain that no longer includes Bedrock, it's gone,
    // so the operator is never locked out of saving by an invisible orphan.
    const projected = projectCredentialDraft(
      { 'openai-api-key': 'sk-live', 'aws-access-key-id': 'AKIA' },
      getActiveCredentialKeys('openai', undefined)
    )
    expect(validateLlmSecretData(projected)).toHaveLength(0)
  })
})
