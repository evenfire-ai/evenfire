import {
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexPolicyBinding,
} from '@clerum/codex-catalog-projection'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'

const POLICY_HASH_RE = /^[a-f0-9]{64}$/

/**
 * Sanitized Codex execution proof carried on Plugin Workload SDK bootstrap
 * configure v3. No OAuth material, Secret name, or unrestricted catalog.
 */
export type PluginWorkloadSdkCodexBindingProof = {
  connectionKey: string
  catalogRevision: number
  credentialRevision: number
  model: string
  bindingHash: string
}

let current: PluginWorkloadSdkCodexBindingProof | null = null

export function replaceSdkOnlyCodexBinding(
  next: PluginWorkloadSdkCodexBindingProof | null
): PluginWorkloadSdkCodexBindingProof | null {
  current = next
  return current
}

export function readSdkOnlyCodexBinding(): PluginWorkloadSdkCodexBindingProof | null {
  return current
}

export function sdkOnlyBindingAsPolicy(): CodexPolicyBinding | null {
  if (!current) return null
  return {
    catalogRevision: current.catalogRevision,
    credentialRevision: current.credentialRevision,
    connectionKey: current.connectionKey,
    models: [current.model],
  }
}

export function isPluginWorkloadSdkCodexBindingProof(
  value: unknown
): value is PluginWorkloadSdkCodexBindingProof {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.connectionKey === 'string' &&
    candidate.connectionKey.trim().length > 0 &&
    candidate.connectionKey !== CODEX_UNASSIGNED_CONNECTION_KEY &&
    Number.isInteger(candidate.catalogRevision) &&
    Number(candidate.catalogRevision) >= 1 &&
    Number.isInteger(candidate.credentialRevision) &&
    Number(candidate.credentialRevision) >= 0 &&
    typeof candidate.model === 'string' &&
    candidate.model.trim().length > 0 &&
    typeof candidate.bindingHash === 'string' &&
    POLICY_HASH_RE.test(candidate.bindingHash)
  )
}

export function verifySdkOnlyCodexBindingHash(
  binding: PluginWorkloadSdkCodexBindingProof
): boolean {
  return (
    binding.bindingHash ===
    computeCodexPolicyHash({
      model: binding.model,
      catalogRevision: binding.catalogRevision,
      credentialRevision: binding.credentialRevision,
      connectionKey: binding.connectionKey,
    })
  )
}

/**
 * Integrity-check a caller-supplied Codex binding against the expected model.
 * This must run for every bootstrap request that carries a binding object;
 * the request provider/version must not decide whether the hash is verified.
 */
export function sanitizePluginWorkloadSdkCodexBindingProof(
  binding: PluginWorkloadSdkCodexBindingProof
): PluginWorkloadSdkCodexBindingProof {
  return {
    connectionKey: binding.connectionKey,
    catalogRevision: binding.catalogRevision,
    credentialRevision: binding.credentialRevision,
    model: binding.model,
    bindingHash: binding.bindingHash,
  }
}

export function readVerifiedSdkOnlyCodexBinding(
  value: unknown,
  model: string
): PluginWorkloadSdkCodexBindingProof | null {
  if (!isPluginWorkloadSdkCodexBindingProof(value)) return null
  if (value.model !== model) return null
  if (!verifySdkOnlyCodexBindingHash(value)) return null
  return sanitizePluginWorkloadSdkCodexBindingProof(value)
}
