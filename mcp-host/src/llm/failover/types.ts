/**
 * Provider-fallback (R5) — shared types.
 *
 * DATA-ONLY LEAF: string unions + plain interfaces, no runtime imports. Consumed
 * by the reusable {@link FailoverEngine} (agent-agnostic, so F6 can reuse it for
 * workflow steps and promptBridge), by the Host CR type (`spec.llmPolicy`), and
 * by the agent glue (`core/adapters/failoverLlmPort.ts`).
 */

/**
 * The closed catalogue of error classes that may trigger a fallback (spec
 * §3-R5.2). Defined as a mapping over the real `(LlmErrorCode, retryable)`
 * tuples — `provider_unavailable` has no dedicated error code; it composes
 * `ModelOverloaded ∪ (ApiCallFailed ∧ retryable)`. See {@link classifyFailoverClass}.
 */
export type FailoverClass = 'insufficient_quota' | 'auth' | 'provider_unavailable' | 'rate_limited'

/** A `(provider, model)` pair — the unit the failover engine switches between. */
export interface ModelPair {
  provider: string
  model: string
}

/**
 * One ordered fallback entry (spec §3-R5.3). A fixed `(provider, model)` pair.
 * `credentialSlot` optionally overrides which key of the SAME `chatllm-api-keys`
 * Secret feeds the provider's primary credential slot (e.g. `claude-api-key-fb1`
 * for a same-provider-other-key fallback); absent = the provider's normal slots.
 *
 * NOTE (R5.7 — `model` is IGNORED for a SAME-provider fallback): when this
 * entry's `provider` equals the primary's, the runtime serves the SESSION's
 * model (the per-session selection), NOT this `model`. `model` only takes effect
 * for a CROSS-provider fallback. The editor still lets an operator pick a `model`
 * for a same-provider entry; it is inert at runtime (kept only for the CRD shape
 * and to disambiguate the pair in the UI).
 */
export interface FallbackEntry {
  provider: string
  model: string
  credentialSlot?: string
}

/**
 * Normalized failover policy (spec §3-R5.3). Produced by {@link parseLlmPolicy}
 * from the raw `spec.llmPolicy` of the Host CR; `cooldownSeconds`/`triggerOn`
 * carry their defaults resolved. `fallbacks` is always non-empty (a policy that
 * parses to zero usable entries is represented as `null`, i.e. no failover).
 */
export interface LlmPolicy {
  /** Sticky cooldown applied to the primary after an eligible failure. Default 300. */
  cooldownSeconds: number
  /** Error classes that trigger a fallback. Default: all four. */
  triggerOn: FailoverClass[]
  /** Ordered fallback list, tried in order. Non-empty. */
  fallbacks: FallbackEntry[]
  /**
   * Token-budget denials (`providerCode=budget_denied`) are terminal by
   * default. Set true only when the operator explicitly opts a Host into
   * failing over after a Codex/control-plane budget block.
   */
  budgetDeniedFailover?: boolean
}

/** A target the engine attempts on a given call. */
export type FailoverTarget =
  | ({ kind: 'primary' } & ModelPair)
  | ({ kind: 'fallback'; index: number } & ModelPair)

/** Emitted on every actual switch to a different (constructible) pair. */
export interface FailoverSwitchEvent {
  from: ModelPair
  to: ModelPair
  reason: FailoverClass
}

/**
 * The pair currently serving the Host (spec §3-R5.9). Projected onto the status
 * response as `servedBy` so the desktop can show the "operating with fallback"
 * badge. `fallback` is true whenever a configured fallback entry is serving.
 */
export interface ServedBy extends ModelPair {
  fallback: boolean
}
