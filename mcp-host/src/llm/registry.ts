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
import { ClaudeProvider } from './claude'
import { type CodexSubscriptionDeps, CodexSubscriptionProvider } from './codexSubscription'
import { buildBedrockConverseDriver } from './drivers/bedrockConverse'
import { buildGoogleGenerativeDriver } from './drivers/googleGenerative'
import { type GrokSubscriptionDeps, GrokSubscriptionProvider } from './grokSubscription'
import { OpenAIProvider } from './openai'
import { azureProfile, compatibleProfile } from './openaiFamily/endpointProfiles'
import { type ProviderEnvLookup, processEnvLookup } from './providerEnv'
import { type LlmProvider, descriptorFor, primarySlot } from './registryCore'
import type { SingleTurnProvider } from './types'

export type MakeProviderOptions = {
  codex?: CodexSubscriptionDeps
  grok?: GrokSubscriptionDeps
  /**
   * Source for the provider's declared non-secret env (AWS_REGION, Vertex
   * project/location, Azure endpoint/api-version). Defaults to process.env; a
   * Host pod passes the per-Host env from ConfigStore (see ./providerEnv).
   */
  env?: ProviderEnvLookup
}

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

// Subscription provider switch, read when the provider is built (not at boot,
// so one bad value in the shared Host ConfigMap does not stop every Host).
// Unset, empty and `true` mean on; `false` means off; any other value refuses
// to build the provider.
export type SubscriptionSwitchName =
  | 'MCP_HOST_CODEX_SUBSCRIPTION_ENABLED'
  | 'MCP_HOST_GROK_SUBSCRIPTION_ENABLED'
export type SubscriptionSwitchRefusal = 'subscription_switch_invalid' | 'subscription_switch_off'

/** A subscription switch refused construction. `reason` and `envVar` are fixed strings, safe to log. */
export class SubscriptionSwitchError extends Error {
  constructor(
    message: string,
    readonly reason: SubscriptionSwitchRefusal,
    readonly envVar: SubscriptionSwitchName
  ) {
    super(message)
    this.name = 'SubscriptionSwitchError'
  }
}

function subscriptionSwitchOn(name: SubscriptionSwitchName): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '' || raw === 'true') return true
  if (raw === 'false') return false
  throw new SubscriptionSwitchError(
    `[LLM] makeProvider: ${name} must be 'true' or 'false'`,
    'subscription_switch_invalid',
    name
  )
}

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
  model?: string,
  options?: MakeProviderOptions
): SingleTurnProvider {
  const d = descriptorFor(provider)
  const env = options?.env ?? processEnvLookup
  switch (provider) {
    case 'openai':
      return new OpenAIProvider(credentials[primarySlot(d).dataKey], model)
    case 'claude':
      return new ClaudeProvider(credentials[primarySlot(d).dataKey], model)
    case 'vertex':
      // Own-SDK arm — lazy require lives inside the driver builder.
      return buildGoogleGenerativeDriver(credentials, model ?? d.defaultModel ?? '', env)
    case 'bedrock':
      // Own-SDK arm — lazy require lives inside the driver builder.
      return buildBedrockConverseDriver(credentials, model ?? d.defaultModel ?? '', env)
    case 'azure':
      // Light-driver arm: OpenAI wire shape but per-resource host
      // (AZURE_OPENAI_ENDPOINT) + `api-key` header + deployment-name-as-model, so
      // it deliberately has NO static baseURL and must not hit the data arm
      // below. Fails closed (throws) if the operator omitted the endpoint.
      return new OpenAIProvider(
        credentials[primarySlot(d).dataKey],
        model ?? d.defaultModel ?? '',
        azureProfile(env)
      )
    case 'codex-subscription':
      if (!subscriptionSwitchOn('MCP_HOST_CODEX_SUBSCRIPTION_ENABLED')) {
        throw new SubscriptionSwitchError(
          '[LLM] makeProvider: codex-subscription is disabled',
          'subscription_switch_off',
          'MCP_HOST_CODEX_SUBSCRIPTION_ENABLED'
        )
      }
      if (!model?.trim() || !options?.codex) {
        throw new Error(
          '[LLM] makeProvider: codex-subscription requires an explicit model and runtime authorizer/proxy dependencies'
        )
      }
      return new CodexSubscriptionProvider(model, options.codex)
    case 'grok-subscription':
      if (!subscriptionSwitchOn('MCP_HOST_GROK_SUBSCRIPTION_ENABLED')) {
        throw new SubscriptionSwitchError(
          '[LLM] makeProvider: grok-subscription is disabled',
          'subscription_switch_off',
          'MCP_HOST_GROK_SUBSCRIPTION_ENABLED'
        )
      }
      if (!model?.trim() || !options?.grok) {
        throw new Error(
          '[LLM] makeProvider: grok-subscription requires an explicit model and runtime authorizer/proxy dependencies'
        )
      }
      return new GrokSubscriptionProvider(model, options.grok)
  }

  // Data-driven arm: anything carrying a baseURL is OpenAI-compatible and is
  // built straight from its descriptor — no per-id branch. A new divergent
  // (own-SDK) provider must instead add its own case above.
  if (d.baseURL) {
    if (!d.defaultModel) {
      throw new Error(`[LLM] makeProvider: provider '${d.id}' requires a defaultModel`)
    }
    return new OpenAIProvider(
      credentials[primarySlot(d).dataKey],
      model ?? d.defaultModel,
      compatibleProfile({ id: d.id, baseURL: d.baseURL })
    )
  }
  throw new Error(`[LLM] makeProvider: no factory registered for provider '${String(provider)}'`)
}
