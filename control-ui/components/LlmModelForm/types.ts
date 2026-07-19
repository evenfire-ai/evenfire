import type { CreateLlmModelInput, LlmAllowedModel } from '@lib/api'

export type LlmModelFormProps = {
  mode: 'create' | 'edit'
  initial?: LlmAllowedModel | null
  prefill?: { provider?: string; model?: string }
  saving: boolean
  error?: string
  onSubmit: (input: CreateLlmModelInput) => void
  onCancel: () => void
}
