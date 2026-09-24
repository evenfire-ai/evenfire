import { afterEach, describe, expect, it } from 'vitest'
import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'
import {
  readLiveGrokPolicyBinding,
  resolveGrokAttemptPolicy,
  setGrokPolicyBindingReader,
} from '../grokPolicyBinding'

describe('resolveGrokAttemptPolicy', () => {
  afterEach(() => {
    setGrokPolicyBindingReader(() => null)
  })

  it('uses a well-formed env override without consulting the live binding', () => {
    const envHash = 'c'.repeat(64)
    expect(
      resolveGrokAttemptPolicy({
        model: 'grok-4.6',
        envRevision: 1,
        envHash,
        binding: { catalogRevision: 7, credentialRevision: 3, connectionKey: 'team-grok' },
      })
    ).toEqual({ policyRevision: 1, policyHash: envHash })
  })

  it('computes the per-model hash from the Grok catalog/credential pair', () => {
    const binding = { catalogRevision: 7, credentialRevision: 3, connectionKey: 'team-grok' }
    const resolved = resolveGrokAttemptPolicy({
      model: 'grok-4.6',
      envRevision: 1,
      envHash: '',
      binding,
    })
    expect(resolved).toEqual({
      policyRevision: 7,
      policyHash: computeGrokPolicyHash({
        model: 'grok-4.6',
        catalogRevision: 7,
        credentialRevision: 3,
        connectionKey: 'team-grok',
      }),
    })
  })

  it('returns null when the catalog revision is missing or not yet synced', () => {
    expect(
      resolveGrokAttemptPolicy({
        model: 'grok-4.6',
        envRevision: 1,
        envHash: '',
        binding: null,
      })
    ).toBeNull()
  })

  it('exposes the registered live reader to Host chat construction', () => {
    setGrokPolicyBindingReader(() => ({
      catalogRevision: 7,
      credentialRevision: 3,
      connectionKey: 'team-grok',
    }))
    expect(readLiveGrokPolicyBinding()).toEqual({
      catalogRevision: 7,
      credentialRevision: 3,
      connectionKey: 'team-grok',
    })
  })
})
