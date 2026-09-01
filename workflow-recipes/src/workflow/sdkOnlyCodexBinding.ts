import {
  CODEX_PROVIDER,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexConfigMapView,
  toPolicyBinding,
} from '@clerum/codex-catalog-projection'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'

const POLICY_HASH_RE = /^[a-f0-9]{64}$/

export type PluginWorkloadSdkCodexBindingProof = {
  connectionKey: string
  catalogRevision: number
  credentialRevision: number
  model: string
  bindingHash: string
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
  model?: string
): PluginWorkloadSdkCodexBindingProof | null {
  if (!isPluginWorkloadSdkCodexBindingProof(value)) return null
  if (model !== undefined && value.model !== model) return null
  if (!verifySdkOnlyCodexBindingHash(value)) return null
  return sanitizePluginWorkloadSdkCodexBindingProof(value)
}

/**
 * Derive the sanitized v3 Codex execution proof from one WRC snapshot.
 * Returns null when the grant is unassigned, the catalog is not executable,
 * or the selected model is not in the assigned connection's model list.
 */
export function deriveSdkOnlyCodexBinding(input: {
  provider: string
  model: string
  connectionKey: string | undefined
  configMap: CodexConfigMapView | undefined
}): PluginWorkloadSdkCodexBindingProof | null {
  if (input.provider !== CODEX_PROVIDER) return null
  const policy = toPolicyBinding(input.configMap, input.connectionKey)
  if (
    !policy ||
    !policy.connectionKey ||
    policy.connectionKey === CODEX_UNASSIGNED_CONNECTION_KEY ||
    !Number.isInteger(policy.catalogRevision) ||
    policy.catalogRevision < 1 ||
    !Number.isInteger(policy.credentialRevision) ||
    policy.credentialRevision < 0
  ) {
    return null
  }
  if (Array.isArray(policy.models) && !policy.models.includes(input.model)) {
    return null
  }
  return {
    connectionKey: policy.connectionKey,
    catalogRevision: policy.catalogRevision,
    credentialRevision: policy.credentialRevision,
    model: input.model,
    bindingHash: computeCodexPolicyHash({
      model: input.model,
      catalogRevision: policy.catalogRevision,
      credentialRevision: policy.credentialRevision,
      connectionKey: policy.connectionKey,
    }),
  }
}
