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
 */
import type { GuardrailRule } from '../config'
import type { Contributor } from '../types'
import { type ArgumentPredicate, evaluatePredicate } from './predicates'
import type { ToolIdentity } from './provenance'

const DEFAULT_MAX_RULES = 100
const MAX_WILDCARD_LEN = 256

/** A rule set compiled + validated at admission (spec §5 limits, §6.1 predicates). */
export interface CompiledRules {
  readonly rules: readonly GuardrailRule[]
  readonly hasRules: boolean
}

/**
 * Compile + validate the raw rules. Malformed input fails closed at admission
 * (spec §3): this throws, and the caller must reject the config rather than run
 * a partially-valid rule set (spec §5: a malformed policy never replaces the
 * last valid one).
 */
export function compileRules(
  rules: readonly GuardrailRule[] | undefined,
  maxRules = DEFAULT_MAX_RULES
): CompiledRules {
  const list = rules ?? []
  if (list.length > maxRules)
    throw new Error(`too many guardrail rules: ${list.length} > ${maxRules}`)
  const ids = new Set<string>()
  for (const r of list) {
    if (!r.id) throw new Error('guardrail rule missing id')
    if (ids.has(r.id)) throw new Error(`duplicate guardrail rule id: ${r.id}`)
    ids.add(r.id)
    if (r.action !== 'allow' && r.action !== 'ask' && r.action !== 'deny') {
      throw new Error(`invalid rule action for ${r.id}: ${String(r.action)}`)
    }
    if (!r.match?.tool?.provenance) throw new Error(`rule ${r.id} missing match.tool.provenance`)
    if (r.match.tool.provenance !== 'native' && r.match.tool.provenance !== 'mcp') {
      throw new Error(`rule ${r.id} invalid provenance: ${r.match.tool.provenance}`)
    }
    for (const a of r.match.arguments ?? []) validateArgumentShape(r.id, a)
  }
  return { rules: list, hasRules: list.length > 0 }
}

function validateArgumentShape(
  ruleId: string,
  a: NonNullable<GuardrailRule['match']['arguments']>[number]
): void {
  if (!a || typeof a !== 'object')
    throw new Error(`rule ${ruleId} has a malformed argument predicate`)
  if (!['path', 'url', 'command', 'json'].includes(a.type)) {
    throw new Error(`rule ${ruleId} invalid predicate type: ${a.type}`)
  }
  if (typeof a.pointer !== 'string' || (a.pointer !== '' && !a.pointer.startsWith('/'))) {
    throw new Error(`rule ${ruleId} invalid JSON Pointer: ${String(a.pointer)}`)
  }
  if (typeof a.op !== 'string' || !a.op) throw new Error(`rule ${ruleId} missing predicate op`)
}

/** Anchored wildcard match: only `*` (any run) and `?` (one char) — no regex (spec §6.1). */
function matchWildcard(pattern: string, value: string): boolean {
  if (pattern.length > MAX_WILDCARD_LEN) return false
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === value
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metachars (keep * and ?)
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  )
  return re.test(value)
}

/** Does a rule's tool matcher apply to this resolved identity? */
function toolMatches(rule: GuardrailRule, identity: ToolIdentity): boolean {
  const m = rule.match.tool
  if (m.provenance !== identity.provenance) return false
  if (m.server !== undefined && !matchWildcard(m.server, identity.server ?? '')) return false
  if (m.name !== undefined && !matchWildcard(m.name, identity.name)) return false
  return true
}

/**
 * Evaluate the compiled rules against a resolved call, returning one `pre`
 * `host_rule` contributor per matching rule. All predicates on a rule must match
 * (AND). A predicate that throws (malformed) propagates → the boundary
 * fail-closes.
 */
export function evaluateRules(
  compiled: CompiledRules,
  identity: ToolIdentity,
  args: Record<string, unknown>
): Array<Contributor<Record<string, unknown>, string>> {
  const out: Array<Contributor<Record<string, unknown>, string>> = []
  for (const rule of compiled.rules) {
    if (!toolMatches(rule, identity)) continue
    const predicates = (rule.match.arguments ?? []) as ArgumentPredicate[]
    const allMatch = predicates.every(p => evaluatePredicate(args, p))
    if (!allMatch) continue
    out.push({
      phase: 'pre',
      source: 'host_rule',
      sourceId: rule.id,
      decision: rule.action,
      reasonCode: rule.reasonCode ?? `rule:${rule.id}`,
    })
  }
  return out
}
