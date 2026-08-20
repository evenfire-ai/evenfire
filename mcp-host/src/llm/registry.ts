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
import type { ProviderCredentials } from '../types'
import { AzureOpenAIProvider } from './azure'
import { ClaudeProvider } from './claude'
import { buildBedrockConverseDriver } from './drivers/bedrockConverse'
import { buildGoogleGenerativeDriver } from './drivers/googleGenerative'
import { OpenAIProvider } from './openai'
import { OpenAICompatibleProvider } from './openaiCompatible'
import { type LlmProvider, descriptorFor, primarySlot } from './registryCore'
import type { SingleTurnProvider } from './types'

export {
  ALL_PROVIDERS,
  type CoreProviderDescriptor,
  type CredentialSlot,
  descriptorFor,
  isLlmProvider,
  type LlmProvider,
  primarySlot,
  PROVIDERS,
} from './registryCore'

/**
 * Construct the concrete provider for `provider` from its credential bag (+
 * optional model). Direct-SDK providers (openai, claude), the own-SDK newcomers
 * (vertex, bedrock) and the light-driver `azure` (OpenAI shape but per-resource
 * host + `api-key` header) get their own explicit case; every other
 * OpenAI-compatible provider is data-driven — discriminated by the presence of
 * `descriptor.baseURL`, so adding one is a pure data entry in `PROVIDERS`.
 *
 * The own-SDK arms (vertex/bedrock) `require()` their SDK LAZILY inside the case
 * (mcp-host is CommonJS): the heavy GCP/AWS clients are loaded and parsed only
 * when that provider is actually used, isolating dependency faults and keeping
 * boot/memory of the common path unchanged. NEVER route them through the
 * `baseURL`/OpenAI-compatible arm.
 *
 * `credentials` is keyed by registry slot `dataKey`. Single-key arms read the
 * primary slot via {@link primarySlot} (confined here — the exclusion boundary
 * uses the full slot set instead).
 */
export function makeProvider(
  provider: LlmProvider,
  credentials: ProviderCredentials,
  model?: string
): SingleTurnProvider {
  const d = descriptorFor(provider)
  switch (provider) {
    case 'openai':
      return new OpenAIProvider(credentials[primarySlot(d).dataKey], model)
    case 'claude':
      return new ClaudeProvider(credentials[primarySlot(d).dataKey], model)
    case 'vertex':
      // Own-SDK arm — lazy require lives inside the driver builder.
      return buildGoogleGenerativeDriver(credentials, model ?? d.defaultModel)
    case 'bedrock':
      // Own-SDK arm — lazy require lives inside the driver builder.
      return buildBedrockConverseDriver(credentials, model ?? d.defaultModel)
    case 'azure':
      // Light-driver arm: OpenAI wire shape but per-resource host
      // (AZURE_OPENAI_ENDPOINT) + `api-key` header + deployment-name-as-model, so
      // it deliberately has NO static baseURL and must not hit the data arm
      // below. Fails closed (throws) if the operator omitted the endpoint.
      return new AzureOpenAIProvider(credentials[primarySlot(d).dataKey], model ?? d.defaultModel)
    case 'codex-subscription':
      throw new Error(
        '[LLM] makeProvider: codex-subscription requires an explicit model and runtime authorizer/proxy dependencies'
      )
  }

  // Data-driven arm: anything carrying a baseURL is OpenAI-compatible and is
  // built straight from its descriptor — no per-id branch. A new divergent
  // (own-SDK) provider must instead add its own case above.
  if (d.baseURL) {
    if (!d.defaultModel) {
      throw new Error(`[LLM] makeProvider: provider '${d.id}' requires a defaultModel`)
    }
    return new OpenAICompatibleProvider(
      { id: d.id, baseURL: d.baseURL, defaultModel: d.defaultModel },
      credentials[primarySlot(d).dataKey],
      model
    )
  }
  throw new Error(`[LLM] makeProvider: no factory registered for provider '${String(provider)}'`)
}
