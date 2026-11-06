/**
 * Endpoint profiles of the OpenAI driver family: official OpenAI, Azure OpenAI
 * and the data-driven OpenAI-compatible third parties. Pure factories; the only
 * side effect is the fail-closed validation of Azure's endpoint.
 */
import OpenAI from 'openai'
import { LlmErrorCode } from '../../core/errors'
import { resolveOfficialVisualDeliveryLimits } from '../../visualInput/deliveryLimits'
import { type ProviderEnvLookup, processEnvLookup } from '../providerEnv'
import type { LlmProvider } from '../registryCore'
import type { ClassifiedError } from '../types'
import type { EndpointProfile, OptionPolicy } from './endpointProfile'
import { azureParamPolicy, compatibleParamPolicy, officialParamPolicy } from './modelParamPolicy'

/**
 * Official OpenAI historically accepted any non-string as a ready client, while
 * Azure and the compatibles always built their own; a missing credential must
 * keep failing at construction there (the SDK throws on an absent key).
 */
function officialClient(keyOrClient: string | OpenAI): OpenAI {
  return typeof keyOrClient === 'string' ? new OpenAI({ apiKey: keyOrClient }) : keyOrClient
}

function ownClient(keyOrClient: string | OpenAI, build: (apiKey: string) => OpenAI): OpenAI {
  return typeof keyOrClient === 'object' && keyOrClient !== null ? keyOrClient : build(keyOrClient)
}

export function officialOpenAIProfile(): EndpointProfile {
  return {
    id: 'openai',
    protocol: 'openai-responses',
    createClient: officialClient,
    options: null,
    reasoningContent: false,
    classify: null,
    visualLimits: (baseURL, operation) =>
      resolveOfficialVisualDeliveryLimits('openai', baseURL, operation),
    params: officialParamPolicy,
  }
}

/**
 * Azure OpenAI speaks the OpenAI chat/completions shape, but its base URL is
 * per resource (non-secret env `AZURE_OPENAI_ENDPOINT`), it authenticates with
 * an `api-key` header instead of `Authorization: Bearer`, and the model string
 * is the deployment name. It targets Azure's v1 GA surface
 * (`<endpoint>/openai/v1/`), which a vanilla OpenAI client speaks directly.
 *
 * Throws when the endpoint is unusable so `createLLMProvider` returns null and
 * the failover/degraded path takes over, instead of reaching a wrong host.
 */
export function azureProfile(env: ProviderEnvLookup = processEnvLookup): EndpointProfile {
  const endpoint = env('AZURE_OPENAI_ENDPOINT')?.trim()
  if (!endpoint) {
    throw new Error('[Azure] AZURE_OPENAI_ENDPOINT is required (per-resource host) but was not set')
  }
  // The api-key travels in a header, so an `http://` typo would leak it in
  // cleartext. The host is deliberately not allowlisted: sovereign clouds use
  // .azure.us / .azure.cn and operators may front a custom domain.
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`[Azure] AZURE_OPENAI_ENDPOINT is not a valid URL: '${endpoint}'`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `[Azure] AZURE_OPENAI_ENDPOINT must be https (got '${parsed.protocol}') — refusing to send the api-key over a non-TLS transport`
    )
  }
  const baseURL = `${endpoint.replace(/\/+$/, '')}/openai/v1/`
  // Only the classic (non-v1) surface needs `api-version`; threading it as a
  // default query keeps a switch back to that surface working and is harmless on v1.
  const apiVersion = env('AZURE_OPENAI_API_VERSION')?.trim()
  return {
    id: 'azure',
    protocol: 'openai-chat',
    createClient: keyOrClient =>
      ownClient(
        keyOrClient,
        apiKey =>
          new OpenAI({
            apiKey,
            baseURL,
            defaultQuery: apiVersion ? { 'api-version': apiVersion } : undefined,
            defaultHeaders: {
              'api-key': apiKey,
              // A null value deletes the SDK's default Bearer header.
              Authorization: null,
            },
          })
      ),
    options: null,
    reasoningContent: false,
    classify: null,
    visualLimits: (baseURL, operation) =>
      resolveOfficialVisualDeliveryLimits('openai', baseURL, operation),
    params: azureParamPolicy,
  }
}

