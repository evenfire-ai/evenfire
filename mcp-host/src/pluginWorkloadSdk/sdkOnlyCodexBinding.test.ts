import { describe, expect, it } from 'vitest'
import { CODEX_UNASSIGNED_CONNECTION_KEY } from '@clerum/codex-catalog-projection'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import {
  isPluginWorkloadSdkCodexBindingProof,
  readVerifiedSdkOnlyCodexBinding,
} from './sdkOnlyCodexBinding'

describe('mcp-host sdk-only Codex binding proof', () => {
  const model = 'gpt-5.6-luna'
  const proof = {
    connectionKey: 'team-plus',
    catalogRevision: 4,
    credentialRevision: 1,
    model,
    bindingHash: computeCodexPolicyHash({
      model,
      catalogRevision: 4,
      credentialRevision: 1,
      connectionKey: 'team-plus',
    }),
  }

  it('rejects the unassigned connection sentinel', () => {
    expect(
      isPluginWorkloadSdkCodexBindingProof({
        ...proof,
        connectionKey: CODEX_UNASSIGNED_CONNECTION_KEY,
      })
    ).toBe(false)
    expect(
      readVerifiedSdkOnlyCodexBinding(
        {
          ...proof,
          connectionKey: CODEX_UNASSIGNED_CONNECTION_KEY,
          bindingHash: computeCodexPolicyHash({
            model,
            catalogRevision: 4,
            credentialRevision: 1,
            connectionKey: CODEX_UNASSIGNED_CONNECTION_KEY,
          }),
        },
        model
      )
    ).toBeNull()
  })

  it('strips extra keys after the hash verifies', () => {
    expect(readVerifiedSdkOnlyCodexBinding({ ...proof, extra: 'drop-me' }, model)).toEqual(proof)
  })
})
