import { config } from '../../config.js'

// The Secret name(s) that hold LLM provider API keys under the SHARED,
// name-conventional model (the `chatllm-api-keys` Secret that WorkflowRecipe
// hosts still read via the `workflow-recipes-model-config-reader` Role).
// Generic Opaque Secrets may legitimately hold a lone `aws-access-key-id` (e.g.
// a plain AWS credential Secret) and MUST NOT trip the bedrock paired-slot rule
// — so name-based identity is scoped to these known LLM Secret name(s).
// Override via CONTROL_API_LLM_SECRET_NAMES (comma-separated) when a deployment
// names it differently.
export const LLM_SECRET_NAMES: ReadonlySet<string> = new Set(
  (process.env.CONTROL_API_LLM_SECRET_NAMES || 'chatllm-api-keys')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
)

export function isLlmSecretName(name: unknown): boolean {
  return typeof name === 'string' && LLM_SECRET_NAMES.has(name.trim())
}

// True when the Secret's labels carry the host-secret marker the wizard stamps
// onto each per-host LLM credential Secret (`secretMode:'new'`). This is the
// LABEL side of LLM-host identity — it fires for per-host-named Secrets that the
// name-only gate would miss.
export function hasHostSecretLabel(labels: Record<string, string> | undefined | null): boolean {
  if (!labels) return false
  return labels[config.hostSecretLabelKey] === config.hostSecretLabelValue
}

// An LLM host Secret is identified by EITHER the host-secret LABEL (per-host
// labeled Secrets minted by the wizard) OR a NAME in LLM_SECRET_NAMES (the
// shared `chatllm-api-keys` Secret WRC still uses). The union is deliberate:
// `chatllm-api-keys` stays slot-validated for WRC, and every per-host labeled
// Secret is slot-validated too — a per-host NAME can no longer bypass the gate.
export function isLlmHostSecret(input: {
  name?: unknown
  labels?: Record<string, string> | null
}): boolean {
  return isLlmSecretName(input.name) || hasHostSecretLabel(input.labels)
}
