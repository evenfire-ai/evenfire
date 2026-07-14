import { describe, expect, it } from 'vitest'
import { RecipePhase } from '../types'
import { InvalidTransitionError, getValidTransitions, isTerminal, transition } from './stateMachine'

describe('stateMachine.transition', () => {
  // ─── Valid Transitions (Happy Path) ────────────────────────────────

  it('candidate → approve → approved (2.1a)', () => {
    expect(transition('candidate', 'approve')).toBe('approved')
  })

  it('candidate → request-approval → pending-approval (2.1b)', () => {
    expect(transition('candidate', 'request-approval')).toBe('pending-approval')
  })

  it('approved → deploy → deploying (2.1c)', () => {
    expect(transition('approved', 'deploy')).toBe('deploying')
  })

  it('deploying → test-pass → testing (2.1d)', () => {
    expect(transition('deploying', 'test-pass')).toBe('testing')
  })

  it('testing → success → active (CRITICAL) (2.1e)', () => {
    expect(transition('testing', 'success')).toBe('active')
  })

  it('active → degrade → degraded (2.1f)', () => {
    expect(transition('active', 'degrade')).toBe('degraded')
  })

  it('degraded → recover → active (2.1g)', () => {
    expect(transition('degraded', 'recover')).toBe('active')
  })

  it('active → rollback → rolling-back (2.1h)', () => {
    expect(transition('active', 'rollback')).toBe('rolling-back')
  })

  it('rolling-back → rollback-success → candidate (retry after successful rollback)', () => {
    expect(transition('rolling-back', 'rollback-success')).toBe('candidate')
  })

  it('rolling-back → fail → failed (2.1i)', () => {
    expect(transition('rolling-back', 'fail')).toBe('failed')
  })

  it('rolling-back → critical-fail → rollback-failed (terminal) (2.1j)', () => {
    expect(transition('rolling-back', 'critical-fail')).toBe('rollback-failed')
  })

  it('failed → retry → candidate (retry loop) (2.1k)', () => {
    expect(transition('failed', 'retry')).toBe('candidate')
  })

  it('pending-approval → approve → approved', () => {
    expect(transition('pending-approval', 'approve')).toBe('approved')
  })

  it('pending-approval → deprecate → deprecated', () => {
    expect(transition('pending-approval', 'deprecate')).toBe('deprecated')
  })

  it('approved → queue → pending', () => {
    expect(transition('approved', 'queue')).toBe('pending')
  })

  it('approved → request-input → pending-operator-input', () => {
    expect(transition('approved', 'request-input')).toBe('pending-operator-input')
  })

  it('pending → deploy → deploying', () => {
    expect(transition('pending', 'deploy')).toBe('deploying')
  })

  it('pending-operator-input → deploy → deploying', () => {
    expect(transition('pending-operator-input', 'deploy')).toBe('deploying')
  })

  it('deploying → degrade → degraded', () => {
    expect(transition('deploying', 'degrade')).toBe('degraded')
  })

  it('deploying → rollback → rolling-back', () => {
    expect(transition('deploying', 'rollback')).toBe('rolling-back')
  })

  it('active → deprecate → deprecated', () => {
    expect(transition('active', 'deprecate')).toBe('deprecated')
  })

  it('degraded → rollback → rolling-back', () => {
    expect(transition('degraded', 'rollback')).toBe('rolling-back')
  })

  it('degraded → fail → failed', () => {
    expect(transition('degraded', 'fail')).toBe('failed')
  })

  it('testing → fail → rolling-back (Spec §12.1: test failure triggers rollback)', () => {
    expect(transition('testing', 'fail')).toBe('rolling-back')
  })

  // ─── Terminal States Reject All (2.2) ──────────────────────────────

  it('deprecated rejects all actions (terminal) (2.2a)', () => {
    expect(() => transition('deprecated', 'approve')).toThrow(InvalidTransitionError)
    expect(() => transition('deprecated', 'deploy')).toThrow(InvalidTransitionError)
    expect(() => transition('deprecated', 'retry')).toThrow(InvalidTransitionError)
  })

  it('rollback-failed rejects all actions (terminal) (2.2b)', () => {
    expect(() => transition('rollback-failed', 'approve')).toThrow(InvalidTransitionError)
    expect(() => transition('rollback-failed', 'retry')).toThrow(InvalidTransitionError)
  })

  // ─── Invalid Transitions (2.2c-d) ─────────────────────────────────

  it('candidate cannot rollback (2.2c)', () => {
    expect(() => transition('candidate', 'rollback')).toThrow(InvalidTransitionError)
  })

  it('testing cannot rollback (2.2d)', () => {
    expect(() => transition('testing', 'rollback')).toThrow(InvalidTransitionError)
  })

  it('candidate cannot deploy directly', () => {
    expect(() => transition('candidate', 'deploy')).toThrow(InvalidTransitionError)
  })

  it('InvalidTransitionError has correct properties', () => {
    try {
      transition('candidate', 'deploy')
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError)
      const err = e as InvalidTransitionError
      expect(err.from).toBe('candidate')
      expect(err.action).toBe('deploy')
      expect(err.message).toContain('candidate')
      expect(err.message).toContain('deploy')
    }
  })
})

describe('stateMachine.getValidTransitions', () => {
  it('active has 3 valid actions (2.3a)', () => {
    const actions = getValidTransitions('active')
    expect(actions).toHaveLength(3)
    expect(actions).toContain('deprecate')
    expect(actions).toContain('degrade')
    expect(actions).toContain('rollback')
  })

  it('deprecated has no valid actions (2.3b)', () => {
    expect(getValidTransitions('deprecated')).toEqual([])
  })

  it('rollback-failed has no valid actions', () => {
    expect(getValidTransitions('rollback-failed')).toEqual([])
  })

  it('candidate has 2 valid actions', () => {
    expect(getValidTransitions('candidate')).toHaveLength(2)
  })
})

describe('stateMachine.isTerminal', () => {
  it('deprecated is terminal (2.3c)', () => {
    expect(isTerminal('deprecated')).toBe(true)
  })

  it('rollback-failed is terminal', () => {
    expect(isTerminal('rollback-failed')).toBe(true)
  })

  it('active is not terminal (2.3d)', () => {
    expect(isTerminal('active')).toBe(false)
  })

  it('failed is not terminal (has retry)', () => {
    expect(isTerminal('failed')).toBe(false)
  })

  it('all 13 phases are covered as transition origins (2.4a-f)', () => {
    const allPhases: RecipePhase[] = [
      'candidate',
      'pending-approval',
      'approved',
      'pending',
      'pending-operator-input',
      'deploying',
      'testing',
      'active',
      'degraded',
      'rolling-back',
      'failed',
      'deprecated',
      'rollback-failed',
    ]
    for (const phase of allPhases) {
      // getValidTransitions should not throw for any valid phase
      expect(() => getValidTransitions(phase)).not.toThrow()
    }
    expect(allPhases).toHaveLength(13)
  })
})
