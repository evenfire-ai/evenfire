import type { CodexPolicyBinding } from '@clerum/codex-catalog-projection'
import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'
import {
  type PluginWorkloadSdkCodexBindingProof,
  isPluginWorkloadSdkCodexBindingProof,
  sanitizePluginWorkloadSdkCodexBindingProof,
} from './sdkOnlyCodexBinding'

let current: PluginWorkloadSdkCodexBindingProof | null = null

export function replaceSdkOnlyGrokBinding(
  next: PluginWorkloadSdkCodexBindingProof | null
): PluginWorkloadSdkCodexBindingProof | null {
  current = next
  return current
}

export function readSdkOnlyGrokBinding(): PluginWorkloadSdkCodexBindingProof | null {
  return current
}

export function sdkOnlyGrokBindingAsPolicy(): CodexPolicyBinding | null {
  if (!current) return null
  return {
    catalogRevision: current.catalogRevision,
    credentialRevision: current.credentialRevision,
    connectionKey: current.connectionKey,
    models: [current.model],
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
  return sanitizePluginWorkloadSdkCodexBindingProof(value)
}
