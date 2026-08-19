import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type CoverageSet,
  coverageIsSuperset,
  isNonWorseningToleration,
  offeredKey,
} from '../src/routes/admin/modelAllowlistTolerance.js'

// The no-worsening tolerance predicate is a PURE function `(stored, incoming) →
// tolerateQ` with precedence rules (a/b/c of Pieza D). Property-based tests (T2)
// explore the precedence combinations that enumerated cases miss.

const arbPairKey = fc
  .tuple(
    fc.constantFrom('claude', 'openai', 'groq', 'zai'),
    fc.string({ minLength: 1, maxLength: 6 })
  )
  .map(([p, m]) => offeredKey(p, m))

const arbKeySet = fc.array(arbPairKey, { maxLength: 8 }).map(keys => new Set(keys))
const arbCoverage: fc.Arbitrary<CoverageSet> = fc.oneof(
  fc.constant('UNIVERSAL' as const),
  arbKeySet
)

function isSuperset(incoming: CoverageSet, stored: CoverageSet): boolean {
  if (incoming === 'UNIVERSAL') return true
  if (stored === 'UNIVERSAL') return false
  for (const k of stored) if (!incoming.has(k)) return false
  return true
}

describe('coverageIsSuperset', () => {
  it('UNIVERSAL covers everything (top element)', () => {
    fc.assert(fc.property(arbCoverage, cov => coverageIsSuperset('UNIVERSAL', cov)))
  })

  it('only UNIVERSAL covers a UNIVERSAL offering', () => {
    fc.assert(
      fc.property(arbCoverage, incoming => {
        expect(coverageIsSuperset(incoming, 'UNIVERSAL')).toBe(incoming === 'UNIVERSAL')
      })
    )
  })

  it('is reflexive: any coverage is a superset of itself', () => {
    fc.assert(fc.property(arbCoverage, cov => coverageIsSuperset(cov, cov)))
  })

  it('agrees with the reference set-superset relation', () => {
    fc.assert(
      fc.property(arbCoverage, arbCoverage, (incoming, stored) => {
        expect(coverageIsSuperset(incoming, stored)).toBe(isSuperset(incoming, stored))
      })
    )
  })
})

describe('isNonWorseningToleration', () => {
  it('CANONICAL: identical pre-existing pair + superset coverage → always tolerates', () => {
    fc.assert(
      fc.property(arbPairKey, arbKeySet, arbCoverage, (pairKey, otherStored, storedCoverage) => {
        // Guarantee (a): the offending pair is referenced by the stored record.
        const storedReferencedPairKeys = new Set([...otherStored, pairKey])
        // Guarantee (b): incoming is a superset of stored — extend it with extras.
        const extra = new Set([offeredKey('extra', 'x'), offeredKey('extra', 'y')])
        const incomingCoverage: CoverageSet =
          storedCoverage === 'UNIVERSAL' ? 'UNIVERSAL' : new Set([...storedCoverage, ...extra])
        expect(
          isNonWorseningToleration({
            pairKey,
            storedReferencedPairKeys,
            incomingCoverage,
            storedCoverage,
          })
        ).toBe(true)
      })
    )
  })

  it('a pair absent from the stored record is NEVER tolerated (conditions a/c)', () => {
    fc.assert(
      fc.property(arbPairKey, arbKeySet, arbCoverage, arbCoverage, (pairKey, stored, inc, st) => {
        const storedReferencedPairKeys = new Set([...stored])
        storedReferencedPairKeys.delete(pairKey) // ensure absence
        expect(
          isNonWorseningToleration({
            pairKey,
            storedReferencedPairKeys,
            incomingCoverage: inc,
            storedCoverage: st,
          })
        ).toBe(false)
      })
    )
  })

  it('a strict coverage reduction is NEVER tolerated, even for a pre-existing pair (condition b)', () => {
    fc.assert(
      fc.property(arbPairKey, arbKeySet, (pairKey, storedFinite) => {
        // stored covers pairKey plus at least one extra that incoming will drop.
        const dropped = offeredKey('dropped', 'z')
        const storedCoverage = new Set([...storedFinite, dropped])
        const incomingCoverage = new Set([...storedFinite]) // dropped removed
        incomingCoverage.delete(dropped)
        const storedReferencedPairKeys = new Set([pairKey])
        expect(
          isNonWorseningToleration({
            pairKey,
            storedReferencedPairKeys,
            incomingCoverage,
            storedCoverage,
          })
        ).toBe(false)
      })
    )
  })

  it('equals membership(a) AND superset(b) for arbitrary inputs (full spec)', () => {
    fc.assert(
      fc.property(arbPairKey, arbKeySet, arbCoverage, arbCoverage, (pairKey, stored, inc, st) => {
        const expected = stored.has(pairKey) && isSuperset(inc, st)
        expect(
          isNonWorseningToleration({
            pairKey,
            storedReferencedPairKeys: stored,
            incomingCoverage: inc,
            storedCoverage: st,
          })
        ).toBe(expected)
      })
    )
  })

  it('create (empty stored referenced set) never tolerates', () => {
    fc.assert(
      fc.property(arbPairKey, arbCoverage, arbCoverage, (pairKey, inc, st) => {
        expect(
          isNonWorseningToleration({
            pairKey,
            storedReferencedPairKeys: new Set(),
            incomingCoverage: inc,
            storedCoverage: st,
          })
        ).toBe(false)
      })
    )
  })
})

