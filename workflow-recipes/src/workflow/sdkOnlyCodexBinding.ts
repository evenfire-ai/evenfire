import { CODEX_UNASSIGNED_CONNECTION_KEY } from '@clerum/codex-catalog-projection'
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
    // `credential_revision` is CHECK (>= 1) in codex_subscription_connections.
    // `catalogRevision >= 1` above is a binding invariant rather than a row
    // one: a proof is only minted for an eligible catalog, and the sole writer
    // of catalog_status='ready' bumps catalog_revision in the same UPDATE.
    Number(candidate.credentialRevision) >= 1 &&
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
 * Return a public-field copy of an already-typed Codex binding.
 * Hash and model checks live on `readVerifiedSdkOnlyCodexBinding`.
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

/**
 * R4-L1: `model` is REQUIRED. It used to be optional and the model pin was
 * skipped when omitted, so a caller that forgot it would accept a binding for
 * another model. mcp-host's twin has always required it; the two now agree.
 */
export function readVerifiedSdkOnlyCodexBinding(
  value: unknown,
  model: string
): PluginWorkloadSdkCodexBindingProof | null {
  if (!isPluginWorkloadSdkCodexBindingProof(value)) return null
  if (value.model !== model) return null
  if (!verifySdkOnlyCodexBindingHash(value)) return null
  return sanitizePluginWorkloadSdkCodexBindingProof(value)
}

/**
 * Mint the sanitized five-field v3 proof from an already-eligible binding.
 *
 * Deliberately NOT exported alongside a "derive from a ConfigMap" helper any
 * more. Those helpers (`deriveSdkOnlyCodexBinding` / `resolveSdkOnlyCodexBinding`)
 * were blind to provenance, so a caller could obtain a binding for a recipe
 * whose Codex authority could not be established — the R5-B1 wipe. The only
 * caller is `projectCodexRecipeVerdict`, which gates on provenance and
 * eligibility first. Removed rather than deprecated, for the same reason
 * `readOk` was removed: a reachable blind path invites the sibling back.
 */
export function mintSdkOnlyCodexBindingProof(binding: {
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
    bindingHash: computeCodexPolicyHash({
      model: binding.model,
      catalogRevision: binding.catalogRevision,
      credentialRevision: binding.credentialRevision,
      connectionKey: binding.connectionKey,
    }),
  }
}