/** z.ai numeric codes and Bailian slugs for a retired or inaccessible model. */
const MODEL_NOT_AVAILABLE_CODES = new Set(['1211', '1220', 'ModelNotFound', 'Model.AccessDenied'])

/** z.ai 1113 and Bailian Arrearage: billing/quota. */
const BILLING_CODES = new Set(['1113', 'Arrearage'])

/**
 * Several third parties encode model availability and billing in a native
 * `error.code` that the HTTP status hides (billing can arrive inside a 429,
 * which would otherwise be retried as a rate limit). Unmatched codes return
 * null and fall through to the shared HTTP classification.
 */
function classifyNativeProviderCode(err: unknown): ClassifiedError | null {
  const rawCode =
    (err as { error?: { code?: unknown }; code?: unknown })?.error?.code ??
    (err as { code?: unknown })?.code
  const providerCode = rawCode == null ? undefined : String(rawCode)
  if (!providerCode) return null
  const mapped = MODEL_NOT_AVAILABLE_CODES.has(providerCode)
    ? LlmErrorCode.ModelNotAvailable
    : BILLING_CODES.has(providerCode)
      ? LlmErrorCode.InsufficientQuota
      : null
  if (!mapped) return null
  const message =
    (err as { error?: { message?: string }; message?: string })?.error?.message ??
    (err as { message?: string })?.message ??
    'Unknown LLM error'
  const httpStatus =
    typeof (err as { status?: unknown })?.status === 'number'
      ? (err as { status: number }).status
      : undefined
  return { code: mapped, retryable: false, message, httpStatus, providerCode }
}

/**
 * Third-party OpenAI-compatible endpoint built from a registry descriptor.
 *
 * The chat protocol already sends only the portable core (model, messages,
 * tools, tool_choice, max_tokens, temperature), so nothing stricter third
 * parties reject is ever emitted. Two options are still normalized:
 *   - temperature is clamped to the endpoint's real ceiling (Moonshot accepts
 *     [0,1], the rest [0,2]) so valid values are never degraded elsewhere;
 *   - only Moonshot rejects `tool_choice: 'required'`, so only Moonshot gets
 *     it downgraded to 'auto'; elsewhere a forced tool call stays forced.
 * Compatibility and a configured URL do not establish an official visual
 * delivery contract, so visual limits are always null.
 */
export function compatibleProfile(cfg: { id: string; baseURL: string }): EndpointProfile {
  return {
    // Descriptor ids are typed `string`; construction only happens from
    // registry descriptors, so they are always provider ids.
    id: cfg.id as LlmProvider,
    protocol: 'openai-chat',
    createClient: keyOrClient =>
      ownClient(keyOrClient, apiKey => new OpenAI({ apiKey, baseURL: cfg.baseURL })),
    options: {
      temperatureCeiling: cfg.id === 'moonshot' ? 1 : 2,
      downgradeRequiredToolChoice: cfg.id === 'moonshot',
    },
    // ZAI requires its reasoning to stay on assistant tool-call messages across a tool turn.
    reasoningContent: cfg.id === 'zai',
    classify: classifyNativeProviderCode,
    visualLimits: () => null,
    params: compatibleParamPolicy,
  }
}

/** Returns a copy; every other option (max_tokens, signal, …) is preserved. */
export function applyOptionPolicy<T extends { temperature?: number; tool_choice?: string }>(
  options: T | undefined,
  policy: OptionPolicy | null
): T | undefined {
  if (!options || !policy) return options
  const next = { ...options }
  if (typeof next.temperature === 'number') {
    next.temperature = Math.min(policy.temperatureCeiling, Math.max(0, next.temperature))
  }
  if (policy.downgradeRequiredToolChoice && next.tool_choice === 'required') {
    next.tool_choice = 'auto'
  }
  return next
}
