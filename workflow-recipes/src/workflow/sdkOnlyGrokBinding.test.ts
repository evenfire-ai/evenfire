import { describe, expect, it } from 'vitest'
import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import { mintSdkOnlyGrokBindingProof, readVerifiedSdkOnlyGrokBinding } from './sdkOnlyGrokBinding'

const MODEL = 'grok-4.6'

const HASH = computeGrokPolicyHash({
  model: MODEL,
  catalogRevision: 5,
  credentialRevision: 2,
  connectionKey: 'team-grok',
})

describe('readVerifiedSdkOnlyGrokBinding', () => {
  it('rebuilds a five-field proof and drops extra keys', () => {
    const proof = {
      connectionKey: 'team-grok',
      catalogRevision: 5,
      credentialRevision: 2,
      model: MODEL,
      bindingHash: HASH,
      extra: true,
    }
    expect(readVerifiedSdkOnlyGrokBinding(proof, MODEL)).toEqual({
      connectionKey: 'team-grok',
      catalogRevision: 5,
      credentialRevision: 2,
      model: MODEL,
      bindingHash: HASH,
    })
  })

  it('rejects a Codex digest for the same five fields', () => {
    const proof = mintSdkOnlyGrokBindingProof({
      connectionKey: 'team-grok',
      catalogRevision: 5,
      credentialRevision: 2,
      model: MODEL,
    })
    expect(
      readVerifiedSdkOnlyGrokBinding(
        {
          ...proof,
          bindingHash: computeCodexPolicyHash({
            model: MODEL,
            catalogRevision: 5,
            credentialRevision: 2,
            connectionKey: 'team-grok',
          }),
        },
        MODEL
      )
    ).toBeNull()
    expect(readVerifiedSdkOnlyGrokBinding(proof, MODEL)).toEqual(proof)
  })

  it('rejects the unassigned sentinel', () => {
    expect(
      readVerifiedSdkOnlyGrokBinding(
        {
          connectionKey: 'unassigned',
          catalogRevision: 5,
          credentialRevision: 2,
          model: MODEL,
          bindingHash: HASH,
        },
        MODEL
      )
    ).toBeNull()
  })

  it('rejects a self-consistent proof minted for another model', () => {
    // Mutation caught: dropping the model pin. The hash covers the five
    // fields, so a proof for another model verifies on its own.
    const other = mintSdkOnlyGrokBindingProof({
      connectionKey: 'team-grok',
      catalogRevision: 5,
      credentialRevision: 2,
      model: 'grok-build-0.1',
    })
    expect(readVerifiedSdkOnlyGrokBinding(other, MODEL)).toBeNull()
    expect(readVerifiedSdkOnlyGrokBinding(other, 'grok-build-0.1')).toEqual(other)
  })
})
