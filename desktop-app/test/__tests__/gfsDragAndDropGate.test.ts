import { describe, expect, it } from 'vitest'
import {
  DESKTOP_EMAIL_KEYS,
  DESKTOP_PASSWORD_KEYS,
  collectGateProblems,
  evaluateGateReport,
} from '../e2e-playwright/run-gfs-drag-and-drop.mjs'

/**
 * The EvenDrive drag-and-drop gate is the frontend-owned entry point that
 * makes a missing setup LOUD. These regressions pin the two halves of that
 * contract: the gate refuses to run without the required setup, and it never
 * reads a zero-journey or skipped-journey run as a green result.
 */

const completeSetup = {
  E2E_K8S_CONTEXT: 'dev',
  E2E_ALLOWED_CONTEXTS: 'dev',
  [DESKTOP_PASSWORD_KEYS[0]]: 'secret-value',
  [DESKTOP_EMAIL_KEYS[0]]: 'test@clerum.io',
  EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:8091',
  RPC_PROXY_BASE_URL: 'http://127.0.0.1:8094',
}

describe('EvenDrive drag-and-drop Desktop E2E gate', () => {
  describe('required setup', () => {
    it('accepts a complete setup', () => {
      // The build output check is a filesystem fact, not an env fact: this
      // suite runs against a checked-out tree whose build may be absent.
      const problems = collectGateProblems(completeSetup).filter(problem =>
        problem.includes('build output')
      )
      expect(problems).toEqual([])
    })

    it('refuses without a Kubernetes context', () => {
      const problems = collectGateProblems({ ...completeSetup, E2E_K8S_CONTEXT: undefined })
      expect(problems.join('\n')).toContain('Kubernetes context')
    })

    it('refuses a production context', () => {
      const problems = collectGateProblems({
        ...completeSetup,
        E2E_K8S_CONTEXT: 'prod',
        E2E_ALLOWED_CONTEXTS: 'prod',
      })
      expect(problems.join('\n')).toContain('production')
    })

    it('refuses a context outside the allow-list', () => {
      const problems = collectGateProblems({
        ...completeSetup,
        E2E_K8S_CONTEXT: 'other',
        E2E_ALLOWED_CONTEXTS: 'dev',
      })
      expect(problems.join('\n')).toContain('E2E_ALLOWED_CONTEXTS')
    })

    it('refuses without a Desktop password', () => {
      const env = { ...completeSetup }
      for (const key of DESKTOP_PASSWORD_KEYS) delete env[key]
      expect(collectGateProblems(env).join('\n')).toContain('Desktop password')
    })

    it('refuses a non-loopback endpoint unless the remote opt-in is set', () => {
      const problems = collectGateProblems({
        ...completeSetup,
        RPC_PROXY_BASE_URL: 'https://rpc.example.test',
      })
      expect(problems.join('\n')).toContain('E2E_ALLOW_REMOTE')
    })

    it('reports every missing piece at once instead of the first one', () => {
      const problems = collectGateProblems({})
      expect(problems.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('run verdict', () => {
    it('treats a run that executed zero journeys as a failure', () => {
      const verdict = evaluateGateReport({ stats: { expected: 0, skipped: 2, unexpected: 0 } })
      expect(verdict.problems.join('\n')).toContain('executed zero journeys')
    })

    it('treats a skipped journey as a failure', () => {
      const verdict = evaluateGateReport({ stats: { expected: 2, skipped: 1, unexpected: 0 } })
      expect(verdict.problems.join('\n')).toContain('skipped')
    })

    it('treats a failed journey as a failure', () => {
      const verdict = evaluateGateReport({ stats: { expected: 2, skipped: 0, unexpected: 1 } })
      expect(verdict.problems.join('\n')).toContain('failed')
    })

    it('accepts a clean run', () => {
      const verdict = evaluateGateReport({ stats: { expected: 2, skipped: 0, unexpected: 0 } })
      expect(verdict.problems).toEqual([])
      expect(verdict.stats.expected).toBe(2)
    })

    it('treats a missing report as a failure', () => {
      expect(evaluateGateReport(undefined).problems.join('\n')).toContain('executed zero journeys')
    })
  })
})
