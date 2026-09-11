/**
 * LLM Provider factory.
 */
import { PRIMARY_SLOT_ID, brokerInternalUrl } from '@clerum/egress-policy'
import { config } from '../config'
import { ApiKeys, ModelConfig } from '../types'
import { ClaudeProvider } from './claude'
import { CodexLlmProxyClient, resolveCodexProxyRuntimeUrl } from './codexLlmProxyClient'
import { readCodexPlatformJwt, refreshCodexPlatformJwt } from './codexPlatformJwt'
import { readLiveCodexPolicyBinding, resolveCodexAttemptPolicy } from './codexPolicyBinding'
import type { CodexAttemptContext } from './codexSubscription'
import { OpenAIProvider } from './openai'
import { ProviderAttemptAuthorizer, resolveCodexAuthorizeUrl } from './providerAttemptAuthorizer'
import { type MakeProviderOptions, makeProvider } from './registry'
import { ALL_PROVIDERS, type LlmProvider, descriptorFor, isLlmProvider } from './registryCore'
// Re-export the transport interfaces (moved to ./types to break the registry
// import cycle) so existing `import { SingleTurnProvider, ClassifiedError }
// from '../llm'` sites keep working unchanged.
import type { ClassifiedError, SingleTurnProvider } from './types'

export type { ClassifiedError, SingleTurnProvider } from './types'

const DEFAULT_CODEX_AUTHORIZE_GATEWAY =
  'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092'

function createCodexRuntimeDeps(captured?: CodexAttemptContext) {
  const gateway = (config.mcpHostGatewayUrl ?? '').trim() || DEFAULT_CODEX_AUTHORIZE_GATEWAY
  return {
    authorizer: new ProviderAttemptAuthorizer({
      authorizeUrl: resolveCodexAuthorizeUrl(gateway),
      readPlatformJwt: readCodexPlatformJwt,
      refreshOnUnauthorized: refreshCodexPlatformJwt,
    }),
    proxy: new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(config.codexProxyRuntimeBaseUrl),
      readPlatformJwt: readCodexPlatformJwt,
      refreshOnUnauthorized: refreshCodexPlatformJwt,
    }),
    attemptContext: ({ model }: { model: string }): CodexAttemptContext => {
      if (captured) return captured
      const resolved = resolveCodexAttemptPolicy({
        model,
        envRevision: config.codexPolicyRevision,
        envHash: config.codexPolicyHash,
        binding: readLiveCodexPolicyBinding(),
      })
      if (!resolved) {
        return { policyRevision: 0, policyHash: '' }
      }
      return {
        ...resolved,
        hostRef: config.hostName,
      }
    },
  }
}

export type CreateLlmProviderOptions = {
  capturedCodexAttemptContext?: CodexAttemptContext
  /**
   * slotId used to derive the `openai-compatible` egress-broker URL: 'primary'
   * for the Host primary model (default), or `fallback-<rawIndex>` for a fallback
   * entry. MUST match the slotId HCC hashed into the broker name, so a fallback
   * passes the entry's RAW `spec.llmPolicy.fallbacks` index. Ignored for every
   * other provider.
   */
  openaiCompatibleSlotId?: string
}

/**
 * The complete in-cluster egress-broker URL a local `openai-compatible` provider
 * dials, derived with the SHARED helper so it is byte-identical to the Service
 * HCC provisioned (no handshake). mcp-host never dials the LAN endpoint: it uses
 * `lanBaseURL` only to extract the pathname the broker's nginx serves. Returns
 * null (→ fail-closed, no provider) when the Host name is missing or the LAN
 * baseURL is unparseable — NEVER a public default.
 */
function deriveOpenAiCompatibleBrokerURL(
  slotId: string,
  lanBaseURL: string | undefined
): string | null {
  const hostName = config.hostName?.trim()
  if (!hostName) return null
  if (!lanBaseURL) return null
  let pathname: string
  try {
    pathname = new URL(lanBaseURL).pathname || '/'
  } catch {
    return null
  }
  return brokerInternalUrl(hostName, slotId, {
    namespace: config.llmEgressNamespace,
    port: config.brokerPort,
    pathname,
  })
}

/**
 * Create an LLM provider based on configuration.
 */
export function createLLMProvider(
  keys: ApiKeys,
  modelConfig?: ModelConfig,
  options?: CreateLlmProviderOptions
): SingleTurnProvider | null {
  // Canonicalize with .trim() like control-api's admission gate and HCC's broker
  // matcher, so a padded value (e.g. 'openai-compatible ') resolves to the same
  // provider on every side of the seam instead of falling through to a null
  // provider here while HCC provisioned a broker for the trimmed form.
  const provider = (modelConfig?.provider || 'openai').trim()
  const modelName = modelConfig?.name

  if (!isLlmProvider(provider)) {
    console.error('[LLM] Unknown provider')
    return null
  }

  // Fail-safe (§5.7): a missing/empty REQUIRED slot → console.error + return
  // null BEFORE calling make(). Deferring to make() would surface as an opaque
  // 401 later. Multi-slot (R4): every required slot must be present, so Bedrock
  // never constructs half-credentialed. The provider id IS the ApiKeys key.
  const credentials = keys[provider] ?? {}
  for (const slot of descriptorFor(provider).credentialSlots) {
    if (slot.required && !credentials[slot.dataKey]) {
      console.error('[LLM] required credential missing from secrets')
      return null
    }
  }

  // The own-SDK arms (vertex/bedrock) can still throw at construction if their
  // non-secret pod env (Vertex project id, AWS region) is absent or the Vertex
  // service-account JSON is malformed. Treat that as the same fail-safe: log +
  // return null (→ degraded), never crash the process. The four original arms
  // never throw here (their empty-key case is already handled above), so their
  // behaviour is byte-identical.
  // openai-compatible has no static endpoint: derive the per-Host egress-broker
  // URL BEFORE construction so a failure to derive fails closed (return null →
  // degraded) rather than surfacing later. Never falls back to a public default.
  let makeOptions: MakeProviderOptions | undefined
  if (provider === 'codex-subscription') {
    makeOptions = { codex: createCodexRuntimeDeps(options?.capturedCodexAttemptContext) }
  } else if (provider === 'openai-compatible') {
    const slotId = options?.openaiCompatibleSlotId ?? PRIMARY_SLOT_ID
    const brokerBaseURL = deriveOpenAiCompatibleBrokerURL(slotId, modelConfig?.baseURL)
    if (!brokerBaseURL) {
      console.error(
        '[LLM] openai-compatible: cannot derive egress-broker URL (missing host name or invalid baseURL) — not constructing'
      )
      return null
    }
    makeOptions = { openaiCompatible: { brokerBaseURL } }
  }

  try {
    return makeProvider(provider, credentials, modelName, makeOptions)
  } catch (err) {
    console.error('[LLM] failed to construct provider')
    return null
  }
}

/**
 * Providers excluded from env-key autodetection (dev mode + Plugin Workload SDK
 * env mode). `openai-compatible` declares an OPTIONAL `OPENAI_COMPATIBLE_API_KEY`
 * slot, so a bare `authMode === 'static-credentials'` scan would auto-select it
 * whenever that env var happens to be set — but it has no static endpoint (its
 * baseURL is the per-Host egress broker, which does not exist in dev auto-mode)
 * and no default model, so an auto-selection could only fail. Exclude it
 * EXPLICITLY rather than relying on the absence of a defaultModel.
 */
export const ENV_AUTODETECT_EXCLUDED_PROVIDERS: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  'openai-compatible',
])

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
    if (ENV_AUTODETECT_EXCLUDED_PROVIDERS.has(p)) continue
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
