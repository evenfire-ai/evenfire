import { describe, expect, it } from 'vitest'
import {
  isRecipeOwned,
  resolveCredentialSurface,
} from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import type { McpServerCondition } from '@lib/api'
import {
  secretAccessDenied,
  secretFound,
  secretMissingKey,
  secretNotFound,
  syntheticCondition,
  withoutTimestamp,
} from './fixtures/secretResolvedConditions'

// ─── Fixtures come from the shared producer builder, never from literals ───
//
// Every condition below is built by ./fixtures/secretResolvedConditions, which
// mirrors host-context-controller/src/reconciler.ts. Hand-written triples are
// how `reason: 'SecretResolved'` (the condition TYPE reused as a reason, which
// the producer never emits) survived here for two rounds: the resolver only
// asks "is this an absence claim?", so a plausible-but-wrong reason exercises
// the same branch and stays green while proving nothing.
//
// Fixtures the producer CANNOT emit come from `syntheticCondition` /
// `withoutTimestamp` and are labelled SYNTHETIC ADVERSARY at the call site.

const T0 = '2026-08-06T04:00:00.000Z'
const T1 = '2026-08-06T05:00:00.000Z'

describe('resolveCredentialSurface', () => {
  it('returns "set" when the Secret does not exist on a managed connector', () => {
    expect(resolveCredentialSurface([secretNotFound({ at: T0 })], { managed: true })).toBe('set')
  })

  // The load-bearing case: SecretMissingKey means the Secret EXISTS but lacks a
  // key, which the PUT merge-patch already handles. An implementation matching
  // only type+status (what McpServerTable does for its badge) would wrongly
  // return 'set' here and POST into an AlreadyExists.
  it('returns "rotate" when the Secret exists but is missing a key', () => {
    expect(resolveCredentialSurface([secretMissingKey({ at: T0 })], { managed: true })).toBe(
      'rotate'
    )
  })

  // SecretAccessDenied is a READ failure, not an absence proof: HCC could not
  // look, so the Secret is probably still there. Sending it to the create form
  // would POST into an AlreadyExists that control-api collapses to a bare 500.
  it('returns "rotate" when HCC could not read the Secret', () => {
    expect(resolveCredentialSurface([secretAccessDenied({ at: T0 })], { managed: true })).toBe(
      'rotate'
    )
  })

  // Pins the `type` clause on its own. Every other fixture is a SecretResolved
  // condition, so deleting `c.type === 'SecretResolved'` from the predicate left
  // the whole suite green: a DeploymentReady=False/SecretNotFound (or any other
  // condition type reusing that reason) would then be read as a missing Secret
  // and send the operator to the create form.
  //
  // SYNTHETIC ADVERSARY: the HCC writes `SecretNotFound` only on
  // `SecretResolved`. The fixture deliberately misplaces it.
  it('returns "rotate" when SecretNotFound is carried by a different condition type', () => {
    expect(
      resolveCredentialSurface([syntheticCondition({ type: 'Ready', lastTransitionTime: T0 })], {
        managed: true,
      })
    ).toBe('rotate')
  })

  // Pins the `status` clause on its own. The clean-resolution fixture varies
  // `status` AND `reason` together, so the `reason` clause alone kept it green;
  // this one varies ONLY the status.
  //
  // SYNTHETIC ADVERSARY: the producer writes `SecretResolved` at 'True' or
  // 'False' only — never 'Unknown'. This models a hand-edited or
  // partially-reconciled resource.
  it('returns "rotate" when SecretResolved holds SecretNotFound at status Unknown', () => {
    expect(
      resolveCredentialSurface(
        [syntheticCondition({ status: 'Unknown', lastTransitionTime: T0 })],
        {
          managed: true,
        }
      )
    ).toBe('rotate')
  })

  it('returns "rotate" when the Secret resolves cleanly', () => {
    expect(resolveCredentialSurface([secretFound({ at: T0 })], {})).toBe('rotate')
  })

  it('returns "rotate" when there are no conditions', () => {
    expect(resolveCredentialSurface([], {})).toBe('rotate')
    expect(resolveCredentialSurface(undefined, undefined)).toBe('rotate')
  })

  // WRC-owned connectors reach the same SecretNotFound condition, but their
  // Secret belongs to the recipe (PUT guards it, POST does not) and HCC never
  // creates a Deployment for them, so the success poll could never converge.
  it('returns "recipe-owned" for a WRC-owned connector whose Secret is missing', () => {
    expect(resolveCredentialSurface([secretNotFound({ at: T0 })], { managed: false })).toBe(
      'recipe-owned'
    )
  })

  // The managed check applies ONLY when the Secret is missing: rotation that
  // works today on a WRC-owned connector must not be taken away.
  it('returns "rotate" for a WRC-owned connector whose Secret resolves', () => {
    expect(resolveCredentialSurface([secretFound({ at: T0 })], { managed: false })).toBe('rotate')
  })
})

