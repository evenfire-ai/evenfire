import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type PasswordIdentifierState,
  evaluatePasswordAdmission,
  finishPasswordState,
  passwordIdentifierKey,
  PASSWORD_ADMISSION_POLICY as policy,
  settledPasswordState,
} from '../src/services/auth/passwordAdmissionState.js'

const empty = (): PasswordIdentifierState => ({
  attempts: [],
  failures: [],
  successes: [],
  uncertain: [],
  lockedUntil: 0,
  legacyHoldUntil: 0,
  provisional: null,
})

describe('Spec 092 outcome-based password admission properties', () => {
  it('never admits a sixth potential failure or a second provisional operation', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: policy.windowMs * 3 }), fc.boolean()), {
          maxLength: 100,
        }),
        events => {
          let state = empty()
          for (const [now, correct] of events.sort((a, b) => a[0] - b[0])) {
            const decision = evaluatePasswordAdmission(state, now, 'public_login')
            if (decision.retryMs) {
              state = decision.state
              continue
            }
            const reservesFailure = true
            const afterReservation = {
              ...decision.state,
              provisional: {
                operation: `${now}`,
                phase: 'running' as const,
                expiresAt: now + policy.evaluationMs,
              },
            }
            expect(
              afterReservation.failures.length +
                afterReservation.uncertain.length +
                Number(reservesFailure)
            ).toBeLessThanOrEqual(policy.failures)
            expect(afterReservation.provisional).not.toBeNull()
            const second = evaluatePasswordAdmission(afterReservation, now, 'public_login')
            expect(second.retryMs).toBeGreaterThan(0)
            state = finishPasswordState(afterReservation, now, {
              outcome: decision.quotaMasked ? 'failure' : correct ? 'success' : 'failure',
              scope: 'public_login',
            })
            state.provisional = null
          }
        }
      ),
      { numRuns: 10_000 }
    )
  })

  it('keeps a success separate from prior failures and starts cooldown on the fifth failure', () => {
    let state = empty()
    for (let i = 0; i < 4; i++)
      state = finishPasswordState(state, i * 1000, {
        outcome: 'failure',
        scope: 'public_login',
      })
    const beforeSuccess = state.failures.slice()
    state = finishPasswordState(state, 5_000, {
      outcome: 'success',
      scope: 'public_login',
    })
    expect(state.failures).toEqual(beforeSuccess)
    expect(state.successes).toEqual([5_000])
    state = finishPasswordState(state, 6_000, {
      outcome: 'failure',
      scope: 'public_login',
    })
    expect(state.lockedUntil).toBe(6_000 + policy.cooldownMs)
    expect(evaluatePasswordAdmission(state, 7_000, 'public_login')).toMatchObject({
      retryMs: policy.cooldownMs - 1_000,
      reason: 'identifier_cooldown',
    })
  })

  it('masks every public request after forty successes and expires the rolling boundary exactly', () => {
    const state = empty()
    state.successes = Array.from({ length: 40 }, (_, i) => 1_000 + i)
    const full = evaluatePasswordAdmission(state, 2_000, 'public_login')
    expect(full).toMatchObject({ retryMs: 0, quotaMasked: true, reservesPublicSuccess: false })
    expect(evaluatePasswordAdmission(state, 2_000, 'authenticated_reverification')).toMatchObject({
      retryMs: 0,
      quotaMasked: false,
      reservesPublicSuccess: false,
    })
    const expired = settledPasswordState(state, 900_000 + 1_000 + policy.windowMs)
    expect(expired.successes).toHaveLength(0)
    expect(
      evaluatePasswordAdmission(expired, 900_000 + 1_000 + policy.windowMs, 'public_login')
    ).toMatchObject({ quotaMasked: false, reservesPublicSuccess: true })
  })

  it('expires the oldest success only at the exact open-window boundary', () => {
    const state = empty()
    state.successes = Array.from({ length: 40 }, (_, index) => 10_000 + index)
    const oneMillisecondBefore = evaluatePasswordAdmission(
      state,
      10_000 + policy.windowMs - 1,
      'public_login'
    )
    expect(oneMillisecondBefore).toMatchObject({ quotaMasked: true, reservesPublicSuccess: false })

    const atBoundary = evaluatePasswordAdmission(state, 10_000 + policy.windowMs, 'public_login')
    expect(atBoundary.state.successes).toHaveLength(39)
    expect(atBoundary).toMatchObject({ quotaMasked: false, reservesPublicSuccess: true })
  })

  it('does not extend cooldown or risk history on denial and distinguishes uncertainty from failure', () => {
    const state = empty()
    state.failures = [1, 2, 3, 4]
    state.uncertain = [5]
    const before = structuredClone(state)
    const denied = evaluatePasswordAdmission(state, 6, 'public_login')
    expect(denied).toMatchObject({ retryMs: 899_995, reason: 'identifier_attempts' })
    expect(denied.state).toEqual(before)
    expect(denied.state.failures).toHaveLength(4)
    expect(denied.state.uncertain).toHaveLength(1)
  })

  it('preserves operation lifecycle invariants across randomized recovery and cleanup schedules', () => {
    type Operation = {
      id: string
      phase: 'reserved' | 'running'
      generation: number
      scope: 'public_login' | 'authenticated_reverification'
      quotaMasked: boolean
      reservesPublicSuccess: boolean
      expiresAt: number
    }
    type Action = {
      kind:
        | 'reserve'
        | 'start'
        | 'cancel'
        | 'complete_success'
        | 'complete_failure'
        | 'complete_uncertain'
        | 'recover'
        | 'generation_change'
        | 'cleanup'
        | 'replay'
      advanceMs: number
      scope: 'public_login' | 'authenticated_reverification'
      proof: boolean
      recoveryDisposition: 'failure' | 'success' | 'prestart' | 'uncertain' | 'invalid' | null
    }

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom<Action['kind']>(
              'reserve',
              'start',
              'cancel',
              'complete_success',
              'complete_failure',
              'complete_uncertain',
              'recover',
              'generation_change',
              'cleanup',
              'replay'
            ),
            advanceMs: fc.integer({ min: 0, max: policy.windowMs }),
            scope: fc.constantFrom<Action['scope']>('public_login', 'authenticated_reverification'),
            proof: fc.boolean(),
            recoveryDisposition: fc.constantFrom<Action['recoveryDisposition']>(
              'failure',
              'success',
              'prestart',
              'uncertain',
              'invalid',
              null
            ),
          }),
          { maxLength: 150 }
        ),
        actions => {
          let state = empty()
          let operation: Operation | null = null
          let generation = 1
          let now = 0
          let sequence = 0
          let terminalReceipt: { id: string; disposition: string } | null = null
          const commitTerminal = (
            operationId: string,
            requestedDisposition: 'success' | 'failure' | 'uncertain' | 'stale' | 'cancelled',
            recoveryProven = false
          ) => {
            if (terminalReceipt?.id === operationId) return false
            if (!operation || operation.id !== operationId || operation.phase !== 'running')
              return false

            const disposition =
              operation.generation !== generation || (!recoveryProven && now >= operation.expiresAt)
                ? 'stale'
                : requestedDisposition
            if (
              disposition === 'success' ||
              disposition === 'failure' ||
              disposition === 'uncertain'
            ) {
              state = finishPasswordState(state, now, {
                outcome: disposition,
                scope: operation.scope,
                reservesPublicSuccess: operation.reservesPublicSuccess,
              })
            }
            terminalReceipt = { id: operation.id, disposition }
            operation = null
            state.provisional = null
            return true
          }

          for (const action of actions) {
            now += action.advanceMs

            if (action.kind === 'reserve') {
              if (operation?.phase === 'reserved' && operation.expiresAt <= now) {
                terminalReceipt = { id: operation.id, disposition: 'cancelled' }
                operation = null
              }
              const decision = evaluatePasswordAdmission(state, now, action.scope)
              state = decision.state
              if (decision.retryMs === 0) {
                const id = `operation-${sequence++}`
                operation = {
                  id,
                  phase: 'reserved',
                  generation,
                  scope: action.scope,
                  quotaMasked: decision.quotaMasked,
                  reservesPublicSuccess: decision.reservesPublicSuccess,
                  expiresAt: now + policy.evaluationMs,
                }
                state = {
                  ...decision.state,
                  provisional: { operation: id, phase: 'reserved', expiresAt: operation.expiresAt },
                }
              }
            } else if (action.kind === 'start') {
              if (operation?.phase === 'reserved' && now < operation.expiresAt) {
                operation = { ...operation, phase: 'running' }
                state.provisional = {
                  operation: operation.id,
                  phase: 'running',
                  expiresAt: operation.expiresAt,
                }
              }
            } else if (action.kind === 'cancel') {
              if (
                operation?.phase === 'reserved' ||
                (operation?.phase === 'running' && action.proof)
              ) {
                terminalReceipt = { id: operation.id, disposition: 'cancelled' }
                operation = null
                state.provisional = null
              }
            } else if (
              action.kind === 'complete_success' ||
              action.kind === 'complete_failure' ||
              action.kind === 'complete_uncertain'
            ) {
              if (operation?.phase === 'running') {
                const disposition =
                  operation.quotaMasked && action.kind === 'complete_success'
                    ? 'failure'
                    : action.kind === 'complete_success'
                      ? 'success'
                      : action.kind === 'complete_failure'
                        ? 'failure'
                        : 'uncertain'
                commitTerminal(operation.id, disposition)
              }
            } else if (action.kind === 'recover') {
              const recoveryDisposition = action.recoveryDisposition
              const validDisposition =
                recoveryDisposition === 'failure' ||
                recoveryDisposition === 'success' ||
                recoveryDisposition === 'prestart' ||
                recoveryDisposition === 'uncertain'
              if (
                operation?.phase === 'running' &&
                action.proof &&
                validDisposition &&
                !(operation.quotaMasked && recoveryDisposition === 'success')
              ) {
                const disposition =
                  recoveryDisposition === 'prestart'
                    ? 'cancelled'
                    : recoveryDisposition === 'success'
                      ? 'success'
                      : recoveryDisposition === 'failure'
                        ? 'failure'
                        : 'uncertain'
                commitTerminal(operation.id, disposition, true)
              }
            } else if (action.kind === 'generation_change') {
              generation += 1
              state.failures = []
              state.uncertain = []
              state.lockedUntil = 0
              if (operation?.phase === 'reserved') {
                terminalReceipt = { id: operation.id, disposition: 'stale' }
                operation = null
                state.provisional = null
              }
            } else if (action.kind === 'cleanup') {
              const settled = settledPasswordState(state, now)
              if (operation?.phase === 'reserved' && operation.expiresAt <= now) {
                terminalReceipt = { id: operation.id, disposition: 'cancelled' }
                operation = null
              }
              state = settled
              state.provisional = operation
                ? {
                    operation: operation.id,
                    phase: operation.phase,
                    expiresAt: operation.expiresAt,
                  }
                : null
            } else if (action.kind === 'replay' && terminalReceipt) {
              const before = structuredClone(state)
              const receiptBefore = structuredClone(terminalReceipt)
              const replayAccepted = commitTerminal(
                terminalReceipt.id,
                terminalReceipt.disposition as
                  | 'success'
                  | 'failure'
                  | 'uncertain'
                  | 'stale'
                  | 'cancelled'
              )
              expect(replayAccepted).toBe(false)
              expect(state).toEqual(before)
              expect(terminalReceipt).toEqual(receiptBefore)
            }

            const settled = settledPasswordState(state, now)
            const hasLiveReservation =
              !!operation && (operation.phase === 'running' || operation.expiresAt > now)
            const activeRisk =
              settled.failures.length + settled.uncertain.length + Number(hasLiveReservation)
            expect(activeRisk).toBeLessThanOrEqual(policy.failures)
            expect(settled.successes.length).toBeLessThanOrEqual(policy.successesPerIdentifier)
            expect(Boolean(operation)).toBe(Boolean(state.provisional))
            if (operation) {
              expect(state.provisional).toMatchObject({
                operation: operation.id,
                phase: operation.phase,
              })
              if (operation.phase === 'running' && now >= operation.expiresAt) {
                expect(state.provisional).not.toBeNull()
              }
            }
          }
        }
      ),
      { numRuns: 5_000 }
    )
  })

  it('canonicalizes identity keys without retaining the submitted email', () => {
    expect(passwordIdentifierKey(' MEMBER@Example.Invalid ')).toBe(
      passwordIdentifierKey('member@example.invalid')
    )
    expect(passwordIdentifierKey('member@example.invalid')).toMatch(/^[0-9a-f]{64}$/)
  })
})
