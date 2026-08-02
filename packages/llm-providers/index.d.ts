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
  'azure',
]

/** Union of the canonical provider ids. */
export type LlmProviderId = (typeof PROVIDER_IDS)[number]

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