// ─── R1-M2 / mini-spec §2: condition authority ─────────────────────────────
//
// The McpServer CRD declares an ordinary conditions array and does NOT enforce
// uniqueness per `type`. HCC normally rewrites a type in place, but a legacy or
// hand-edited resource can carry two SecretResolved entries that contradict
// each other. A `.some()` predicate lets ANY stale absence claim win, which
// forces every key and re-enables POST against a Secret that already exists.
//
// C1 exactly one SecretResolved condition is authoritative;
// C2 authority ranks by a STRICTLY validated timestamp (RFC3339 syntax plus a
//    calendar round-trip);
// C3 missing / empty / non-RFC3339 / invalid-calendar all share one oldest rank;
// C4 among equal ranks, the LAST array entry wins;
// C5 the caller's array is never mutated.
describe('resolveCredentialSurface — C1: one authoritative condition', () => {
  it('returns "rotate" when a NEWER duplicate says the Secret resolved cleanly', () => {
    expect(
      resolveCredentialSurface([secretNotFound({ at: T0 }), secretFound({ at: T1 })], {
        managed: true,
      })
    ).toBe('rotate')
  })

  it('returns "rotate" when a NEWER duplicate says SecretMissingKey', () => {
    expect(
      resolveCredentialSurface([secretNotFound({ at: T0 }), secretMissingKey({ at: T1 })], {
        managed: true,
      })
    ).toBe('rotate')
  })

  // Array order must not decide anything while the timestamps still can: the
  // same pair, reversed.
  it('returns "rotate" when the newer clean duplicate is listed FIRST', () => {
    expect(
      resolveCredentialSurface([secretFound({ at: T1 }), secretNotFound({ at: T0 })], {
        managed: true,
      })
    ).toBe('rotate')
  })

  it('returns "set" when the NEWEST duplicate is the SecretNotFound one', () => {
    expect(
      resolveCredentialSurface([secretFound({ at: T0 }), secretNotFound({ at: T1 })], {
        managed: true,
      })
    ).toBe('set')
  })

  it('returns "recipe-owned" when the newest duplicate is SecretNotFound on a WRC-owned connector', () => {
    expect(
      resolveCredentialSurface([secretFound({ at: T0 }), secretNotFound({ at: T1 })], {
        managed: false,
      })
    ).toBe('recipe-owned')
  })

  // Identical duplicates: same triple, same instant, twice. There is no
  // contradiction to resolve, so the verdict must simply be that triple's.
  it('returns the single verdict when the duplicate is byte-identical', () => {
    expect(
      resolveCredentialSurface([secretNotFound({ at: T0 }), secretNotFound({ at: T0 })], {
        managed: true,
      })
    ).toBe('set')
    expect(
      resolveCredentialSurface([secretFound({ at: T0 }), secretFound({ at: T0 })], {
        managed: true,
      })
    ).toBe('rotate')
  })

  // Unrelated condition types must not participate in the selection at all —
  // not as candidates, and not by shifting array order.
  //
  // The two bracketing entries are SYNTHETIC ADVERSARIES: they pair a real
  // SecretResolved reason with the WRONG condition type and carry the NEWEST
  // timestamps in the array, so a resolver that dropped the `type` clause and
  // matched on reason alone would pick one of these over either real candidate.
  it('ignores unrelated condition types regardless of their position or recency', () => {
    const conditions: McpServerCondition[] = [
      syntheticCondition({
        type: 'DeploymentReady',
        lastTransitionTime: '2026-08-06T09:00:00.000Z',
      }),
      secretNotFound({ at: T0 }),
      syntheticCondition({
        type: 'Ready',
        status: 'True',
        reason: 'SecretFound',
        lastTransitionTime: '2026-08-06T09:00:00.000Z',
      }),
      secretFound({ at: T1 }),
    ]
    expect(resolveCredentialSurface(conditions, { managed: true })).toBe('rotate')
    // Reversing puts the stale SecretNotFound after the newer SecretFound. The
    // timestamps still decide, so the verdict is unchanged.
    expect(resolveCredentialSurface([...conditions].reverse(), { managed: true })).toBe('rotate')
  })
})

