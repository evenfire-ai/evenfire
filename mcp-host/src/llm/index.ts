/**
 * LLM Provider factory.
 */
import { ApiKeys, ModelConfig } from '../types'
import { ClaudeProvider } from './claude'
import { OpenAIProvider } from './openai'
import { makeProvider } from './registry'
import { isLlmProvider } from './registryCore'
// Re-export the transport interfaces (moved to ./types to break the registry
// import cycle) so existing `import { SingleTurnProvider, ClassifiedError }
// from '../llm'` sites keep working unchanged.
import type { ClassifiedError, SingleTurnProvider } from './types'

export type { ClassifiedError, SingleTurnProvider } from './types'

/**
 * Create an LLM provider based on configuration.
 */
export function createLLMProvider(
  keys: ApiKeys,
  modelConfig?: ModelConfig
): SingleTurnProvider | null {
  const provider = modelConfig?.provider || 'openai'
  const modelName = modelConfig?.name

  if (!isLlmProvider(provider)) {
    console.error(`[LLM] Unknown provider: ${provider}`)
    return null
  }

  // Fail-safe (§5.7): a missing/empty key → console.error + return null BEFORE
  // calling make(). Deferring to make() would surface as an opaque 401 later.
  // The provider id IS the ApiKeys record key.
  const apiKey = keys[provider]
  if (!apiKey) {
    console.error(`[LLM] ${provider} API key not found in secrets`)
    return null
  }

  return makeProvider(provider, apiKey, modelName)
}

export { OpenAIProvider, ClaudeProvider }
