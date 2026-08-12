/**
 * Permission-rule engine (spec §6.1) — the tool lane's declarative contributors.
 *
 * Matches a resolved tool call on provenance + typed argument predicates and
 * produces `allow`/`ask`/`deny` contributions. All matching rules contribute;
 * array order is NEVER security precedence (the engine aggregates, spec §3).
 * Unmatched default: non-empty rules → `ask`; absent → `no_decision` (spec §3).
 *
 * NOTE (spec §6.1): an `allow` is an affirmative grant over the WHOLE call — a
 * rule that pins only some arguments still permits arbitrary values in the rest.
 *
 * TODO(phase1): implement matching (provenance + predicates) + admission checks.
 */
import type { GuardrailRule } from '../config'
import type { Contributor } from '../types'
import { evaluatePredicate } from './predicates'
import type { ToolIdentity } from './provenance'

/** A rule set compiled + validated at admission (spec §5 limits, §6.1 predicates). */
export interface CompiledRules {
  readonly rules: readonly GuardrailRule[]
  readonly hasRules: boolean
}

/**
 * Compile + validate the raw rules (bounded count/depth, valid pointers, bounded
 * wildcards). Malformed input fails closed at admission (spec §3).
 *
 * TODO(phase1): validation.
 */
export function compileRules(rules: readonly GuardrailRule[] | undefined): CompiledRules {
  return { rules: rules ?? [], hasRules: (rules?.length ?? 0) > 0 }
}

/**
 * Evaluate the compiled rules against a resolved call, returning one `pre`
 * contributor per matching rule.
 *
 * TODO(phase1): match provenance (identity) + all argument predicates; emit
 * `host_rule` contributors with the rule's `action`/`reasonCode`.
 */
export function evaluateRules(
  _compiled: CompiledRules,
  _identity: ToolIdentity,
  _args: Record<string, unknown>
): Array<Contributor<Record<string, unknown>, string>> {
  void evaluatePredicate
  throw new Error('evaluateRules not yet implemented (Phase 1 scaffold)')
}
