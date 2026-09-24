import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'

const POLICY_HASH_RE = /^[a-f0-9]{64}$/

export type GrokPolicyBinding = {
  catalogRevision: number
  credentialRevision: number
  connectionKey: string
}

export type GrokAttemptPolicy = {
  policyRevision: number
  policyHash: string
}

let reader: () => GrokPolicyBinding | null = () => null

export function setGrokPolicyBindingReader(fn: () => GrokPolicyBinding | null): void {
  reader = fn
}

export function readLiveGrokPolicyBinding(): GrokPolicyBinding | null {
  return reader()
}

export function resolveGrokAttemptPolicy(input: {
  model: string
  envRevision: number
  envHash: string
  binding: GrokPolicyBinding | null
}): GrokAttemptPolicy | null {
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
    binding.credentialRevision < 1
  ) {
    return null
  }
  return {
    policyRevision: binding.catalogRevision,
    policyHash: computeGrokPolicyHash({
      model: input.model,
      catalogRevision: binding.catalogRevision,
      credentialRevision: binding.credentialRevision,
      connectionKey: binding.connectionKey,
    }),
  }
}
