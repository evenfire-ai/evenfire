import { describe, expect, it } from 'vitest'
import {
  ADMIN_PASSWORD_KEYS,
  ADMIN_USER_KEYS,
  CONFIRM_MUTATIONS_FLAG,
  collectGateProblems,
  evaluateGateReport,
} from '../../e2e/run-gfs-drag-and-drop.mjs'

/**
 * The EvenDrive drag-and-drop gate is the frontend-owned entry point that
 * makes a missing setup LOUD. These regressions pin the two halves of that
 * contract: the gate refuses to run without the required setup, and it never
 * reads a zero-journey or skipped-journey run as a green result.
 */

const completeSetup = {
  [CONFIRM_MUTATIONS_FLAG]: '1',
  [ADMIN_USER_KEYS[0]]: 'admin',
  [ADMIN_PASSWORD_KEYS[0]]: 'secret-value',
  CONTROL_UI_URL: 'http://127.0.0.1:3100',
  CONTROL_API_URL: 'http://127.0.0.1:8090',
}

describe('EvenDrive drag-and-drop E2E gate', () => {
  describe('required setup', () => {
    it('accepts a complete setup', () => {
      expect(collectGateProblems(completeSetup)).toEqual([])
    })

    it('refuses without the live-fixture mutation opt-in', () => {
      const problems = collectGateProblems({
        ...completeSetup,
        [CONFIRM_MUTATIONS_FLAG]: undefined,
      })
      expect(problems.join('\n')).toContain(CONFIRM_MUTATIONS_FLAG)
    })

    it('refuses without an admin username', () => {
      const env = { ...completeSetup }
      for (const key of ADMIN_USER_KEYS) delete env[key]
      expect(collectGateProblems(env).join('\n')).toContain('admin username')
    })

    it('refuses without an admin password', () => {
      const env = { ...completeSetup }
      for (const key of ADMIN_PASSWORD_KEYS) delete env[key]
      expect(collectGateProblems(env).join('\n')).toContain('admin password')
    })

    it('refuses a non-loopback target unless the remote opt-in is set', () => {
      const problems = collectGateProblems({
        ...completeSetup,
        CONTROL_API_URL: 'https://api.example.test',
      })
      expect(problems.join('\n')).toContain('QA_RECORDER_ALLOW_REMOTE')
    })

    it('accepts a non-loopback target with the remote opt-in', () => {
      expect(
        collectGateProblems({
          ...completeSetup,
          CONTROL_API_URL: 'https://api.example.test',
          QA_RECORDER_ALLOW_REMOTE: '1',
        })
      ).toEqual([])
    })

    it('reports every missing piece at once instead of the first one', () => {
      const problems = collectGateProblems({})
      expect(problems.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('run verdict', () => {
    it('treats a run that executed zero journeys as a failure', () => {
      const verdict = evaluateGateReport({ stats: { expected: 0, skipped: 7, unexpected: 0 } })
      expect(verdict.problems.join('\n')).toContain('executed zero journeys')
    })

    it('treats a skipped journey as a failure', () => {
      const verdict = evaluateGateReport({ stats: { expected: 3, skipped: 1, unexpected: 0 } })
      expect(verdict.problems.join('\n')).toContain('skipped')
    })

    it('treats a failed journey as a failure', () => {
      const verdict = evaluateGateReport({ stats: { expected: 3, skipped: 0, unexpected: 1 } })
      expect(verdict.problems.join('\n')).toContain('failed')
    })

    it('accepts a clean run', () => {
      const verdict = evaluateGateReport({ stats: { expected: 7, skipped: 0, unexpected: 0 } })
      expect(verdict.problems).toEqual([])
      expect(verdict.stats.expected).toBe(7)
    })

    it('treats a missing report as a failure', () => {
      expect(evaluateGateReport(undefined).problems.join('\n')).toContain('executed zero journeys')
    })
  })
})
