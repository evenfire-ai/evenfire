import { afterEach, describe, expect, it } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import {
  readLiveCodexPolicyBinding,
  resolveCodexAttemptPolicy,
  setCodexPolicyBindingReader,
} from '../codexPolicyBinding'

describe('resolveCodexAttemptPolicy', () => {
  afterEach(() => {
    setCodexPolicyBindingReader(() => null)
  })

  it('uses a well-formed env override without consulting the live binding', () => {
    const envHash = 'c'.repeat(64)
    expect(
      resolveCodexAttemptPolicy({
        model: 'gpt-5.6-luna',
        envRevision: 1,
        envHash,
        binding: { catalogRevision: 7, credentialRevision: 3 },
      })
    ).toEqual({ policyRevision: 1, policyHash: envHash })
  })

  it('computes the per-model hash from the allowlist catalog/credential pair', () => {
    const binding = { catalogRevision: 7, credentialRevision: 3 }
    const resolved = resolveCodexAttemptPolicy({
      model: 'gpt-5.6-luna',
      envRevision: 1,
      envHash: '',
      binding,
    })
    expect(resolved).toEqual({
      policyRevision: 7,
      policyHash: computeCodexPolicyHash({
        model: 'gpt-5.6-luna',
        catalogRevision: 7,
        credentialRevision: 3,
      }),
    })
    expect(
      resolveCodexAttemptPolicy({
        model: 'gpt-5.6-sol',
        envRevision: 1,
        envHash: '',
        binding,
      })?.policyHash
    ).not.toBe(resolved?.policyHash)
  })

  it('returns null when the catalog revision is missing or not yet synced', () => {
    expect(
      resolveCodexAttemptPolicy({
        model: 'gpt-5.6-luna',
        envRevision: 1,
        envHash: '',
        binding: null,
      })
    ).toBeNull()
    expect(
      resolveCodexAttemptPolicy({
        model: 'gpt-5.6-luna',
        envRevision: 1,
        envHash: '',
        binding: { catalogRevision: 0, credentialRevision: 3 },
      })
    ).toBeNull()
  })

  it('exposes the registered live reader to Host chat construction', () => {
    setCodexPolicyBindingReader(() => ({ catalogRevision: 7, credentialRevision: 3 }))
    expect(readLiveCodexPolicyBinding()).toEqual({
      catalogRevision: 7,
      credentialRevision: 3,
    })
  })
})
