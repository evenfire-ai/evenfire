import type { CreateTokenBudgetInput, TokenBudget, UnpricedModel } from '@lib/api'

export type TokenBudgetFormProps = {
  mode: 'create' | 'edit'
  // Existing row (with live spend/unpriced) when editing; seeds the form.
  initial?: TokenBudget | null
  saving: boolean
  error?: string
  // Set when the server rejects the submit with 400 `unpriced_models`: the
  // pinned cost-budget models that need a price before the budget can be saved.
  unpricedModelsError?: UnpricedModel[] | null
  onSubmit: (input: CreateTokenBudgetInput) => void
  onCancel: () => void
}

export type ScopeOption = { value: string; label: string }

// A scope dimension the editor can add values for. `options: null` means the
// dimension is free-text (e.g. model name) with optional datalist suggestions.
export type ScopeDimensionConfig = {
  key: string
  label: string
  description?: string
  options: ScopeOption[] | null
  suggestions?: string[]
  placeholder?: string
}

export type ScopeSelectorProps = {
  dimensions: ScopeDimensionConfig[]
  // Current scope: dimension key → selected values.
  value: Record<string, string[]>
  onChange: (next: Record<string, string[]>) => void
  disabled?: boolean
  // Labels for already-selected values (e.g. team/user UUID → name).
  valueLabels?: Record<string, Record<string, string>>
}
