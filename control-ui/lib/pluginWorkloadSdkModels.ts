import { type LlmProvider, getModelOptions } from './llm'

export type CustomPluginWorkloadSdkModelValidation =
  | { ok: true; model: string }
  | { ok: false; reason: 'empty' | 'wildcard' | 'duplicate' }

export function buildPluginWorkloadSdkModelOptions(
  provider: LlmProvider,
  selectedModels: string[]
): string[] {
  const knownModels = getModelOptions(provider)
  const seen = new Set(knownModels)
  const customModels = selectedModels.filter(model => {
    if (!model || seen.has(model)) return false
    seen.add(model)
    return true
  })
  return [...knownModels, ...customModels]
}

export function validateCustomPluginWorkloadSdkModel(
  input: string,
  selectedModels: string[]
): CustomPluginWorkloadSdkModelValidation {
  const model = input.trim()
  if (!model) return { ok: false, reason: 'empty' }
  if (model.includes('*')) return { ok: false, reason: 'wildcard' }
  if (selectedModels.includes(model)) return { ok: false, reason: 'duplicate' }
  return { ok: true, model }
}

export function appendCustomPluginWorkloadSdkModel(
  selectedModels: string[],
  input: string
): string[] {
  const validation = validateCustomPluginWorkloadSdkModel(input, selectedModels)
  return validation.ok ? [...selectedModels, validation.model] : selectedModels
}

export function getCustomPluginWorkloadSdkModelError(
  input: string,
  selectedModels: string[]
): string {
  const validation = validateCustomPluginWorkloadSdkModel(input, selectedModels)
  if (!('reason' in validation)) return ''
  if (validation.reason === 'empty') return ''
  if (validation.reason === 'wildcard') return 'Model names cannot contain wildcards.'
  return 'That model is already selected.'
}
