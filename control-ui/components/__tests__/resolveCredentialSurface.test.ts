import { describe, expect, it } from 'vitest'
import {
  isRecipeOwned,
  resolveCredentialSurface,
} from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import type { McpServerCondition } from '@lib/api'

// ─── Fixtures are copied from the PRODUCER, not invented ───────────────────
//
// The only producer of `SecretResolved` is the HCC:
// host-context-controller/src/reconciler.ts. A fixture that drifts from what it
// actually writes tests a condition Kubernetes will never hold, and the drift
// is invisible — the resolver matches on `reason`, so a plausible-but-wrong
// reason string still exercises "not an absence claim" and stays green while
// proving nothing about the real one.
//
// Absence claim: reconciler.ts:2039-2046 writes `SecretResolved` / `False` with
// `secretResult.reason` and `secretResult.message` straight from validateSecret,
// whose 404 branch (reconciler.ts:470-473) produces exactly the reason and
// message below.
function condition(overrides: Partial<McpServerCondition> = {}): McpServerCondition {
  return {
    type: 'SecretResolved',
    status: 'False',
    reason: 'SecretNotFound',
    message: 'Secret "x-credentials" not found in namespace "mcp-server"',
    lastTransitionTime: '2026-08-06T04:48:48.564Z',
    ...overrides,
  }
}

// Clean resolution: reconciler.ts:1979-1986 (managed connectors) and
// :2061-2068 (WRC-owned runtimes) both write this exact triple.
//
// The reason is `SecretFound`. It is NOT `SecretResolved` — that is the
// condition TYPE, and reusing it as the reason is the specific mistake these
// fixtures used to make. The resolver only asks "is this an absence claim?", so
// the wrong string passed just as happily, which is what made the drift
// survivable in the first place.
function resolvedCondition(overrides: Partial<McpServerCondition> = {}): McpServerCondition {
  return {
    type: 'SecretResolved',
    status: 'True',
    reason: 'SecretFound',
    message: 'Secret resolved and validated',
    lastTransitionTime: '2026-08-06T04:48:48.564Z',
    ...overrides,
  }
}

describe('resolveCredentialSurface', () => {
  it('returns "set" when the Secret does not exist on a managed connector', () => {
    expect(resolveCredentialSurface([condition()], { managed: true })).toBe('set')
  })

  // The load-bearing case: SecretMissingKey means the Secret EXISTS but lacks a
  // key, which the PUT merge-patch already handles. An implementation matching
  // only type+status (what McpServerTable does for its badge) would wrongly
  // return 'set' here and POST into an AlreadyExists.
  it('returns "rotate" when the Secret exists but is missing a key', () => {
    expect(
      resolveCredentialSurface([condition({ reason: 'SecretMissingKey' })], { managed: true })
    ).toBe('rotate')
  })

  // Pins the `type` clause on its own. Every other fixture is a SecretResolved
  // condition, so deleting `c.type === 'SecretResolved'` from the predicate left
  // the whole suite green: a DeploymentReady=False/SecretNotFound (or any other
  // condition type reusing that reason) would then be read as a missing Secret
  // and send the operator to the create form.
  //
  // SYNTHETIC ADVERSARY, not producer output: the HCC writes `SecretNotFound`
  // only on `SecretResolved`. The fixture deliberately misplaces it.
  it('returns "rotate" when SecretNotFound is carried by a different condition type', () => {
    expect(
      resolveCredentialSurface([condition({ type: 'Ready', reason: 'SecretNotFound' })], {
        managed: true,
      })
    ).toBe('rotate')
  })

  // Pins the `status` clause on its own. The clean-resolution fixture below
  // changes `status` AND `reason` together, so the `reason` clause alone kept it
  // green; this one varies ONLY the status.
  it('returns "rotate" when SecretResolved holds SecretNotFound at status Unknown', () => {
    expect(resolveCredentialSurface([condition({ status: 'Unknown' })], { managed: true })).toBe(
      'rotate'
    )
  })

  it('returns "rotate" when the Secret resolves cleanly', () => {
    expect(resolveCredentialSurface([resolvedCondition()], {})).toBe('rotate')
  })

  it('returns "rotate" when there are no conditions', () => {
    expect(resolveCredentialSurface([], {})).toBe('rotate')
    expect(resolveCredentialSurface(undefined, undefined)).toBe('rotate')
  })

  // WRC-owned connectors reach the same SecretNotFound condition, but their
  // Secret belongs to the recipe (PUT guards it, POST does not) and HCC never
  // creates a Deployment for them, so the success poll could never converge.
  it('returns "recipe-owned" for a WRC-owned connector whose Secret is missing', () => {
    expect(resolveCredentialSurface([condition()], { managed: false })).toBe('recipe-owned')
  })

  // The managed check applies ONLY when the Secret is missing: rotation that
  // works today on a WRC-owned connector must not be taken away.
  it('returns "rotate" for a WRC-owned connector whose Secret resolves', () => {
    expect(
      resolveCredentialSurface([resolvedCondition()], {
        managed: false,
      })
    ).toBe('rotate')
  })
})

