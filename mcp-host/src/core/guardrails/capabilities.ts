/**
 * Capability set + enforcement helpers (spec §4.3, §8.1).
 *
 * A hook's powers beyond its default `allow` are admin-granted capabilities,
 * enforced on the hook RESPONSE (not merely declared): an ungranted action is
 * discarded. Phase 1 defines the set + the ceiling check; response enforcement
 * over the `/v1` protocol lands with the hook adapter in Phase 3.
 */
import type { Capability, Contributor } from './types'

export const ALL_CAPABILITIES: readonly Capability[] = [
  'may_deny',
  'may_rewrite',
  'may_substitute_result',
  'may_add_context',
]

/** Whether `granted` covers `needed` (per-hook grant ⊆ capabilityCeiling — spec §5). */
export function withinCeiling(
  granted: readonly Capability[],
  ceiling: readonly Capability[]
): boolean {
  return granted.every(c => ceiling.includes(c))
}

/**
 * Neutralize any action a contribution took without the matching capability
 * (spec §8.1): a `deny` without `may_deny` downgrades to `no_decision`; an
 * unhonored `rewrite`/`substitute` is dropped.
 *
 * TODO(phase1/3): full response-capability enforcement + audit of dropped
 * actions lives in the hook adapter; this is the pure downgrade helper.
 */
export function enforceCapabilities<I, R>(
  contribution: Contributor<I, R>,
  granted: readonly Capability[]
): Contributor<I, R> {
  const out: Contributor<I, R> = { ...contribution }
  if (out.decision === 'deny' && !granted.includes('may_deny')) out.decision = 'no_decision'
  if (out.rewrite !== undefined && !granted.includes('may_rewrite')) delete out.rewrite
  if (out.substitute !== undefined && !granted.includes('may_substitute_result'))
    delete out.substitute
  return out
}