describe('resolveCredentialSurface — C2/C3: strict timestamp validation', () => {
  // THE R1-M2 CASE. `new Date('2026-02-30T00:00:00.000Z')` neither throws nor
  // yields Invalid Date — JavaScript normalizes February 30 into March 2. Under
  // a bare `new Date(...)` comparison the malformed absence claim therefore
  // ranks TWO DAYS AHEAD of the valid February 28 resolution and wins, forcing
  // the operator into the create path for a Secret that exists.
  //
  // SYNTHETIC ADVERSARY: HCC always stamps a real instant; only a hand-edited
  // or legacy resource can carry this.
  it('ranks an invalid CALENDAR date oldest, so it cannot beat a valid older one', () => {
    const feb30 = syntheticCondition({ lastTransitionTime: '2026-02-30T00:00:00.000Z' })
    const feb28 = secretFound({ at: '2026-02-28T23:59:59.000Z' })
    expect(resolveCredentialSurface([feb30, feb28], { managed: true })).toBe('rotate')
    expect(resolveCredentialSurface([feb28, feb30], { managed: true })).toBe('rotate')
  })

  // The same normalization trap in the other two positions: month 13 rolls into
  // the next January, hour 25 into the next day.
  it('ranks other normalizable components (month 13, hour 25) oldest too', () => {
    const month13 = syntheticCondition({ lastTransitionTime: '2026-13-01T00:00:00.000Z' })
    const hour25 = syntheticCondition({ lastTransitionTime: '2026-08-06T25:00:00.000Z' })
    const valid = secretFound({ at: '2026-08-06T00:00:00.000Z' })
    expect(resolveCredentialSurface([month13, valid], { managed: true })).toBe('rotate')
    expect(resolveCredentialSurface([hour25, valid], { managed: true })).toBe('rotate')
  })

  // Syntax half of C2: values `Date.parse` accepts but RFC3339 does not. A bare
  // local date-time would be read in the BROWSER's timezone, so the same status
  // would resolve differently for two operators in different offsets.
  it('ranks Date-parseable but non-RFC3339 timestamps oldest', () => {
    const valid = secretFound({ at: '2026-08-06T00:00:00.000Z' })
    for (const malformed of [
      '2026-08-07', // date only
      '2026-08-07T12:00:00', // no offset: browser-timezone dependent
      'Aug 7, 2026', // Date.parse accepts this too
      '2026-08-07 12:00:00Z', // space instead of T
    ]) {
      expect(
        resolveCredentialSurface([syntheticCondition({ lastTransitionTime: malformed }), valid], {
          managed: true,
        })
      ).toBe('rotate')
    }
  })

  // C3: every malformed form shares ONE rank, so none of them can outrank a
  // validly stamped condition — whatever kind of malformed it is.
  it('ranks missing, empty and unparseable timestamps identically (oldest)', () => {
    const valid = secretFound({ at: T0 })
    const missing = withoutTimestamp(secretNotFound({ at: T0 }))
    const empty = syntheticCondition({ lastTransitionTime: '' })
    const garbage = syntheticCondition({ lastTransitionTime: 'not-a-timestamp' })
    for (const malformed of [missing, empty, garbage]) {
      expect(resolveCredentialSurface([malformed, valid], { managed: true })).toBe('rotate')
      expect(resolveCredentialSurface([valid, malformed], { managed: true })).toBe('rotate')
    }
  })

  // A LONE absence claim with a malformed timestamp still means "missing":
  // nothing contradicts it, so C3's "oldest rank" costs it nothing.
  it('still returns "set" for a lone SecretNotFound with an unparseable timestamp', () => {
    expect(
      resolveCredentialSurface([syntheticCondition({ lastTransitionTime: 'not-a-timestamp' })], {
        managed: true,
      })
    ).toBe('set')
    expect(
      resolveCredentialSurface([withoutTimestamp(secretNotFound({ at: T0 }))], { managed: true })
    ).toBe('set')
  })

  // Valid RFC3339 forms the API server can legitimately produce must NOT be
  // swept into the oldest rank by an over-strict regex: a non-Z offset and a
  // whole-second stamp are both real. Here the OFFSET is what makes the absence
  // claim newer (2026-08-06T04:30:00+00:30 == 04:00Z, one hour after 03:00Z).
  it('accepts non-Z offsets and second-precision stamps as valid instants', () => {
    expect(
      resolveCredentialSurface(
        [
          secretFound({ at: '2026-08-06T03:00:00Z' }),
          syntheticCondition({ lastTransitionTime: '2026-08-06T04:30:00+00:30' }),
        ],
        { managed: true }
      )
    ).toBe('set')
    // And the offset is applied with the right SIGN: +00:30 is 30 minutes
    // BEHIND the same wall-clock read as UTC, so this one is now the older.
    expect(
      resolveCredentialSurface(
        [
          secretFound({ at: '2026-08-06T04:15:00Z' }),
          syntheticCondition({ lastTransitionTime: '2026-08-06T04:30:00+00:30' }),
        ],
        { managed: true }
      )
    ).toBe('rotate')
  })
})