// ─── R1-M2: duplicate SecretResolved conditions ────────────────────────────
//
// The McpServer CRD declares an ordinary conditions array and does NOT enforce
// uniqueness per `type`. HCC normally rewrites a type in place, but a legacy or
// hand-edited resource can carry two SecretResolved entries that contradict
// each other. A `.some()` predicate lets ANY stale absence claim win, which
// forces every key and re-enables POST against a Secret that already exists.
//
// The resolver therefore selects ONE authoritative SecretResolved condition:
//   1. newest parseable `lastTransitionTime` wins;
//   2. an absent/unparseable timestamp ranks as the OLDEST possible, so a
//      malformed absence claim can never outrank a well-stamped resolution;
//   3. on an exact tie, the condition that does NOT claim absence wins —
//      ambiguity must never resolve to the destructive "the Secret is missing";
//   4. still tied (they all claim absence, so they agree): last array entry.
describe('resolveCredentialSurface — duplicate SecretResolved conditions', () => {
  it('returns "rotate" when a NEWER duplicate says the Secret resolved cleanly', () => {
    expect(
      resolveCredentialSurface(
        [
          condition({ lastTransitionTime: '2026-08-06T04:00:00.000Z' }),
          resolvedCondition({
            lastTransitionTime: '2026-08-06T05:00:00.000Z',
          }),
        ],
        { managed: true }
      )
    ).toBe('rotate')
  })

  it('returns "rotate" when a NEWER duplicate says SecretMissingKey', () => {
    expect(
      resolveCredentialSurface(
        [
          condition({ lastTransitionTime: '2026-08-06T04:00:00.000Z' }),
          condition({ reason: 'SecretMissingKey', lastTransitionTime: '2026-08-06T05:00:00.000Z' }),
        ],
        { managed: true }
      )
    ).toBe('rotate')
  })

  // Array order must not decide anything: the same pair, reversed.
  it('returns "rotate" when the newer clean duplicate is listed FIRST', () => {
    expect(
      resolveCredentialSurface(
        [
          resolvedCondition({
            lastTransitionTime: '2026-08-06T05:00:00.000Z',
          }),
          condition({ lastTransitionTime: '2026-08-06T04:00:00.000Z' }),
        ],
        { managed: true }
      )
    ).toBe('rotate')
  })

  it('returns "set" when the NEWEST duplicate is the SecretNotFound one', () => {
    expect(
      resolveCredentialSurface(
        [
          resolvedCondition({
            lastTransitionTime: '2026-08-06T04:00:00.000Z',
          }),
          condition({ lastTransitionTime: '2026-08-06T05:00:00.000Z' }),
        ],
        { managed: true }
      )
    ).toBe('set')
  })

  it('returns "recipe-owned" when the newest duplicate is SecretNotFound on a WRC-owned connector', () => {
    expect(
      resolveCredentialSurface(
        [
          resolvedCondition({
            lastTransitionTime: '2026-08-06T04:00:00.000Z',
          }),
          condition({ lastTransitionTime: '2026-08-06T05:00:00.000Z' }),
        ],
        { managed: false }
      )
    ).toBe('recipe-owned')
  })

  // Tie-break rule 3, both orders: an exact timestamp tie is ambiguous, and
  // ambiguity resolves AWAY from absence.
  it('returns "rotate" when contradictory duplicates share the exact same timestamp', () => {
    const same = '2026-08-06T04:00:00.000Z'
    expect(
      resolveCredentialSurface(
        [condition({ lastTransitionTime: same }), resolvedCondition({ lastTransitionTime: same })],
        { managed: true }
      )
    ).toBe('rotate')
    expect(
      resolveCredentialSurface(
        [resolvedCondition({ lastTransitionTime: same }), condition({ lastTransitionTime: same })],
        { managed: true }
      )
    ).toBe('rotate')
  })

  // Tie-break rule 2. An unparseable timestamp carries no recency proof, so it
  // must not let a stale absence claim outrank a well-stamped resolution.
  //
  // DELIBERATELY MALFORMED — not producer output. The HCC always stamps a valid
  // RFC3339 `lastTransitionTime`; these two tests exist for hand-edited or
  // legacy resources, which is the only way such a value reaches the resolver.
  it('returns "rotate" when the SecretNotFound duplicate carries an unparseable timestamp', () => {
    expect(
      resolveCredentialSurface(
        [
          condition({ lastTransitionTime: 'not-a-timestamp' }),
          resolvedCondition({
            lastTransitionTime: '2026-08-06T04:00:00.000Z',
          }),
        ],
        { managed: true }
      )
    ).toBe('rotate')
  })

  it('returns "rotate" when BOTH contradictory duplicates carry unparseable timestamps', () => {
    expect(
      resolveCredentialSurface(
        [
          condition({ lastTransitionTime: '' }),
          resolvedCondition({
            lastTransitionTime: 'whenever',
          }),
        ],
        { managed: true }
      )
    ).toBe('rotate')
  })

  // A LONE absence claim with a malformed timestamp still means "missing":
  // there is nothing contradicting it, so today's behavior is preserved.
  // DELIBERATELY MALFORMED — see above; the HCC never emits this.
  it('returns "set" for a lone SecretNotFound with an unparseable timestamp', () => {
    expect(
      resolveCredentialSurface([condition({ lastTransitionTime: 'not-a-timestamp' })], {
        managed: true,
      })
    ).toBe('set')
  })

  // Unrelated condition types must not participate in the selection at all —
  // not as candidates, and not by shifting array order.
  //
  // The two bracketing entries are SYNTHETIC ADVERSARIES, not producer output:
  // they pair a real `SecretResolved` reason with the WRONG condition type, and
  // carry the NEWEST timestamps in the array. The HCC only ever writes those
  // reasons on `SecretResolved` (reconciler.ts:2039-2046, :1979-1986), so a
  // resolver that dropped the `type` clause and matched on reason alone would
  // pick one of these instead of either real candidate.
  it('ignores unrelated condition types regardless of their position or recency', () => {
    const conditions: McpServerCondition[] = [
      {
        type: 'DeploymentReady',
        status: 'False',
        reason: 'SecretNotFound',
        message: 'noise',
        lastTransitionTime: '2026-08-06T09:00:00.000Z',
      },
      condition({ lastTransitionTime: '2026-08-06T04:00:00.000Z' }),
      {
        type: 'Ready',
        status: 'True',
        reason: 'SecretFound',
        message: 'noise',
        lastTransitionTime: '2026-08-06T09:00:00.000Z',
      },
      resolvedCondition({
        lastTransitionTime: '2026-08-06T05:00:00.000Z',
      }),
    ]
    expect(resolveCredentialSurface(conditions, { managed: true })).toBe('rotate')
    // Same four conditions, reversed: the verdict is order-independent.
    expect(resolveCredentialSurface([...conditions].reverse(), { managed: true })).toBe('rotate')
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
