/**
 * The lane-neutral GuardrailBoundary engine (spec §2, §4).
 *
 * Intake → Contributors → Aggregate → (Approve) → Execute at-most-once → Post → Evidence.
 *
 * TODO(phase1): implement the pipeline. Load-bearing correctness details:
 *  - Rewrite re-aggregation (spec §4.1 / F8): on any `pre` rewrite, re-validate
 *    the new input and RESTART the pre chain from the top so every rule sees the
 *    final input; honor each source's rewrite at most once (≤N restarts).
 *  - At-most-once + snapshot/resume (spec §4.2 / F10): resume re-runs the
 *    declarative rules and re-aggregates (not a policy-digest comparison).
 *  - Response-capability enforcement (spec §8.1) belongs to the hook adapter
 *    (Phase 3), not this core.
 */
import { aggregateDecision, pickPresentationReason } from './decision'
import type { BoundaryOutcome, Contributors, GuardrailBoundary } from './types'

export interface CoreBoundaryDeps<Input, Result, Identity> {
  lane: 'tool' | 'llm'
  contributors: Contributors<Input, Result, Identity>
  /** Whether a non-empty rule set exists (drives the unmatched default, spec §3). */
  hasRules: boolean
}

/**
 * Reference boundary. Phase 1 wires the tool lane through this; the body is a
 * TODO but the shape is fixed so callers can depend on it.
 */
export function createGuardrailBoundary<Input, Result, Identity>(
  deps: CoreBoundaryDeps<Input, Result, Identity>
): GuardrailBoundary<Input, Result, Identity> {
  // Referenced to keep the imports live until the pipeline lands.
  void aggregateDecision
  void pickPresentationReason
  void deps

  return {
    async guard(_args): Promise<BoundaryOutcome<Result>> {
      // TODO(phase1): Intake → pre contributors → aggregate → approve/execute → post.
      throw new Error('GuardrailBoundary.guard not yet implemented (Phase 1 scaffold)')
    },
  }
}
