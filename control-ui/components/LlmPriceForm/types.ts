import type { BudgetRef, CreateLlmPriceInput, LlmModelPrice } from '@lib/api'

export type LlmPriceFormProps = {
  mode: 'create' | 'edit'
  // Existing row when editing; used to seed the form.
  initial?: LlmModelPrice | null
  // Prefill (provider, model) when creating from the unpriced surfacing.
  prefill?: { provider?: string; model?: string }
  saving: boolean
  error?: string
  // Set when the server rejects the save with 409 `price_in_use_by_budget`
  // (e.g. disabling/re-keying a price still pinned by a cost budget's scope).
  budgetsUsingPrice?: BudgetRef[] | null
  onSubmit: (input: CreateLlmPriceInput) => void
  onCancel: () => void
}

export type PriceFieldKey =
  | 'input_token_price'
  | 'output_token_price'
  | 'cache_read_token_price'
  | 'cache_write_token_price'
