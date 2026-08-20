/**
 * LLM Provider factory.
 */
import { ApiKeys, ModelConfig } from '../types'
import { ClaudeProvider } from './claude'
import { OpenAIProvider } from './openai'
import { makeProvider } from './registry'
import { ALL_PROVIDERS, descriptorFor, isLlmProvider } from './registryCore'
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

  // Fail-safe (§5.7): a missing/empty REQUIRED slot → console.error + return
  // null BEFORE calling make(). Deferring to make() would surface as an opaque
  // 401 later. Multi-slot (R4): every required slot must be present, so Bedrock
  // never constructs half-credentialed. The provider id IS the ApiKeys key.
  const credentials = keys[provider] ?? {}
  for (const slot of descriptorFor(provider).credentialSlots) {
    if (slot.required && !credentials[slot.dataKey]) {
      console.error(`[LLM] ${provider} credential '${slot.dataKey}' not found in secrets`)
      return null
    }
  }

  // The own-SDK arms (vertex/bedrock) can still throw at construction if their
  // non-secret pod env (Vertex project id, AWS region) is absent or the Vertex
  // service-account JSON is malformed. Treat that as the same fail-safe: log +
  // return null (→ degraded), never crash the process. The four original arms
  // never throw here (their empty-key case is already handled above), so their
  // behaviour is byte-identical.
  try {
    return makeProvider(provider, credentials, modelName)
  } catch (err) {
    console.error(
      `[LLM] failed to construct ${provider}:`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * Build the `ApiKeys` bag from an env map (dev mode + Plugin Workload SDK env
 * mode). Registry-driven & multi-slot (R4): for each provider, read every
 * credential slot by its env var name; include the provider only when ALL its
 * required slots are present (e.g. Bedrock needs both AWS keys). `ALL_PROVIDERS`
 * order = dev auto-detection priority.
 */
export function apiKeysFromEnv(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  const keys: ApiKeys = {}
  for (const p of ALL_PROVIDERS) {
    if (descriptorFor(p).authMode !== 'static-credentials') continue
    const slots = descriptorFor(p).credentialSlots
    const bag: Record<string, string> = {}
    for (const slot of slots) {
      const value = env[slot.envName]
      if (value) bag[slot.dataKey] = value
    }
    const hasAllRequired = slots.every(slot => !slot.required || bag[slot.dataKey])
    if (hasAllRequired && Object.keys(bag).length > 0) keys[p] = bag
  }
  return keys
}

export { OpenAIProvider, ClaudeProvider }
