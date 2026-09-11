/**
 * LLM provider registry — DATA-ONLY LEAF.
 *
 * This module holds the provider descriptor DATA, the `LlmProvider` union, and
 * the lightweight guards/lookups (`ALL_PROVIDERS`, `isLlmProvider`,
 * `descriptorFor`). It deliberately imports NOTHING that reaches the provider
 * classes or the tokenizer/prom-client tree.
 *
 * Rationale: `config.ts` (imported extremely early and almost everywhere) only
 * needs the descriptor DATA + guards. Routing those plumbing consumers through
 * this leaf keeps prom-client (pulled in transitively by the provider classes →
 * core/tokenizer) out of config.ts's import graph. The factory layer that
 * actually constructs providers lives in `./registry`.
 *
 * The `LlmProvider` union, the auto-detection order, and the provider factory
 * (in `./registry`) are all derived from `PROVIDERS`. Adding an OpenAI-compatible
 * provider is a single entry here; a divergent provider (e.g. Claude) is one
 * entry here plus its own class wired in `./registry`.
 */
import {
  type CredentialSlot,
  type LlmProviderId,
  PROVIDER_AUTH_MODE,
  PROVIDER_CREDENTIAL_SLOTS,
  PROVIDER_IDS,
  PROVIDER_MODEL_CATALOG_MODE,
  PROVIDER_NON_SECRET_ENV,
  type ProviderAuthMode,
  type ProviderModelCatalogMode,
  isLlmProviderId,
  requireStaticCredentialSlot,
} from '@clerum/llm-providers'

/**
 * The canonical provider ids, their credential slots (mapping the K8s LLM
 * Secret to shell-style env vars), the `LlmProvider` union and the guard now
 * live in the shared `@clerum/llm-providers` package — the single source of
 * truth consumed by WRC, control-api, HCC and control-ui too. registryCore
 * keeps ONLY the runtime-only descriptor fields (baseURL/defaultModel/
 * tokenizer + the factory arms in `./registry`).
 *
 * A credential slot is one credential the provider needs, mapped from the K8s
 * LLM Secret to a shell-style env var name. A provider carries one or more of
 * these:
 *   - the four OpenAI-compatible/own-SDK providers have a single slot (one API
 *     key);
 *   - `vertex` has a single (large) secret slot: the service-account JSON;
 *   - `bedrock` has two required slots: the AWS access-key-id / secret pair.
 * Non-secret per-Host config (Vertex project/location, AWS region) is NOT a
 * slot — it flows in via the pod's normal env (`host-<ref>-env`, R4.1).
 */
export type { CredentialSlot }

export interface CoreProviderDescriptor {
  /** Canonical id, == getProviderType(). */
  id: string
  authMode: ProviderAuthMode
  modelCatalogMode: ProviderModelCatalogMode
  /**
   * Credentials this provider loads from the LLM Secret, in priority order
   * (the first is the "primary" slot — see {@link primarySlot}). Static
   * providers have at least one slot; oauth-broker providers have none.
   */
  credentialSlots: CredentialSlot[]
  /** Non-secret per-Host env vars. Empty for brokers and single-key providers. */
  nonSecretEnv: readonly { envName: string; required: boolean }[]
  /** Default model when the Host does not specify one. Absent for brokers. */
  defaultModel?: string
  /**
   * Base URL for OpenAI-compatible providers (zai, bailian). Absent for
   * providers that bring their own SDK/client (openai, claude, vertex, bedrock).
   */
  baseURL?: string
  /**
   * Tokenizer hint for providers that do NOT ship createTokenCounter():
   * 'openai' → OpenAITokenCounter; 'fallback' → FallbackTokenCounter(id).
   * 'native' → the provider ships its own counter via createTokenCounter and
   * does not use this hint (Claude).
   */
  tokenizer: 'openai' | 'fallback' | 'native'
}

/** The `LlmProvider` union is the shared canonical set (data-only leaf). */
export type LlmProvider = LlmProviderId

/**
 * Runtime-only descriptor fields that stay LOCAL to mcp-host (deliberately not
 * in the shared package): the OpenAI-compatible baseURL, the Host default
 * model, and the tokenizer dispatch hint. The credential slots and id come from
 * `@clerum/llm-providers`.
 */
interface RuntimeProviderFields {
  defaultModel?: string
  /** Base URL for OpenAI-compatible providers (zai, bailian). */
  baseURL?: string
  tokenizer: CoreProviderDescriptor['tokenizer']
}

