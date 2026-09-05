/**
 * Shared canonical LLM provider list — the single source of truth for the set
 * of provider ids, their credential slots, display labels and non-secret env.
 * DATA-ONLY leaf; runtime-only descriptor fields stay local to mcp-host.
 */

/** Canonical provider ids, in dev auto-detection priority order. */
export declare const PROVIDER_IDS: readonly [
  'openai',
  'claude',
  'zai',
  'bailian',
  'vertex',
  'bedrock',
  'openrouter',
  'gemini',
  'deepseek',
  'groq',
  'together',
  'fireworks',
  'mistral',
  'xai',
  'cerebras',
  'deepinfra',
  'perplexity',
  'moonshot',
  'nebius',
  'novita',
  'minimax',
  'azure',
  'codex-subscription',
]

/** Union of the canonical provider ids. */
export type LlmProviderId = (typeof PROVIDER_IDS)[number]

/** Maximum length accepted by all runnable provider/model selectors. */
export declare const RUNNABLE_LLM_MODEL_ID_MAX_LENGTH: 128

/** Executable grammar for provider model identifiers. */
export declare const RUNNABLE_LLM_MODEL_ID_PATTERN: RegExp

/** Returns true when a model identifier is executable by the runtime contract. */
export declare function isRunnableLlmModelId(value: unknown): value is string

/**
 * One credential a provider loads from the K8s LLM Secret, mapped to a
 * shell-style env var name.
 */
export interface CredentialSlot {
  /** Lowercase-hyphen key inside the LLM Secret (k8s). */
  dataKey: string
  /** Shell-style env var name. */
  envName: string
  /** True when the provider cannot be constructed without this slot. */
  required: boolean
  /**
   * True when the slot holds a multi-line credential (e.g. Vertex's
   * service-account JSON) rendered as a textarea, rather than a single-line API
   * key. Explicit source of truth for "JSON / multi-line" — consumers use it
   * instead of a name heuristic. Absent = single-line key.
   */
  multiline?: boolean
}

/** One non-secret per-Host env var a provider needs (flows via `host-<ref>-env`). */
export interface NonSecretEnvVar {
  envName: string
  required: boolean
}

/** Credential slots per provider, in priority order (first == primary slot). */
export declare const PROVIDER_CREDENTIAL_SLOTS: Record<LlmProviderId, readonly CredentialSlot[]>

/** Human-facing brand label per provider. */
export declare const PROVIDER_DISPLAY_LABELS: Record<LlmProviderId, string>

/** Non-secret per-Host env vars per provider (empty for single-key providers). */
export declare const PROVIDER_NON_SECRET_ENV: Record<LlmProviderId, readonly NonSecretEnvVar[]>

/** Own-property (prototype-safe) guard for the canonical provider ids. */
export declare function isLlmProviderId(s: unknown): s is LlmProviderId

/**
 * Returns whether a policy credential slot belongs to the provider. Additive
 * suffixed slots are valid only for single, single-line API-key providers;
 * multi-slot and multiline providers accept canonical slots only.
 */
export declare function isCredentialSlotOwnedByProvider(
  provider: string,
  credentialSlot: string,
): boolean

export type ProviderAuthMode = 'static-credentials' | 'oauth-broker'
export type ProviderModelCatalogMode = 'static' | 'dynamic'

export interface ProviderDescriptor {
  id: LlmProviderId
  displayLabel: string
  authMode: ProviderAuthMode
  modelCatalogMode: ProviderModelCatalogMode
  credentialSlots: readonly CredentialSlot[]
  nonSecretEnv: readonly NonSecretEnvVar[]
  defaultModel?: string
}

export declare const PROVIDER_AUTH_MODE: Record<LlmProviderId, ProviderAuthMode>
export declare const PROVIDER_MODEL_CATALOG_MODE: Record<LlmProviderId, ProviderModelCatalogMode>
export declare function providerDescriptor(id: LlmProviderId): ProviderDescriptor
export declare function requireStaticCredentialSlot(
  descriptor: Pick<ProviderDescriptor, 'authMode' | 'credentialSlots'>,
): CredentialSlot
