import type { ReactNode } from 'react'
import type { HostAllowedModel, LlmModelCatalogEntry, LlmPolicy, LlmProvider } from '@/lib/llm'

// Write-only credential wiring. Values are NEVER read back from the server; the
// draft holds only what the operator typed this session. `existingKeys` lights
// the present/absent chips in edit mode without exposing any value, and a blank
// field means "leave the stored key unchanged" (merge PUT on save).
export type LlmCredentialWiring = {
  draft: Record<string, string>
  onChange: (dataKey: string, value: string) => void
  // Keys already stored in the Host's Secret (edit mode). Create omits it.
  existingKeys?: string[]
}

export type LlmProviderConfigProps = {
  // PRIMARY model (spec.model). Always required.
  provider: LlmProvider
  model: string
  onPrimaryChange: (next: { provider: LlmProvider; model: string }) => void

  // Fallback policy (spec.llmPolicy). `undefined` = the Host has no fallback.
  policy: LlmPolicy | undefined
  onPolicyChange: (next: LlmPolicy | undefined) => void

  // Per-host model allowlist subset (spec.allowedModels, Topic 3a). The flat
  // (provider, model) pairs = WHICH models this host offers its end users. Empty
  // = unrestricted (offer the full global allowlist per provider). Controlled by
  // the parent, which assembles/omits it in the Host spec.
  allowedModels: HostAllowedModel[]
  onAllowedModelsChange: (next: HostAllowedModel[]) => void

  // Operator model allowlist (enabled + disabled rows); pickers show the enabled
  // subset per provider.
  catalog: LlmModelCatalogEntry[]
  catalogLoading?: boolean
  catalogError?: string

  // Copy and model-restriction controls vary by surface. The agent creation
  // flow selects one default model without exposing per-host restrictions,
  // while the edit surface retains the full allowed-models editor.
  modelLabel?: string
  showAllowedModels?: boolean
  // Existing-agent layout: preserve the saved default model internally and
  // put the primary provider's Allowed models control in the model field's
  // place. Provider changes still resolve a valid default model automatically.
  replacePrimaryModelWithAllowedModels?: boolean

  // Credential editing. Omit to render the model + fallback structure WITHOUT
  // credential inputs (create flow reusing an existing shared Secret, where the
  // wizard cannot introspect the Secret's keys).
  credentials?: LlmCredentialWiring

  // Data keys already present in the Host's own Secret — feeds the fallback
  // credentialSlot dropdown's extra keys (e.g. `claude-api-key-fb1`).
  secretKeys?: string[]

  // Creation keeps the optional fallback configuration out of the way until an
  // operator explicitly opens it. Existing-agent editing stays expanded.
  fallbackProvidersInitiallyCollapsed?: boolean

  disabled?: boolean

  /** When true, OpenAI offers API key vs ChatGPT subscription. Runtime id stays separate. */
  subscriptionCredentialEnabled?: boolean
  /** Rendered after the OpenAI credential radios (grant picker). */
  afterPrimaryProvider?: ReactNode
}