const RUNTIME_FIELDS: Record<LlmProvider, RuntimeProviderFields> = {
  openai: { defaultModel: 'gpt-5.4-mini', tokenizer: 'openai' },
  claude: { defaultModel: 'claude-sonnet-4-6', tokenizer: 'native' },
  zai: {
    defaultModel: 'glm-5.1',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    tokenizer: 'fallback',
  },
  bailian: {
    defaultModel: 'qwen3-coder-plus',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    tokenizer: 'fallback',
  },
  vertex: { defaultModel: 'gemini-2.5-pro', tokenizer: 'fallback' },
  // Bedrock's default model uses the Bedrock model id of a current Claude
  // (runtime-specific id, distinct from the native `claude` id).
  bedrock: { defaultModel: 'anthropic.claude-sonnet-4-6-v1:0', tokenizer: 'fallback' },
  // OpenAI-compatible additions — pure DATA. Each carries a fixed baseURL, so
  // makeProvider's data-driven baseURL arm builds them with ZERO driver code.
  // Tokenizer is 'fallback' for all: they serve non-OpenAI models, so the
  // OpenAI tokenizer would mis-count — FallbackTokenCounter(id) is the safe hint.
  openrouter: {
    defaultModel: 'anthropic/claude-sonnet-latest',
    baseURL: 'https://openrouter.ai/api/v1',
    tokenizer: 'fallback',
  },
  gemini: {
    defaultModel: 'gemini-2.5-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    tokenizer: 'fallback',
  },
  deepseek: {
    defaultModel: 'deepseek-v4-flash',
    baseURL: 'https://api.deepseek.com',
    tokenizer: 'fallback',
  },
  groq: {
    defaultModel: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    tokenizer: 'fallback',
  },
  together: {
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    baseURL: 'https://api.together.ai/v1',
    tokenizer: 'fallback',
  },
  fireworks: {
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    tokenizer: 'fallback',
  },
  mistral: {
    defaultModel: 'mistral-medium-latest',
    baseURL: 'https://api.mistral.ai/v1',
    tokenizer: 'fallback',
  },
  xai: {
    defaultModel: 'grok-4.3',
    baseURL: 'https://api.x.ai/v1',
    tokenizer: 'fallback',
  },
  cerebras: {
    defaultModel: 'gpt-oss-120b',
    baseURL: 'https://api.cerebras.ai/v1',
    tokenizer: 'fallback',
  },
  deepinfra: {
    defaultModel: 'deepseek-ai/DeepSeek-V3.2',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    tokenizer: 'fallback',
  },
  perplexity: {
    defaultModel: 'sonar-pro',
    baseURL: 'https://api.perplexity.ai',
    tokenizer: 'fallback',
  },
  moonshot: {
    defaultModel: 'kimi-k2.6',
    baseURL: 'https://api.moonshot.ai/v1',
    tokenizer: 'fallback',
  },
  nebius: {
    defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    baseURL: 'https://api.tokenfactory.nebius.com/v1/',
    tokenizer: 'fallback',
  },
  novita: {
    defaultModel: 'deepseek/deepseek-v3.2',
    baseURL: 'https://api.novita.ai/openai',
    tokenizer: 'fallback',
  },
  minimax: {
    // International host; `${baseURL}/chat/completions` resolves to the
    // OpenAI-compatible route. China-region deployments use api.minimaxi.com.
    defaultModel: 'MiniMax-M2',
    baseURL: 'https://api.minimax.io/v1',
    tokenizer: 'fallback',
  },
  // Azure: light-driver arm (registry.ts). No STATIC baseURL — the per-resource
  // host comes from AZURE_OPENAI_ENDPOINT at construction, so it must NOT hit the
  // data-driven baseURL arm. Tokenizer 'openai' (it serves OpenAI models) and
  // defaultModel is the Azure DEPLOYMENT name the operator expects by default.
  azure: { defaultModel: 'gpt-4.1', tokenizer: 'openai' },
  // Broker: explicit model required later; no Secret slot and no default.
  'codex-subscription': { tokenizer: 'fallback' },
}

// Order = dev auto-detection priority (first present key wins), inherited from
// PROVIDER_IDS in the shared package. The four original providers keep their
// positions; the own-SDK newcomers (vertex, bedrock) append at the end so the
// historical priority is preserved.
export const PROVIDERS: Record<LlmProvider, CoreProviderDescriptor> = Object.fromEntries(
  PROVIDER_IDS.map(id => [
    id,
    {
      id,
      authMode: PROVIDER_AUTH_MODE[id],
      modelCatalogMode: PROVIDER_MODEL_CATALOG_MODE[id],
      credentialSlots: [...PROVIDER_CREDENTIAL_SLOTS[id]],
      nonSecretEnv: [...PROVIDER_NON_SECRET_ENV[id]],
      ...RUNTIME_FIELDS[id],
    },
  ])
) as unknown as Record<LlmProvider, CoreProviderDescriptor>

export const ALL_PROVIDERS = [...PROVIDER_IDS] as LlmProvider[]

/**
 * The primary credential slot of a descriptor — the single API key of an
 * OpenAI-compatible/own-SDK single-key provider.
 *
 * RESTRICTION (spec §3-R4.1): this helper is confined to the OpenAI-compatible
 * factory arms (and the single-key own-SDK arms openai/claude), which are
 * one-API-key by nature. It is PROHIBITED in the credential-exclusion boundary
 * (`userEnvSnapshot`), which must always derive from the FULL slot set
 * ({@link ALL_PROVIDER_SLOT_ENV_NAMES}) so multi-slot (bedrock) and dynamic
 * fallback slots (R5) are never leaked to a subprocess.
 */
export function primarySlot(d: CoreProviderDescriptor): CredentialSlot {
  return requireStaticCredentialSlot(d)
}

/**
 * Every credential env-var name across ALL providers (all slots). This is the
 * registry-derived half of the subprocess credential-exclusion boundary
 * (spec §3-R4.3): no provider API credential — for ANY provider, present or
 * not — may reach a tool subprocess. The other half (keys actually delivered
 * by the `llm-secret` tier, which covers R5's dynamically-named fallback slots)
 * is derived by-source in the ConfigStore.
 */
export const ALL_PROVIDER_SLOT_ENV_NAMES: ReadonlySet<string> = new Set(
  ALL_PROVIDERS.flatMap(p => PROVIDERS[p].credentialSlots.map(s => s.envName))
)

// SECURITY (audit 2026-06-19): the guard uses an own-property check, NOT `in`
// (which walks the prototype chain → `'constructor' in {...}` === true, exactly
// the external RPC input this guards, e.g. workflowService.configure). The
// hasOwnProperty-safe implementation now lives in the shared package.
// `LlmProvider` is a plain alias of `LlmProviderId` (see above), and the shared
// guard already accepts `unknown`, so no cast is needed — the predicate carries
// through unchanged.
export const isLlmProvider = isLlmProviderId

export const descriptorFor = (p: LlmProvider): CoreProviderDescriptor => PROVIDERS[p]
