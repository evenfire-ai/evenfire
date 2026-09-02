import { describe, expect, it } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import { readVerifiedSdkOnlyCodexBinding } from './sdkOnlyCodexBinding'

const MODEL = 'gpt-5.6-luna'

const HASH = computeCodexPolicyHash({
  model: MODEL,
  catalogRevision: 3,
  credentialRevision: 1,
  connectionKey: 'team-plus',
})

describe('readVerifiedSdkOnlyCodexBinding', () => {
  // The derive/resolve suite moved to codexRecipeVerdict.test.ts along with
  // the functions themselves (R5-B1): those entry points were blind to
  // provenance and are deleted, not deprecated.
  it('rebuilds a five-field proof and drops extra keys', () => {
    const proof = {
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
      extra: true,
    }
    // R4-L1: the model is a required argument now. This call used to omit it,
    // which silently skipped the pin — the very gap the change closes.
    expect(readVerifiedSdkOnlyCodexBinding(proof, MODEL)).toEqual({
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
    })
  })

  it('rejects a well-formed proof minted for another model', () => {
    const proof = {
      connectionKey: 'team-plus',
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: HASH,
    }
    expect(readVerifiedSdkOnlyCodexBinding(proof, 'gpt-5.1')).toBeNull()
    expect(readVerifiedSdkOnlyCodexBinding(proof, MODEL)).toEqual(proof)
  })
})
