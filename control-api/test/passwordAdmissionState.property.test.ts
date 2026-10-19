import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  admitPasswordIdentifier,
  finishPasswordState,
  passwordIdentifierKey,
  PASSWORD_ADMISSION_POLICY as policy,
} from '../src/services/auth/passwordAdmissionState.js'

describe('Spec 043 state-transition design invariants', () => {
  it('makes real/shadow state transitions identical and denies without extending', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: policy.windowMs * 3 }), { maxLength: 100 }),
        times => {
          const sorted = times.sort((a, b) => a - b)
          let real = { attempts: [] as number[], failures: [] as number[], lockedUntil: 0 }
          let shadow = structuredClone(real)
          for (const now of sorted) {
            const a = admitPasswordIdentifier(real, now, true),
              b = admitPasswordIdentifier(shadow, now, true)
            expect(a).toEqual(b)
            if (a.retryMs) {
              expect(a.state.attempts.every(t => real.attempts.includes(t))).toBe(true)
              expect(a.state.lockedUntil).toBeLessThanOrEqual(real.lockedUntil)
              real = a.state
              shadow = b.state
            } else {
              real = finishPasswordState(a.state, now, false)
              shadow = finishPasswordState(b.state, now, false)
            }
            expect(real).toEqual(shadow)
            expect(real.attempts.length).toBeLessThanOrEqual(5)
            expect(real.failures.length).toBeLessThanOrEqual(5)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })
  it('sets exactly one cooldown at the fifth failed evaluation and clears on success', () => {
    let state = { attempts: [] as number[], failures: [] as number[], lockedUntil: 0 }
    for (let i = 0; i < 5; i++) state = finishPasswordState(state, i * 10000, false)
    expect(state.lockedUntil).toBe(40000 + policy.cooldownMs)
    expect(finishPasswordState(state, 50000, false).lockedUntil).toBe(state.lockedUntil)
    expect(finishPasswordState(state, 50000, true)).toMatchObject({ failures: [], lockedUntil: 0 })
    expect(admitPasswordIdentifier(state, state.lockedUntil, true).retryMs).toBe(0)
  })
  it('canonicalizes keys without retaining the submitted identity', () => {
    expect(passwordIdentifierKey(' MEMBER@Example.Invalid ')).toBe(
      passwordIdentifierKey('member@example.invalid')
    )
    expect(passwordIdentifierKey('member@example.invalid')).toMatch(/^[0-9a-f]{64}$/)
  })
})
