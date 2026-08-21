/**
 * Asymmetric "no-worsening" tolerance for the global `model_not_allowed` write
 * gate (spec Fase 2, Pieza D — antecedente 02 §3.4).
 *
 * PROBLEM (gap G3 — the editability trap). Once a Host's default (or any model a
 * Host/grant references) falls out of the operator allowlist (`enabled=false`),
 * the on-write `model_not_allowed` gate rejects EVERY future edit of that record
 * with 422 — including the very edit that would fix it. The operator we ask to
 * correct it cannot even open the record.
 *
 * FIX. Tolerate a `(provider, model)` pair that is NOT in the allowlist ON WRITE
 * — but ONLY when the write does not make things worse. Tolerance is
 * "no-worsening", NOT "unchanged": all three conditions must hold.
 *
 *   (a) the offending `(provider, model)` pair is IDENTICAL to one already
 *       referenced by the STORED record (CR/grant read before this write), AND
 *   (b) the incoming coverage (`spec.allowedModels` / grant `allowed_models`) is
 *       a SUPERSET of the stored coverage — the write cannot remove coverage,
 *       AND
 *   (c) the incoherence ALREADY existed in the stored record (the pair was
 *       already outside the allowlist before this write).
 *
 * Why (b) is load-bearing — the two-step bypass it closes:
 *   write-1: `allowedModels=[M], model=M`   (accepted while M is enabled)
 *   …M is later disabled globally…
 *   write-2: reduce the subset, keep `model=M` intact
 * Without (b), write-2 would be tolerated (pair unchanged) and the operator
 * would have quietly shrunk a host's offered set around a now-disabled model.
 * Requiring incoming ⊇ stored rejects write-2 with the original 422.
 *
 * Why (c) is entailed by (a) here, not a second DB read. Tolerance is only ever
 * consulted for a pair the gate JUST found to be disallowed against the CURRENT
 * allowlist snapshot. The allowlist is a single snapshot per write, so a pair
 * that is (a) present in the stored record AND currently disallowed was
 * necessarily already disallowed while stored — i.e. the incoherence pre-existed.
 * A brand-new disallowed pair (absent from the stored record) fails (a) and is
 * therefore never tolerated: this is NOT an allowlist bypass for new models.
 *
 * This module is a PURE decision function `(stored, incoming) → tolerateQ` with
 * no I/O, so it is exhaustively property-tested (fast-check) and shared verbatim
 * by all four call sites (the 3 Host gates + the grant gate) — one predicate, no
 * drift.
 */

// A NUL byte can appear in neither a provider id nor a model id (both validated
// against space/NUL-free patterns at the global-allowlist DB layer), so distinct
// `(provider, model)` pairs can never collide onto the same key — even though a
// model id may itself carry spaces (Azure deployment names).
export const OFFERED_KEY_SEP = '\u0000'

/** Stable key for a `(provider, model)` pair. */
export function offeredKey(provider: string, model: string): string {
  return `${provider}${OFFERED_KEY_SEP}${model}`
}

/**
 * Coverage the record offers. A finite `Set` of coverage keys, or the sentinel
 * `'UNIVERSAL'` for "offers everything" (an absent/empty `spec.allowedModels`,
 * which the Host gate treats as the full global allowlist). `'UNIVERSAL'` is the
 * top element: it is a superset of every finite set and of itself, and no finite
 * set is a superset of it.
 */
export type CoverageSet = ReadonlySet<string> | 'UNIVERSAL'

/** True when `incoming` covers at least everything `stored` covered (incoming ⊇ stored). */
export function coverageIsSuperset(incoming: CoverageSet, stored: CoverageSet): boolean {
  if (incoming === 'UNIVERSAL') return true
  // A finite incoming set can never re-cover a previously-universal offering:
  // narrowing "everything" to a finite list strictly removes coverage.
  if (stored === 'UNIVERSAL') return false
  for (const key of stored) {
    if (!incoming.has(key)) return false
  }
  return true
}

export interface NonWorseningToleranceInput {
  /** Key (`offeredKey`) of the pair the gate just found disallowed. */
  pairKey: string
  /** Keys of every `(provider, model)` pair referenced by the STORED record. */
  storedReferencedPairKeys: ReadonlySet<string>
  /** Coverage the incoming write offers. */
  incomingCoverage: CoverageSet
  /** Coverage the stored record offered. */
  storedCoverage: CoverageSet
}

/**
 * Decide whether a disallowed pair may be tolerated on write because the write
 * does not worsen the situation. Encodes (a)+(c) as membership of the stored
 * referenced-pair set and (b) as the coverage-superset check. Returns `false`
 * for a create (empty `storedReferencedPairKeys`), so a fresh record can never
 * introduce a disabled model under tolerance.
 */
export function isNonWorseningToleration(input: NonWorseningToleranceInput): boolean {
  // (a) + (c): the offending pair must already be referenced by the stored
  // record. On create the stored set is empty, so this is always false.
  if (!input.storedReferencedPairKeys.has(input.pairKey)) return false
  // (b): the incoming write may not remove coverage.
  return coverageIsSuperset(input.incomingCoverage, input.storedCoverage)
}
