import {
  CODEX_PROVIDER,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexConfigMapView,
  toEligiblePolicyBinding,
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
 * Derive the sanitized v3 Codex execution proof from one WRC snapshot.
 *
 * Eligibility is decided by `toEligiblePolicyBinding`, the same cascade that
 * derives `llm:codex:execute`, so a recipe can never be handed an execution
 * binding for a grant whose scope the reconciler withholds (and vice versa).
 * Returns null when the grant is unassigned, the Codex flag is off, the
 * connection is not `connected`, the catalog is stale, or the selected model
 * is not in the assigned connection's catalog.
 */
export type SdkOnlyCodexBindingResolution = {
  binding: PluginWorkloadSdkCodexBindingProof | null
  eligibility: 'eligible' | 'ineligible' | 'uncertain'
  reason: string
}

/**
 * R4-B1: the same call must answer both "which binding?" and "was the catalog
 * decidable at all?". The reconciler previously derived the second from
 * `readOk`, a pure IO signal that is `true` for a ConfigMap that reads fine
 * but parses badly — so a malformed `catalog-revision` produced `uncertain`
 * on the scope path while the configure path saw a decidable catalog and sent
 * a binding-less v3 configure, wiping the live execution binding.
 * `uncertain` strictly subsumes `!readOk`: an unreadable ConfigMap is
 * `missing`, which is also `uncertain`.
 */
export function resolveSdkOnlyCodexBinding(input: {
  provider: string
  model: string
  connectionKey: string | undefined
  configMap: CodexConfigMapView | undefined
  log?: { debug(msg: string, fields?: Record<string, unknown>): void }
}): SdkOnlyCodexBindingResolution {
  if (input.provider !== CODEX_PROVIDER) {
    return { binding: null, eligibility: 'ineligible', reason: 'provider_not_codex' }
  }
  const { binding, eligibility, reason } = toEligiblePolicyBinding(
    input.configMap,
    input.connectionKey,
    input.model
  )
  if (!binding || binding.catalogRevision < 1 || binding.credentialRevision < 1) {
    const withheldReason = binding ? 'revision_out_of_range' : reason
    input.log?.debug('Codex execution binding withheld', {
      model: input.model,
      connectionKey: input.connectionKey ?? CODEX_UNASSIGNED_CONNECTION_KEY,
      eligibility,
      reason: withheldReason,
    })
    return { binding: null, eligibility, reason: withheldReason }
  }
  return { binding: toProof(binding), eligibility, reason }
}

export function deriveSdkOnlyCodexBinding(input: {
  provider: string
  model: string
  connectionKey: string | undefined
  configMap: CodexConfigMapView | undefined
  log?: { debug(msg: string, fields?: Record<string, unknown>): void }
}): PluginWorkloadSdkCodexBindingProof | null {
  return resolveSdkOnlyCodexBinding(input).binding
}

function toProof(binding: {
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