// Role-scoped selection at the caller seam (mini-spec 01 v2). The pure predicate
// is gate-agnostic; the caller passes the ACTIVE-slot set (`storedPrimary`) at
// the active gate and the union (`storedAny`, with primary ⊆ any) at non-active
// gates. These properties pin that two-tier rule: demotion tolerated, promotion
// to the active slot never.
describe('role-scoped selection invariant (mini-spec v2)', () => {
  // storedPrimary ⊆ storedAny, as the role sets always relate.
  const arbRoleSets = arbKeySet.chain(any =>
    fc.subarray([...any]).map(primary => ({ any, primary: new Set(primary) }))
  )
  const selectFor = (
    gate: 'primary' | 'nonactive',
    roles: { primary: ReadonlySet<string>; any: ReadonlySet<string> }
  ): ReadonlySet<string> => (gate === 'primary' ? roles.primary : roles.any)

  it('tolerated(active) ⇒ P ∈ storedPrimary; tolerated(non-active) ⇒ P ∈ storedAny', () => {
    fc.assert(
      fc.property(
        arbPairKey,
        arbRoleSets,
        fc.constantFrom<'primary' | 'nonactive'>('primary', 'nonactive'),
        arbCoverage,
        arbCoverage,
        (pairKey, roles, gate, inc, st) => {
          const tolerated = isNonWorseningToleration({
            pairKey,
            storedReferencedPairKeys: selectFor(gate, roles),
            incomingCoverage: inc,
            storedCoverage: st,
          })
          if (!tolerated) return
          if (gate === 'primary') expect(roles.primary.has(pairKey)).toBe(true)
          else expect(roles.any.has(pairKey)).toBe(true)
        }
      )
    )
  })

  it('PROMOTION is never tolerated: a pair in storedAny but not storedPrimary is rejected at the active gate', () => {
    fc.assert(
      fc.property(arbPairKey, arbKeySet, arbCoverage, arbCoverage, (pairKey, others, inc, st) => {
        // pairKey exists in `any` (via `others`) but is explicitly NOT the primary.
        const any = new Set([...others, pairKey])
        const primary = new Set([...others].filter(k => k !== pairKey))
        expect(
          isNonWorseningToleration({
            pairKey,
            storedReferencedPairKeys: selectFor('primary', { primary, any }),
            incomingCoverage: inc,
            storedCoverage: st,
          })
        ).toBe(false)
      })
    )
  })
})