describe('resolveCredentialSurface — C4: deterministic tie-break', () => {
  // Equal rank, so position decides: the LAST entry wins. Both orders are
  // asserted, and they deliberately differ — that is what makes the rule
  // observable at all. Preferring "the one that does not claim absence" would
  // return 'rotate' for both and make the positional rule untestable.
  it('resolves an exact timestamp tie to the LAST entry, in both orders', () => {
    const same = T0
    expect(
      resolveCredentialSurface([secretNotFound({ at: same }), secretFound({ at: same })], {
        managed: true,
      })
    ).toBe('rotate')
    expect(
      resolveCredentialSurface([secretFound({ at: same }), secretNotFound({ at: same })], {
        managed: true,
      })
    ).toBe('set')
  })

  // C3 puts every malformed timestamp on ONE rank, so two malformed conditions
  // are also a tie — and resolve by the same positional rule.
  //
  // SYNTHETIC ADVERSARIES: both timestamps are hand-edited garbage.
  it('resolves a tie between two malformed timestamps to the LAST entry', () => {
    expect(
      resolveCredentialSurface(
        [
          syntheticCondition({ lastTransitionTime: '' }),
          syntheticCondition({
            status: 'True',
            reason: 'SecretFound',
            lastTransitionTime: 'whenever',
          }),
        ],
        { managed: true }
      )
    ).toBe('rotate')
    expect(
      resolveCredentialSurface(
        [
          syntheticCondition({
            status: 'True',
            reason: 'SecretFound',
            lastTransitionTime: 'whenever',
          }),
          syntheticCondition({ lastTransitionTime: '' }),
        ],
        { managed: true }
      )
    ).toBe('set')
  })

  // Determinism: the same array, resolved repeatedly, always gives the same
  // answer. (Different permutations of a tie legitimately differ — that IS the
  // rule; what may never differ is the same input twice.)
  it('is deterministic for a given array', () => {
    const tied = [secretFound({ at: T0 }), secretNotFound({ at: T0 })]
    const verdicts = new Set(
      Array.from({ length: 5 }, () => resolveCredentialSurface(tied, { managed: true }))
    )
    expect(verdicts).toEqual(new Set(['set']))
  })
})

describe('resolveCredentialSurface — C5: the caller’s array is not mutated', () => {
  // The page passes `server.status?.conditions` straight from React state. A
  // resolver that sorted in place to find "the newest" would reorder a rendered
  // resource behind React's back — no re-render, and every other reader of that
  // array (the status badge, the conditions table) silently reordered with it.
  it('leaves the conditions array and its entries untouched', () => {
    const conditions: McpServerCondition[] = [
      secretFound({ at: T1 }),
      syntheticCondition({
        type: 'DeploymentReady',
        lastTransitionTime: '2026-08-06T09:00:00.000Z',
      }),
      secretNotFound({ at: T0 }),
    ]
    // Deep snapshot BEFORE, including element identity and order.
    const order = [...conditions]
    const snapshot = JSON.parse(JSON.stringify(conditions))

    expect(resolveCredentialSurface(conditions, { managed: true })).toBe('rotate')

    expect(conditions).toHaveLength(3)
    expect(conditions).toEqual(snapshot)
    // Identity too: a sort would reorder these references even though the
    // structural comparison above already covers the values.
    conditions.forEach((c, i) => expect(c).toBe(order[i]))
  })
})

describe('isRecipeOwned', () => {
  it('is true only for an explicit managed:false spec', () => {
    expect(isRecipeOwned({ managed: false })).toBe(true)
    expect(isRecipeOwned({ managed: true })).toBe(false)
    expect(isRecipeOwned({})).toBe(false)
    expect(isRecipeOwned(undefined)).toBe(false)
  })
})
