import { describe, expect, it } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import {
  deriveSdkOnlyCodexBinding,
  isPluginWorkloadSdkCodexBindingProof,
  readVerifiedSdkOnlyCodexBinding,
  verifySdkOnlyCodexBindingHash,
} from './sdkOnlyCodexBinding'

const HASH = computeCodexPolicyHash({
  model: 'gpt-5.6-luna',
  catalogRevision: 3,
  credentialRevision: 1,
  connectionKey: 'team-plus',
})

describe('deriveSdkOnlyCodexBinding', () => {
  it('returns a hashed v3 proof for an assigned executable catalog', () => {
    const binding = deriveSdkOnlyCodexBinding({
      provider: 'codex-subscription',
      model: 'gpt-5.6-luna',
      connectionKey: 'team-plus',
      configMap: {
        metadata: {
          annotations: {
            'clerum.io/catalog-revision': '3',
            'clerum.io/connection-revision': '1',
          },
        },
      },
    })
    expect(binding).toEqual({
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: 'gpt-5.6-luna',
      bindingHash: HASH,
    })
    expect(verifySdkOnlyCodexBindingHash(binding!)).toBe(true)
    expect(isPluginWorkloadSdkCodexBindingProof(binding)).toBe(true)
  })

  it('returns null for non-Codex providers and unassigned grants', () => {
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'openai',
        model: 'gpt-5.4-mini',
        connectionKey: 'team-plus',
        configMap: undefined,
      })
    ).toBeNull()
    expect(
      deriveSdkOnlyCodexBinding({
        provider: 'codex-subscription',
        model: 'gpt-5.6-luna',
        connectionKey: 'unassigned',
        configMap: undefined,
      })
    ).toBeNull()
  })

  it('rebuilds a five-field proof and drops extra keys', () => {
    const proof = {
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: 'gpt-5.6-luna',
      bindingHash: HASH,
      extra: true,
    }
    expect(readVerifiedSdkOnlyCodexBinding(proof)).toEqual({
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: 'gpt-5.6-luna',
      bindingHash: HASH,
    })
  })
})
