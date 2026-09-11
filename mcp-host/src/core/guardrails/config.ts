/**
 * `Host.spec.guardrails` config block (spec §5).
 *
 * mcp-host CONSUMES this block; the CRD schema is owned by the CRD chart. Kept
 * additive and loosely typed where Phase 1 does not yet interpret a field
 * (hooks/builtins land in Phases 2–3). Absent/empty = no guardrails =
 * byte-identical to today (no-config compatibility, spec §5).
 *
 * TODO(phase1): parse + validate (limits, predicate admission) — see spec §5/§6.1.
 */
import type { HookDescriptor } from './hooks/types'
import type { Capability } from './types'

/** A single permission rule item (spec §6.1). Predicate shapes: spec §6.1. */
export interface GuardrailRule {
  id: string
  action: 'allow' | 'ask' | 'deny'
  reasonCode?: string
  match: {
    tool: { provenance: 'native' | 'mcp'; server?: string; name?: string }
    arguments?: Array<{
      type: 'path' | 'url' | 'command' | 'json'
      pointer: string
      op: string
      value?: unknown
    }>
  }
}

/** Engine limits (spec §5). */
export interface GuardrailLimits {
  maxRules?: number
  maxHooksPerPhase?: number
  maxHookTimeoutMs?: number
  /** Tight cap for non-rewrite hook responses (moderate/post_call/on_error). Default 1 MiB. */
  maxHookOutputBytes?: number
  /** Generous cap for `pre_call` rewrite output — the whole conversation. Default 5 MiB (~1M tokens). */
  maxHookRewriteBytes?: number
}

/**
 * The whole admin-authored block. `hooks`/`builtins` are RAW here — Phase 1 does
 * not interpret them (installed hooks = Phase 3, built-ins = Phase 2).
 */
export interface GuardrailsConfig {
  rules?: GuardrailRule[]
  hooks?: Record<string, unknown>
  builtins?: unknown[]
  /**
   * Resolved installed-hook descriptors (spec §8). In prod these come from the
   * LlmHook CR watcher (by `hooks` id, §8.2); for dev/E2E an operator can supply
   * them inline via `CLERUM_GUARDRAILS_CONFIG` to point at a hook server without
   * the reconciler. Each descriptor's `lifecyclePoints` decides which lanes it runs on.
   */
  hookDescriptors?: HookDescriptor[]
  minInstalledHookTrustLevel?: 'low' | 'mid' | 'high'
  approvalPolicies?: string[]
  capabilityCeiling?: Capability[]
  limits?: GuardrailLimits
}
