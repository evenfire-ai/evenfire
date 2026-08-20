/**
 * Decision algebra & aggregation (spec §3).
 *
 * Pure, lane-neutral, fully implemented in Phase 1. Strictness order is
 * `deny > ask > allow > no_decision`; the boundary outcome is the strictest
 * contribution, and every contribution is retained by the caller for audit.
 */
import type { Contributor, ContributorSource, Decision } from './types'

/** Strictness rank: higher = stricter (spec §3). */
const RANK: Record<Decision, number> = {
  deny: 3,
  ask: 2,
  allow: 1,
  no_decision: 0,
}

/** True if `a` is at least as strict as `b`. */
export function atLeastAsStrict(a: Decision, b: Decision): boolean {
  return RANK[a] >= RANK[b]
}

/** The stricter of two decisions. */
export function stricter(a: Decision, b: Decision): Decision {
  return RANK[a] >= RANK[b] ? a : b
}

/**
 * Aggregate contributions to the strictest decision (spec §3).
 * Empty set → `no_decision`.
 */
export function aggregateDecision<I, R>(contributions: ReadonlyArray<Contributor<I, R>>): Decision {
  let outcome: Decision = 'no_decision'
  for (const c of contributions) outcome = stricter(outcome, c.decision)
  return outcome
}

/**
 * The unmatched-default for a lane (spec §3): a non-empty rule set contributes
 * `ask` when nothing matched; an entirely absent guardrail config contributes
 * `no_decision` (no-config compatibility — spec §5).
 */
export function unmatchedDefault(hasRules: boolean): Decision {
  return hasRules ? 'ask' : 'no_decision'
}

/**
 * Presentation tie-break source order (spec §3). Selects which reason to show
 * for a metric/model-facing result — NEVER severity.
 */
const SOURCE_ORDER: ContributorSource[] = [
  'admin_rule',
  'hook',
  'host_rule',
  'validator',
  'current',
]

function sourceRank(s: ContributorSource): number {
  const i = SOURCE_ORDER.indexOf(s)
  return i === -1 ? SOURCE_ORDER.length : i
}

/**
 * Pick the presentation reason code among the contributions that carry the
 * winning `decision` (spec §3): deterministic order admin_rule → hook → host_rule
 * → validator → current, then lexical `sourceId`. Returns undefined when no
 * contribution carries the decision (e.g. an unmatched default).
 */
export function pickPresentationReason<I, R>(
  contributions: ReadonlyArray<Contributor<I, R>>,
  decision: Decision
): string | undefined {
  const matching = contributions.filter(c => c.decision === decision)
  if (matching.length === 0) return undefined
  matching.sort((a, b) => {
    const r = sourceRank(a.source) - sourceRank(b.source)
    if (r !== 0) return r
    return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0
  })
  return matching[0].reasonCode
}
