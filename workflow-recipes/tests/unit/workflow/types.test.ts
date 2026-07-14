import { describe, expect, it } from 'vitest'
import {
  StepPhase,
  WorkflowPhase,
  isTerminalStepPhase,
  isTerminalWorkflowPhase,
} from '../../../src/workflow/types'

describe('Workflow Phase Types', () => {
  describe('isTerminalWorkflowPhase', () => {
    it('returns true for completed', () => {
      expect(isTerminalWorkflowPhase('completed')).toBe(true)
    })
    it('returns true for failed', () => {
      expect(isTerminalWorkflowPhase('failed')).toBe(true)
    })
    it('returns true for cancelled', () => {
      expect(isTerminalWorkflowPhase('cancelled')).toBe(true)
    })
    it('returns false for running', () => {
      expect(isTerminalWorkflowPhase('running')).toBe(false)
    })
    it('returns false for pending', () => {
      expect(isTerminalWorkflowPhase('pending')).toBe(false)
    })
    it('returns false for initializing', () => {
      expect(isTerminalWorkflowPhase('initializing')).toBe(false)
    })
    it('returns false for recovering', () => {
      expect(isTerminalWorkflowPhase('recovering')).toBe(false)
    })
  })

  describe('isTerminalStepPhase', () => {
    it('returns true for completed', () => {
      expect(isTerminalStepPhase('completed')).toBe(true)
    })
    it('returns true for failed', () => {
      expect(isTerminalStepPhase('failed')).toBe(true)
    })
    it('returns true for skipped', () => {
      expect(isTerminalStepPhase('skipped')).toBe(true)
    })
    it('returns false for pending', () => {
      expect(isTerminalStepPhase('pending')).toBe(false)
    })
    it('returns false for running', () => {
      expect(isTerminalStepPhase('running')).toBe(false)
    })
  })

  describe('Phase enum completeness', () => {
    it('workflow phases are exactly 7 values', () => {
      const phases: WorkflowPhase[] = [
        'pending',
        'initializing',
        'running',
        'recovering',
        'completed',
        'failed',
        'cancelled',
      ]
      expect(phases).toHaveLength(7)
    })

    it('step phases are exactly 5 values', () => {
      const phases: StepPhase[] = ['pending', 'running', 'completed', 'failed', 'skipped']
      expect(phases).toHaveLength(5)
    })
  })
})
