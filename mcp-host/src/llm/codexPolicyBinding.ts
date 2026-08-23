import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'

const POLICY_HASH_RE = /^[a-f0-9]{64}$/

export type CodexPolicyBinding = {
  catalogRevision: number
  credentialRevision: number
  connectionKey?: string
}

export type CodexAttemptPolicy = {
  policyRevision: number
  policyHash: string
}

let reader: () => CodexPolicyBinding | null = () => null

/**
 * Host chat reads catalog/credential revisions from the allowlist ConfigMap
 * (projected by control-api). main.ts registers ConfigStore as the live reader.
 */
export function setCodexPolicyBindingReader(fn: () => CodexPolicyBinding | null): void {
  reader = fn
}

export function readLiveCodexPolicyBinding(): CodexPolicyBinding | null {
  return reader()
}

/**
 * Prefer an explicit env override (tests/dev) when both revision and hash are
 * well-formed. Otherwise bind to the live allowlist catalog/credential pair and
 * hash it for the selected model — the hash is per-model, so a single env hash
 * cannot cover a Host with multiple enabled Codex models.
 */
export function resolveCodexAttemptPolicy(input: {
  model: string
  envRevision: number
  envHash: string
  binding: CodexPolicyBinding | null
}): CodexAttemptPolicy | null {
  const envHash = input.envHash.trim()
  if (
    POLICY_HASH_RE.test(envHash) &&
    Number.isInteger(input.envRevision) &&
    input.envRevision >= 1
  ) {
    return { policyRevision: input.envRevision, policyHash: envHash }
  }
  const binding = input.binding
  if (
    !binding ||
    !Number.isInteger(binding.catalogRevision) ||
    binding.catalogRevision < 1 ||
    !Number.isInteger(binding.credentialRevision) ||
    binding.credentialRevision < 0
  ) {
    return null
  }
  return {
    policyRevision: binding.catalogRevision,
    policyHash: computeCodexPolicyHash({
      model: input.model,
      catalogRevision: binding.catalogRevision,
      credentialRevision: binding.credentialRevision,
      connectionKey: binding.connectionKey,
    }),
  }
}
