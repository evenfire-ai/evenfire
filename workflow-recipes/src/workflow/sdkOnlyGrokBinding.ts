import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'
import type { PluginWorkloadSdkCodexBindingProof } from './sdkOnlyCodexBinding'
import {
  isPluginWorkloadSdkCodexBindingProof,
  sanitizePluginWorkloadSdkCodexBindingProof,
} from './sdkOnlyCodexBinding'

export function mintSdkOnlyGrokBindingProof(binding: {
  connectionKey: string
  catalogRevision: number
  credentialRevision: number
  model: string
}): PluginWorkloadSdkCodexBindingProof {
  return {
    connectionKey: binding.connectionKey,
    catalogRevision: binding.catalogRevision,
    credentialRevision: binding.credentialRevision,
    model: binding.model,
    bindingHash: computeGrokPolicyHash({
      model: binding.model,
      catalogRevision: binding.catalogRevision,
      credentialRevision: binding.credentialRevision,
      connectionKey: binding.connectionKey,
    }),
  }
}

export function verifySdkOnlyGrokBindingHash(binding: PluginWorkloadSdkCodexBindingProof): boolean {
  return (
    binding.bindingHash ===
    computeGrokPolicyHash({
      model: binding.model,
      catalogRevision: binding.catalogRevision,
      credentialRevision: binding.credentialRevision,
      connectionKey: binding.connectionKey,
    })
  )
}

export function readVerifiedSdkOnlyGrokBinding(
  value: unknown,
  model: string
): PluginWorkloadSdkCodexBindingProof | null {
  if (!isPluginWorkloadSdkCodexBindingProof(value)) return null
  if (value.model !== model) return null
  if (!verifySdkOnlyGrokBindingHash(value)) return null
  // The five-field proof shape is provider-neutral; only the digest differs.
  return sanitizePluginWorkloadSdkCodexBindingProof(value)
}
