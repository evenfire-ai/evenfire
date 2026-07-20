// Cross-check between the model allowlist and LLM prices (spec R3.3): flag
// allowed models that have no enabled price so cost budgets don't silently
// under-count. Shared by the /llm-models list page and LlmModelTable.
import type { LlmAllowedModel, UnpricedModel } from './api'

/**
 * Index the unpriced feed for row lookup. Keys are stored both as
 * `provider/model` and bare `model`: the feed reports `provider: null` when a
 * budget scope pins a model without a provider, so the bare key lets the table
 * still flag the allowed row by model name.
 */
export function buildUnpricedKeys(unpriced: UnpricedModel[]): Set<string> {
  const keys = new Set<string>()
  for (const model of unpriced) {
    if (model.provider) keys.add(`${model.provider}/${model.model}`)
    keys.add(model.model)
  }
  return keys
}

/**
 * True when an allowlist row should render the "No price" warning. Only
 * enabled models count — a disabled model can't be selected, so it can't
 * incur unpriced cost.
 */
export function isUnpricedAllowedModel(
  model: Pick<LlmAllowedModel, 'provider' | 'model' | 'enabled'>,
  unpricedKeys: Set<string>
): boolean {
  if (!model.enabled) return false
  return unpricedKeys.has(`${model.provider}/${model.model}`) || unpricedKeys.has(model.model)
}
