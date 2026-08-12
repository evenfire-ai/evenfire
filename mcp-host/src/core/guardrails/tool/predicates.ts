/**
 * Typed argument predicates for permission rules (spec §6.1).
 *
 * Each predicate names a constrained RFC-6901 JSON Pointer into the tool
 * arguments and a typed operator. Predicates are DEFENSE-IN-DEPTH, not a sandbox
 * (spec §6.1/§12.3): a `command` predicate sees only `argv[0]`, and `path`/`url`
 * are not TOCTOU-safe — authoritative containment is the hard-validator layer.
 *
 * TODO(phase1): implement each `evaluate` with the admission-time constraints
 * (constrained pointers, bounded wildcards `*`/`?` only, canonicalization).
 */

export type PredicateType = 'path' | 'url' | 'command' | 'json'

export interface ArgumentPredicate {
  type: PredicateType
  /** Constrained RFC-6901 JSON Pointer into the arguments. */
  pointer: string
  /** Operator, per `type` (spec §6.1). */
  op: string
  value?: unknown
}

/** Resolve a constrained JSON Pointer against the tool arguments. TODO(phase1). */
export function resolvePointer(_args: Record<string, unknown>, _pointer: string): unknown {
  // TODO(phase1): constrained RFC-6901 resolution; reject invalid/over-depth pointers at admission.
  throw new Error('resolvePointer not yet implemented (Phase 1 scaffold)')
}

/**
 * Evaluate one predicate against the tool arguments.
 *
 * - path — equals | under | outside; normalized, symlink-aware, boundary-safe; prefixes forbidden.
 * - url  — scheme_in | host_in | port_in | path_under; parsed + canonicalized (lowercase host,
 *          IDN→punycode, trailing-dot stripped); credentials-in-URL rejected (spec §12.4 / F12).
 * - command — executable_is | argv_prefix; structured executable + argv, not a parsed shell string.
 * - json — exists | equals | one_of | contains; size/depth-bounded; key order canonicalized.
 */
export function evaluatePredicate(
  _args: Record<string, unknown>,
  _predicate: ArgumentPredicate
): boolean {
  // TODO(phase1): dispatch on `predicate.type`/`op`; see the per-type notes above.
  throw new Error('evaluatePredicate not yet implemented (Phase 1 scaffold)')
}
