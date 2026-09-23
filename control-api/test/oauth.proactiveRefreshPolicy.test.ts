/**
 * Pure decision layer for the proactive refresh + DCR lifecycle sweep
 * (mini-spec L §4/§5). Property-based (T2) plus the exact table cases (P1–P7,
 * C1–C5) and the `getAccessToken` result mapping.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  classifyDcrSecretDecision,
  classifyProactiveTokenDecision,
  resultToOutcome,
} from '../src/oauth/proactiveRefreshPolicy.js'
import type { GetAccessTokenResult } from '../src/oauth/tokenHelper.js'

const NOW = 1_700_000_000_000
const BR = 60_000 // reactive buffer
const BP = 300_000 // proactive buffer (Bp > Br)

const at = (offsetMs: number) => new Date(NOW + offsetMs)

describe('classifyProactiveTokenDecision — §4 table cases', () => {
  const eligible = { hasRefreshToken: true, supportsRefresh: true, eligibleForBackground: true }

  it('P1 NULL expiry → noop (no computable threshold)', () => {
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: null }, NOW, BP, BR)
    ).toEqual({ kind: 'noop', reason: 'null_expiry' })
  })

  it('P2 healthy (remaining > Bp) → noop', () => {
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: at(BP + 1) }, NOW, BP, BR)
    ).toEqual({ kind: 'noop', reason: 'healthy' })
  })

  it('P3 in-window, refreshable → refresh (inclusive upper bound Bp)', () => {
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: at(BP) }, NOW, BP, BR)
    ).toEqual({ kind: 'refresh' })
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: at(BR + 1) }, NOW, BP, BR)
    ).toEqual({ kind: 'refresh' })
  })

  it('P4 in-window, supportsRefresh=false → reconsent_imminent (fail-closed, no refresh)', () => {
    expect(
      classifyProactiveTokenDecision(
        { ...eligible, supportsRefresh: false, accessTokenExpiresAt: at(BP) },
        NOW,
        BP,
        BR
      )
    ).toEqual({ kind: 'reconsent_imminent', reason: 'no_refresh_support' })
  })

  it('P5 in-window, no refresh token → reconsent_imminent', () => {
    expect(
      classifyProactiveTokenDecision(
        { ...eligible, hasRefreshToken: false, accessTokenExpiresAt: at(BP) },
        NOW,
        BP,
        BR
      )
    ).toEqual({ kind: 'reconsent_imminent', reason: 'no_refresh_token' })
  })

  it('P6 already expired (remaining ≤ 0) → noop (not proactive work)', () => {
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: at(0) }, NOW, BP, BR)
    ).toEqual({ kind: 'noop', reason: 'expired' })
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: at(-1) }, NOW, BP, BR)
    ).toEqual({ kind: 'noop', reason: 'expired' })
  })

  it('P7 not eligible for background → noop, whatever else holds (the "cualquiera" gate)', () => {
    expect(
      classifyProactiveTokenDecision(
        { ...eligible, eligibleForBackground: false, accessTokenExpiresAt: at(BP) },
        NOW,
        BP,
        BR
      )
    ).toEqual({ kind: 'noop', reason: 'not_eligible' })
  })

  it('reactive window (0 < remaining ≤ Br) is left to the reactive path → noop', () => {
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: at(BR) }, NOW, BP, BR)
    ).toEqual({ kind: 'noop', reason: 'reactive_window' })
    expect(
      classifyProactiveTokenDecision({ ...eligible, accessTokenExpiresAt: at(1) }, NOW, BP, BR)
    ).toEqual({ kind: 'noop', reason: 'reactive_window' })
  })
})

describe('classifyProactiveTokenDecision — properties (T2)', () => {
  interface ArbInput {
    offsetMs: number | null
    hasRefreshToken: boolean
    supportsRefresh: boolean
    eligibleForBackground: boolean
  }
  const arbInput: fc.Arbitrary<ArbInput> = fc.record({
    offsetMs: fc.oneof(fc.constant<null>(null), fc.integer({ min: -1_000_000, max: 1_000_000 })),
    hasRefreshToken: fc.boolean(),
    supportsRefresh: fc.boolean(),
    eligibleForBackground: fc.boolean(),
  })
  // Bp > Br always (config invariant): br in range, bp = br + delta.
  const arbBuffers = fc
    .tuple(fc.integer({ min: 1, max: 500_000 }), fc.integer({ min: 1, max: 500_000 }))
    .map(([br, delta]) => ({ br, bp: br + delta }))

  const build = (i: ArbInput) => ({
    accessTokenExpiresAt: i.offsetMs === null ? null : at(i.offsetMs),
    hasRefreshToken: i.hasRefreshToken,
    supportsRefresh: i.supportsRefresh,
    eligibleForBackground: i.eligibleForBackground,
  })

  it('never refreshes outside the strict proactive window, and only when fully refreshable', () => {
    fc.assert(
      fc.property(arbInput, arbBuffers, (i, { bp, br }) => {
        const input = build(i)
        const d = classifyProactiveTokenDecision(input, NOW, bp, br)
        if (d.kind !== 'refresh') return
        expect(input.accessTokenExpiresAt).not.toBeNull()
        const remaining = (input.accessTokenExpiresAt as Date).getTime() - NOW
        expect(remaining).toBeGreaterThan(br)
        expect(remaining).toBeLessThanOrEqual(bp)
        expect(input.eligibleForBackground).toBe(true)
        expect(input.supportsRefresh).toBe(true)
        expect(input.hasRefreshToken).toBe(true)
      })
    )
  })

  it('remaining ≤ 0 is never a refresh', () => {
    fc.assert(
      fc.property(arbInput, arbBuffers, (i, { bp, br }) => {
        const input = build(i)
        if (input.accessTokenExpiresAt === null) return
        if (input.accessTokenExpiresAt.getTime() - NOW > 0) return
        expect(classifyProactiveTokenDecision(input, NOW, bp, br).kind).not.toBe('refresh')
      })
    )
  })

  it('idempotence: after a simulated full-life refresh, reclassifying is a noop', () => {
    fc.assert(
      fc.property(arbInput, arbBuffers, (i, { bp, br }) => {
        const input = build(i)
        const first = classifyProactiveTokenDecision(input, NOW, bp, br)
        if (first.kind !== 'refresh') return
        // A successful refresh pushes expiry a full life into the future (>> Bp).
        const renewed = { ...input, accessTokenExpiresAt: at(bp * 10 + 1) }
        expect(classifyProactiveTokenDecision(renewed, NOW, bp, br)).toEqual({
          kind: 'noop',
          reason: 'healthy',
        })
      })
    )
  })
})

describe('resultToOutcome — §4 result mapping', () => {
  const cases: [GetAccessTokenResult, string][] = [
    [{ kind: 'ok', accessToken: 'X' }, 'ok'],
    [{ kind: 'no_grant' }, 'no_grant'],
    [{ kind: 'refresh_failed', status: 400, detail: '' }, 'client_invalid'],
    [{ kind: 'refresh_failed', status: 401, detail: '' }, 'client_invalid'],
    [{ kind: 'refresh_failed', status: 500, detail: '' }, 'transient'],
    [{ kind: 'refresh_failed', detail: 'timeout' }, 'transient'],
    [{ kind: 'recipe_not_found' }, 'error'],
    [{ kind: 'unknown_oauth_client' }, 'error'],
    [{ kind: 'unsupported_provider', provider: 'x' }, 'error'],
    [{ kind: 'secret_missing', secret: 's' }, 'error'],
  ]
  it.each(cases)('%o → %s', (result, expected) => {
    expect(resultToOutcome(result)).toBe(expected)
  })
})

describe('classifyDcrSecretDecision — §5 table cases', () => {
  const WC = 7 * 24 * 60 * 60 * 1000

  it('C1 public → noop', () => {
    expect(
      classifyDcrSecretDecision({ clientMode: 'public', clientSecretExpiresAt: at(1000) }, NOW, WC)
    ).toEqual({ kind: 'noop', reason: 'public' })
  })

  it('C2 confidential, NULL expiry → noop', () => {
    expect(
      classifyDcrSecretDecision(
        { clientMode: 'confidential', clientSecretExpiresAt: null },
        NOW,
        WC
      )
    ).toEqual({ kind: 'noop', reason: 'no_expiry' })
  })

  it('C3 healthy (exp > now + Wc) → noop', () => {
    expect(
      classifyDcrSecretDecision(
        { clientMode: 'confidential', clientSecretExpiresAt: at(WC + 1) },
        NOW,
        WC
      )
    ).toEqual({ kind: 'noop', reason: 'healthy' })
  })

  it('C4 expiring (now < exp ≤ now + Wc) → warn', () => {
    expect(
      classifyDcrSecretDecision(
        { clientMode: 'confidential', clientSecretExpiresAt: at(WC) },
        NOW,
        WC
      )
    ).toEqual({ kind: 'warn' })
    expect(
      classifyDcrSecretDecision(
        { clientMode: 'confidential', clientSecretExpiresAt: at(1) },
        NOW,
        WC
      )
    ).toEqual({ kind: 'warn' })
  })

  it('C5 expired (exp ≤ now) → expired', () => {
    expect(
      classifyDcrSecretDecision(
        { clientMode: 'confidential', clientSecretExpiresAt: at(0) },
        NOW,
        WC
      )
    ).toEqual({ kind: 'expired' })
    expect(
      classifyDcrSecretDecision(
        { clientMode: 'confidential', clientSecretExpiresAt: at(-1) },
        NOW,
        WC
      )
    ).toEqual({ kind: 'expired' })
  })

  it('monotonicity: a later expiry is never more severe than an earlier one', () => {
    const severity = (d: ReturnType<typeof classifyDcrSecretDecision>) =>
      d.kind === 'expired' ? 2 : d.kind === 'warn' ? 1 : 0
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (o1, o2, wc) => {
          const [earlier, later] = o1 <= o2 ? [o1, o2] : [o2, o1]
          const sEarlier = severity(
            classifyDcrSecretDecision(
              { clientMode: 'confidential', clientSecretExpiresAt: at(earlier) },
              NOW,
              wc
            )
          )
          const sLater = severity(
            classifyDcrSecretDecision(
              { clientMode: 'confidential', clientSecretExpiresAt: at(later) },
              NOW,
              wc
            )
          )
          expect(sLater).toBeLessThanOrEqual(sEarlier)
        }
      )
    )
  })
})
