/**
 * LLM provider FACTORY layer.
 *
 * The provider descriptor DATA, the `LlmProvider` union, and the lightweight
 * guards live in `./registryCore` (a data-only leaf with no provider-class /
 * tokenizer / prom-client imports). This module is the thin factory on top: it
 * imports the concrete provider classes and constructs them from a core
 * descriptor.
 *
 * Only call sites that actually CONSTRUCT a provider should import from here
 * (e.g. `createLLMProvider`). Plumbing consumers that need data/guards only
 * (config, k8sClient, tokenizer dispatch, …) must import from `./registryCore`
 * so their import graph never reaches the provider classes.
 *
 * The core data/types/guards are re-exported here so existing importers of
 * `./registry` keep working, but `registryCore` remains the single source of
 * truth for the data.
 */
import { ClaudeProvider } from './claude'
import { OpenAIProvider } from './openai'
import { OpenAICompatibleProvider } from './openaiCompatible'
import { type LlmProvider, descriptorFor } from './registryCore'
import type { SingleTurnProvider } from './types'

export {
  ALL_PROVIDERS,
  type CoreProviderDescriptor,
  descriptorFor,
  isLlmProvider,
  type LlmProvider,
  PROVIDERS,
} from './registryCore'

/**
 * Construct the concrete provider for `provider` from an apiKey (+ optional
 * model). Direct-SDK providers (e.g. openai, claude) get their own class via an
 * explicit case below; every OpenAI-compatible provider is data-driven —
 * discriminated by the presence of `descriptor.baseURL`, so adding one is a pure
 * data entry in `PROVIDERS` with no edit here.
 */
export function makeProvider(
  provider: LlmProvider,
  apiKey: string,
  model?: string
): SingleTurnProvider {
  // Only direct-SDK providers need an explicit case; OpenAI-compatible ones
  // (with a baseURL) fall through to the data-driven arm below.
  switch (provider) {
    case 'openai':
      return new OpenAIProvider(apiKey, model)
    case 'claude':
      return new ClaudeProvider(apiKey, model)
  }

  // Data-driven arm: anything carrying a baseURL is OpenAI-compatible and is
  // built straight from its descriptor — no per-id branch. A new divergent
  // (own-SDK) provider must instead add its own case above.
  const d = descriptorFor(provider)
  if (d.baseURL) {
    return new OpenAICompatibleProvider(
      { id: d.id, baseURL: d.baseURL, defaultModel: d.defaultModel },
      apiKey,
      model
    )
  }
  throw new Error(`[LLM] makeProvider: no factory registered for provider '${String(provider)}'`)
}
