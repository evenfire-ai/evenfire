import type { HostAllowedModel, LlmModelCatalogEntry, LlmPolicy, LlmProvider } from '@/lib/llm'

export type LlmPolicyEditorProps = {
  // The current policy, or undefined when the Host has no fallback configured.
  value: LlmPolicy | undefined
  // Emits the next policy, or undefined when the last fallback is removed (the
  // parent then drops `spec.llmPolicy` on save — a Host with no policy behaves
  // exactly as today, spec R5).
  onChange: (next: LlmPolicy | undefined) => void
  // Operator model allowlist (enabled + disabled rows); model dropdowns show the
  // enabled subset per provider. Reused from `useLlmAllowedModels` (R3).
  catalog: LlmModelCatalogEntry[]
  // Per-host model allowlist subset (spec.allowedModels, Topic 3a). When a
  // fallback's provider is restricted, its model dropdown is constrained to that
  // subset. Empty/omitted = unrestricted (the full enabled allowlist per
  // provider), so the editor behaves exactly as before.
  allowedModels?: HostAllowedModel[]
  // Data keys already present in the Host's LLM Secret — feeds the extra
  // `credentialSlot` options (e.g. `claude-api-key-fb1`) alongside the registry
  // slots (spec R4.5.6). Optional; registry slots always show without it.
  secretKeys?: string[]
  // The Host's own provider — a freshly added fallback pre-selects it.
  defaultProvider: LlmProvider
  disabled?: boolean
}
