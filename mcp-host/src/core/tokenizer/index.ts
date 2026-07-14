/**
 * Tokenizer barrel — public surface for the rest of the codebase.
 *
 * `createTokenCounter(provider, model)` first asks the provider to build its
 * own counter via the optional `createTokenCounter` method (currently
 * implemented by `ClaudeProvider`, which shares its private SDK client with
 * the resulting `AnthropicTokenCounter`). Providers that don't implement that
 * method fall back to dispatch by their registry descriptor's `tokenizer` hint
 * (`'openai'` → OpenAITokenCounter, `'fallback'` → FallbackTokenCounter).
 *
 * The provider-first path means the SDK client never leaves `ClaudeProvider`;
 * key rotation that swaps the provider naturally brings a fresh counter too.
 */
import type { SingleTurnProvider } from '../../llm'
import { descriptorFor, isLlmProvider } from '../../llm/registryCore'
import { AnthropicTokenCounter, type AnthropicTokenCounterOptions } from './anthropicTokenCounter'
import { FallbackTokenCounter } from './fallbackTokenCounter'
import { OpenAITokenCounter } from './openaiTokenCounter'
import type { TokenCounter } from './tokenCounter'

export { heuristicCount } from './heuristic'
export {
  tokenizerCountDurationSeconds,
  tokenizerDryrunDelta,
  tokenizerDryrunTierMismatchTotal,
  tokenizerFallbackTotal,
} from './metrics'
export type { TokenizerFallbackReason } from './metrics'
export { AnthropicTokenCounter } from './anthropicTokenCounter'
export type { AnthropicTokenCounterOptions } from './anthropicTokenCounter'
export { FallbackTokenCounter } from './fallbackTokenCounter'
export { OpenAITokenCounter } from './openaiTokenCounter'
export type { TokenCounter, TokenCounterProvider } from './tokenCounter'

export interface CreateTokenCounterOptions {
  /** Skip Anthropic network calls (CI / air-gapped). */
  offline?: boolean
}

/**
 * Providers may optionally expose a `createTokenCounter(modelName, opts)`
 * method that returns the right `TokenCounter` for themselves. Doing so keeps
 * the provider's private state (SDK client, custom encoding) from leaking
 * across the module boundary. `ClaudeProvider` implements this so its
 * Anthropic client stays encapsulated; the OpenAI-compatible providers don't
 * need to because their counters don't need provider-private state.
 */
interface ProviderWithCounterFactory {
  createTokenCounter(modelName: string, options?: AnthropicTokenCounterOptions): TokenCounter
}

function hasProviderCounterFactory(
  p: SingleTurnProvider
): p is SingleTurnProvider & ProviderWithCounterFactory {
  return typeof (p as Partial<ProviderWithCounterFactory>).createTokenCounter === 'function'
}

export function createTokenCounter(
  provider: SingleTurnProvider,
  modelName: string,
  options: CreateTokenCounterOptions = {}
): TokenCounter {
  if (hasProviderCounterFactory(provider)) {
    return provider.createTokenCounter(modelName, { offline: options.offline })
  }
  // Fallback dispatch for providers that don't (yet) own their counter
  // construction. Stays here so adding a new provider doesn't force a
  // counter implementation upfront. The hint comes from the registry
  // descriptor's `tokenizer` field rather than a hardcoded switch.
  const type = provider.getProviderType()
  if (!isLlmProvider(type)) {
    // getProviderType() always returns a valid LlmProvider; this guard only
    // fires for a test stub or a future regression. Stay safe, never throw.
    console.warn(
      `[Tokenizer] provider reported unknown type '${type}'; falling back to FallbackTokenCounter`
    )
    // SECURITY: pass a literal 'unknown' (not the raw `type`) as the counter's
    // provider label. A non-registry type is unbounded user/stub-controlled
    // input; using it as a Prometheus label value would be unbounded-cardinality.
    // The raw type is still logged above for debuggability.
    return new FallbackTokenCounter('unknown', modelName)
  }
  const tokenizer = descriptorFor(type).tokenizer
  switch (tokenizer) {
    case 'openai':
      return new OpenAITokenCounter(modelName)
    case 'fallback':
      return new FallbackTokenCounter(type, modelName)
    case 'native':
      // 'native' providers (Claude) ship createTokenCounter() and are caught by
      // the capability check above. Reaching here means a native-typed provider
      // returned no factory (e.g. a test stub); fall back safely rather than
      // throw.
      console.warn(
        `[Tokenizer] native-tokenizer provider '${type}' without createTokenCounter(); falling back to FallbackTokenCounter`
      )
      return new FallbackTokenCounter(type, modelName)
    default: {
      const _exhaustive: never = tokenizer
      void _exhaustive
      return new FallbackTokenCounter(type, modelName)
    }
  }
}
