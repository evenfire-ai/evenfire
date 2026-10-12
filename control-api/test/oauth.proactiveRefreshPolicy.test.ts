/**
 * Pure decision helpers for the proactive refresh + DCR lifecycle sweep
 * (mini-spec L §4/§5): the `getAccessToken` result mapping (§4) and the DCR
 * secret warn/expire table (C1–C5, §5, property-based per T2). The proactive
 * candidate selection is NOT here — it is the SQL `WHERE` of
 * `listRemoteGrantsInProactiveWindow` plus `getAccessToken`'s staleness check.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { classifyDcrSecretDecision, resultToOutcome } from '../src/oauth/proactiveRefreshPolicy.js'
import type { GetAccessTokenResult } from '../src/oauth/tokenHelper.js'

const NOW = 1_700_000_000_000

const at = (offsetMs: number) => new Date(NOW + offsetMs)

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
