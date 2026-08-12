/**
 * The lane-neutral GuardrailBoundary engine (spec §2, §4).
 *
 * Intake → Contributors → Aggregate → (Approve) → Execute at-most-once → Post → Evidence.
 *
 * `evaluateBoundary` runs the decision-only part (pre chain + aggregate) so a
 * lane that owns its own execution/suspension (the tool loop) can act on the
 * decision itself. `createGuardrailBoundary().guard()` is the wrap-around form
 * (execute at-most-once inside) — used by the LLM lane (Phase 2).
 *
 * Rewrite re-aggregation (spec §4.1 / F8): on any honored `pre` rewrite, apply
 * it and RESTART the pre chain so every rule sees the final input; each source's
 * rewrite is honored at most once (≤N restarts) — guaranteeing termination.
 *
 * At-most-once (spec §4.2): `execute` is invoked exactly once, only when the
 * aggregate permits it. Resume (F10) is the CALLER re-invoking the boundary,
 * which re-runs the declarative pre contributors (rules) and re-aggregates — not
 * a digest comparison. Response-capability enforcement (spec §8.1) and post
 * transforms/substitute belong to the hook adapter (Phase 3), not this core.
 */
import { aggregateDecision, pickPresentationReason, unmatchedDefault } from './decision'
import { guardrailBoundaryDurationMs, guardrailDecisionsTotal } from './metrics'
import type {
  BoundaryOutcome,
  Contributor,
  ContributorSource,
  Contributors,
  Decision,
  GuardrailBoundary,
} from './types'

/** Backstop on rewrite restarts; real termination comes from at-most-once-per-source. */
const MAX_REWRITE_ROUNDS = 64

export interface CoreBoundaryDeps<Input, Result, Identity> {
  lane: 'tool' | 'llm'
  contributors: Contributors<Input, Result, Identity>
  /** Whether a non-empty rule set exists (drives the unmatched default, spec §3). */
  hasRules: boolean
}

/** Decision-only result (spec §3) — no execution. */
export interface BoundaryEvaluation<Input> {
  decision: Decision
  reasonCode: string
  /** The input after any honored rewrites (spec §4.1). */
  effectiveInput: Input
  /** The winning contribution's source (for evidence). */
  source: ContributorSource
}

/**
 * Run the pre chain (with F8 rewrite re-aggregation) and aggregate to a decision.
 * No execution, no metrics — the caller records the final outcome.
 */
export async function evaluateBoundary<Input, Result, Identity>(
  deps: CoreBoundaryDeps<Input, Result, Identity>,
  identity: Identity,
  input: Input
): Promise<BoundaryEvaluation<Input>> {
  let effectiveInput = input
  const appliedRewrites = new Set<string>()
  let contributions: Array<Contributor<Input, Result>> = []
  for (let round = 0; round < MAX_REWRITE_ROUNDS; round++) {
    contributions = await deps.contributors.pre(effectiveInput, identity)
    const pending = contributions.find(
      c => c.rewrite !== undefined && !appliedRewrites.has(c.sourceId)
    )
    if (!pending || pending.rewrite === undefined) break
    appliedRewrites.add(pending.sourceId)
    effectiveInput = pending.rewrite // restart: every rule/hook re-evaluates the rewritten input.
  }

  const decision: Decision =
    contributions.length === 0 ? unmatchedDefault(deps.hasRules) : aggregateDecision(contributions)
  const reasonCode =
    pickPresentationReason(contributions, decision) ??
    (decision === 'ask' ? 'unmatched_ask' : decision === 'no_decision' ? 'no_decision' : decision)
  const source: ContributorSource =
    contributions.find(c => c.decision === decision)?.source ?? 'current'

  return { decision, reasonCode, effectiveInput, source }
}

function record(
  lane: 'tool' | 'llm',
  decision: Decision,
  source: string,
  outcome: 'executed' | 'denied' | 'ask',
  reasonCode: string
): void {
  guardrailDecisionsTotal.inc({
    lane,
    decision,
    source,
    execution_mode: 'unknown', // enriched by the lane adapter when known (spec §6.3)
    phase: 'pre',
    outcome,
    reason_code: reasonCode,
  })
}

/** Record a guardrail decision + its outcome (spec §9). Exposed so lane adapters that own execution can emit it. */
export function recordDecision(
  lane: 'tool' | 'llm',
  decision: Decision,
  source: string,
  outcome: 'executed' | 'denied' | 'ask',
  reasonCode: string
): void {
  record(lane, decision, source, outcome, reasonCode)
}

export function createGuardrailBoundary<Input, Result, Identity>(
  deps: CoreBoundaryDeps<Input, Result, Identity>
): GuardrailBoundary<Input, Result, Identity> {
  return {
    async guard({ identity, input, execute }): Promise<BoundaryOutcome<Result>> {
      const stopTimer = guardrailBoundaryDurationMs.startTimer({ lane: deps.lane })
      try {
        const { decision, reasonCode, effectiveInput, source } = await evaluateBoundary(
          deps,
          identity,
          input
        )

        if (decision === 'deny') {
          record(deps.lane, decision, source, 'denied', reasonCode)
          return { kind: 'denied', reasonCode }
        }
        if (decision === 'ask') {
          record(deps.lane, decision, source, 'ask', reasonCode)
          return { kind: 'ask', reasonCode }
        }

        // allow / no_decision → execute at-most-once, then post.
        const result = await execute(effectiveInput)
        // TODO(phase3): apply post-contributor transforms/substitute (PostToolUse
        // redaction, spec §6.2). Phase 1 tool-lane post is a no-op.
        await deps.contributors.post(result, identity)
        record(deps.lane, decision, source, 'executed', reasonCode)
        return { kind: 'executed', result }
      } finally {
        stopTimer()
      }
    },
  }
}
