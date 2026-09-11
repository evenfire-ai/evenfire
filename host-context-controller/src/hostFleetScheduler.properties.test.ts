// Property coverage for zach88 R1-M2 on PR #382: the Host fleet-scheduler
// precedence functions gained an `inputRevision` dimension, and these are exactly
// the (state, input) precedence functions whose algebraic invariants must hold as
// the request shape evolves. Total enumeration over the finite 24-shape domain is a
// deliberate choice over fast-check (which the T2 note names): the domain is small
// and every branch of both functions is scale-invariant (max / equality), so full
// enumeration is a strict superset of any random sample — exhaustive AND
// deterministic, with no new dependency added to this package.
import { describe, expect, it } from 'vitest'
import {
  type HostFleetReconcileMode,
  type HostFleetReconcileRequest,
  hostFleetRequestCovers,
  mergeHostFleetRequests,
} from './hostFleetScheduler'

const MODES: HostFleetReconcileMode[] = ['full', 'lifecycle']
const REVISIONS = [0, 1, 2, 3]
const GENERATIONS: Array<number | undefined> = [undefined, 0, 1]

const DOMAIN: HostFleetReconcileRequest[] = []
for (const mode of MODES) {
  for (const inputRevision of REVISIONS) {
    for (const ccLifecycleGeneration of GENERATIONS) {
      DOMAIN.push({
        reason: `r-${mode}-${inputRevision}-${String(ccLifecycleGeneration)}`,
        mode,
        inputRevision,
        ccLifecycleGeneration,
      })
    }
  }
}

// The safety-relevant core, ignoring `reason`: merge deliberately takes the
// requested reason, so `reason` is not part of the algebraic identity.
function sameCore(a: HostFleetReconcileRequest, b: HostFleetReconcileRequest): boolean {
  return (
    a.mode === b.mode &&
    a.inputRevision === b.inputRevision &&
    a.ccLifecycleGeneration === b.ccLifecycleGeneration
  )
}

// Expected undefined-aware max for the ccLifecycleGeneration lattice.
function expectedGen(
  a: HostFleetReconcileRequest,
  b: HostFleetReconcileRequest
): number | undefined {
  if (a.ccLifecycleGeneration === undefined) return b.ccLifecycleGeneration
  if (b.ccLifecycleGeneration === undefined) return a.ccLifecycleGeneration
  return Math.max(a.ccLifecycleGeneration, b.ccLifecycleGeneration)
}

describe('hostFleetScheduler precedence functions — exhaustive property coverage', () => {
  it('enumerates the full behavioral domain (24 request shapes)', () => {
    expect(DOMAIN).toHaveLength(MODES.length * REVISIONS.length * GENERATIONS.length)
    expect(DOMAIN).toHaveLength(24)
  })

  it('hostFleetRequestCovers is reflexive — every request covers itself', () => {
    for (const a of DOMAIN) {
      expect(hostFleetRequestCovers(a, a), `covers(${a.reason}, self)`).toBe(true)
    }
  })

  it('hostFleetRequestCovers matches the spec formula on every ordered pair — mode, revision, and generation exercised in both directions', () => {
    // Reflexivity alone never exercises mode-rejection (lifecycle does not cover
    // full), a differing revision, or a differing generation. Characterize covers
    // directly instead. Note: "merge(a,b) covers a and b" is deliberately NOT
    // asserted — merge scales inputRevision to max(a,b), so it stops covering the
    // lower-revision input by coalescing design.
    let covered = 0
    let rejected = 0
    for (const active of DOMAIN) {
      for (const requested of DOMAIN) {
        const expected =
          (active.mode === 'full' || requested.mode === 'lifecycle') &&
          active.inputRevision === requested.inputRevision &&
          (requested.ccLifecycleGeneration === undefined ||
            active.ccLifecycleGeneration === requested.ccLifecycleGeneration)
        expect(
          hostFleetRequestCovers(active, requested),
          `covers(${active.reason}, ${requested.reason})`
        ).toBe(expected)
        if (expected) covered += 1
        else rejected += 1
      }
    }
    // Non-vacuity: the formula must distinguish both outcomes on this domain, and
    // the exact counts guard against silent shrinkage of the enumerated domain.
    expect(covered).toBe(60)
    expect(rejected).toBe(516)
  })

  it('mergeHostFleetRequests is idempotent on the safety core', () => {
    for (const a of DOMAIN) {
      expect(sameCore(mergeHostFleetRequests(a, a), a), `merge(a,a) core ≡ a for ${a.reason}`).toBe(
        true
      )
    }
  })

  it('mergeHostFleetRequests is commutative on the safety core (reason aside)', () => {
    for (const a of DOMAIN) {
      for (const b of DOMAIN) {
        expect(
          sameCore(mergeHostFleetRequests(a, b), mergeHostFleetRequests(b, a)),
          `merge commutes for ${a.reason} / ${b.reason}`
        ).toBe(true)
      }
    }
  })

  it('mergeHostFleetRequests drops nothing — mode escalates to full, revision and generation take the max', () => {
    for (const a of DOMAIN) {
      for (const b of DOMAIN) {
        const m = mergeHostFleetRequests(a, b)
        expect(m.mode === 'full', `mode no-drop for ${a.reason} / ${b.reason}`).toBe(
          a.mode === 'full' || b.mode === 'full'
        )
        expect(m.inputRevision, `revision no-drop for ${a.reason} / ${b.reason}`).toBe(
          Math.max(a.inputRevision, b.inputRevision)
        )
        expect(m.ccLifecycleGeneration, `generation no-drop for ${a.reason} / ${b.reason}`).toBe(
          expectedGen(a, b)
        )
      }
    }
  })

  it('mergeHostFleetRequests is associative on the safety core', () => {
    for (const a of DOMAIN) {
      for (const b of DOMAIN) {
        for (const c of DOMAIN) {
          const left = mergeHostFleetRequests(mergeHostFleetRequests(a, b), c)
          const right = mergeHostFleetRequests(a, mergeHostFleetRequests(b, c))
          expect(
            sameCore(left, right),
            `merge associates for ${a.reason} / ${b.reason} / ${c.reason}`
          ).toBe(true)
        }
      }
    }
  })
})
