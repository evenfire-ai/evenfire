import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DESKTOP_EMAIL_KEYS,
  DESKTOP_PASSWORD_KEYS,
  collectGateProblems,
  collectReportJourneys,
  evaluateGateReport,
  invalidatePreviousAttemptArtifacts,
  tallyReportJourneys,
  writeSanitizedRunSummary,
} from '../e2e-playwright/run-gfs-drag-and-drop.mjs'

/**
 * The EvenDrive drag-and-drop gate is the frontend-owned entry point that
 * makes a missing setup LOUD. These regressions pin the two halves of that
 * contract: the gate refuses to run without the required setup, and it never
 * reads a zero-journey or skipped-journey run as a green result.
 */

type Outcome = 'expected' | 'skipped' | 'unexpected' | 'flaky'

const LANE = 'desktop-app'
const COMMAND = 'npm run test:e2e:playwright:gfs-drag-and-drop'
const FILE = 'gfs-drag-and-drop-desktop.test.ts'

/**
 * A report shaped like the one Playwright writes: the suite tree with one
 * spec per journey, and the counters that summarise it.
 */
function journeyReport(
  journeys: Array<{ title: string; outcome?: Outcome | null; results?: number }>,
  counterOverrides: Record<string, unknown> = {}
) {
  const stats = { expected: 0, skipped: 0, unexpected: 0, flaky: 0, ...counterOverrides }
  for (const journey of journeys) {
    const outcome = journey.outcome ?? 'expected'
    if (outcome in stats) stats[outcome] += 1
  }
  return {
    suites: [
      {
        title: FILE,
        file: FILE,
        specs: journeys.map(journey => ({
          title: journey.title,
          file: FILE,
          tests: [
            {
              ...(journey.outcome === null ? {} : { status: journey.outcome ?? 'expected' }),
              expectedStatus: 'passed',
              results:
                journey.results === undefined
                  ? [{ status: journey.outcome === 'skipped' ? 'skipped' : 'passed' }]
                  : Array.from({ length: journey.results }, () => ({ status: 'passed' })),
            },
          ],
        })),
        suites: [],
      },
    ],
    stats,
  }
}

const completeSetup = {
  E2E_K8S_CONTEXT: 'dev',
  E2E_ALLOWED_CONTEXTS: 'dev',
  [DESKTOP_PASSWORD_KEYS[0]]: 'secret-value',
  [DESKTOP_EMAIL_KEYS[0]]: 'test@clerum.io',
  EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:8091',
  RPC_PROXY_BASE_URL: 'http://127.0.0.1:8094',
}

describe('EvenDrive drag-and-drop Desktop E2E gate', () => {
  afterEach(() => vi.restoreAllMocks())

  describe('required setup', () => {
    it('accepts a complete setup', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true)
      expect(collectGateProblems(completeSetup)).toEqual([])
    })

    it('refuses missing build output without depending on a prior local build', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false)
      expect(collectGateProblems(completeSetup).join('\n')).toContain('build output')
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
    const passingReport = journeyReport([{ title: 'journey one' }, { title: 'journey two' }])

    it.each([
      { status: 1 },
      { status: null, signal: 'SIGTERM' },
      { status: null, error: new Error('spawn failed') },
    ])('rejects a green report when Playwright did not exit zero (%j)', run => {
      expect(evaluateGateReport(passingReport, run).problems.join('\n')).toContain(
        'did not exit successfully'
      )
    })

    it('rejects a run-level error even when individual journeys passed', () => {
      const report = { ...passingReport, errors: [{ message: 'teardown failed' }] }
      expect(evaluateGateReport(report).problems.join('\n')).toContain('run-level error')
    })

    it('rejects flaky journeys', () => {
      const report = journeyReport([{ title: 'journey one', outcome: 'flaky' }])
      expect(evaluateGateReport(report).problems.join('\n')).toContain('flaky')
    })

    it('rejects malformed result counts', () => {
      const report = journeyReport([{ title: 'journey one' }], { skipped: 'invalid' })
      expect(evaluateGateReport(report).problems.join('\n')).toContain('invalid result counts')
    })

    it('treats a run that executed zero journeys as a failure', () => {
      const verdict = evaluateGateReport(
        journeyReport([
          { title: 'journey one', outcome: 'skipped' },
          { title: 'journey two', outcome: 'skipped' },
        ])
      )
      expect(verdict.problems.join('\n')).toContain('executed zero journeys')
    })

    it('treats a skipped journey as a failure', () => {
      const verdict = evaluateGateReport(
        journeyReport([{ title: 'journey one' }, { title: 'journey two', outcome: 'skipped' }])
      )
      expect(verdict.problems.join('\n')).toContain('skipped')
    })

    it('treats a failed journey as a failure', () => {
      const verdict = evaluateGateReport(
        journeyReport([{ title: 'journey one' }, { title: 'journey two', outcome: 'unexpected' }])
      )
      expect(verdict.problems.join('\n')).toContain('failed')
    })

    it('accepts a clean run', () => {
      const verdict = evaluateGateReport(passingReport)
      expect(verdict.problems).toEqual([])
      expect(verdict.stats.expected).toBe(2)
    })

    it('treats a missing report as a failure', () => {
      expect(evaluateGateReport(undefined).problems.join('\n')).toContain('executed zero journeys')
    })
  })

  describe('incomplete reports', () => {
    it('rejects a report whose counters are incomplete', () => {
      // The reproduced defect: the missing counters used to be read as
      // successful zero counts.
      const verdict = evaluateGateReport({ stats: { expected: 1 } }, { status: 0 })
      expect(verdict.problems.length).toBeGreaterThan(0)
      expect(verdict.problems.join('\n')).toContain('invalid result counts')
    })

    it('rejects a report that lists no journeys', () => {
      const verdict = evaluateGateReport({
        stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
      })
      expect(verdict.problems.join('\n')).toContain('lists no journeys')
    })

    it('rejects a report whose counters do not reconcile with its inventory', () => {
      const report = journeyReport([{ title: 'journey one' }], { expected: 5 })
      expect(evaluateGateReport(report).problems.join('\n')).toContain('does not reconcile')
    })

    it('rejects a journey the report carries no outcome for', () => {
      const report = journeyReport([{ title: 'journey one', outcome: null }])
      expect(evaluateGateReport(report).problems.join('\n')).toContain('carry no outcome')
    })

    it('rejects a journey whose recorded outcome contradicts the counters', () => {
      const report = journeyReport([{ title: 'journey one', results: 0 }])
      expect(evaluateGateReport(report).problems.join('\n')).toContain('does not reconcile')
    })

    it('rejects a report that is missing a selected journey', () => {
      const selected = collectReportJourneys(
        journeyReport([{ title: 'journey one' }, { title: 'journey two' }])
      )
      const report = journeyReport([{ title: 'journey one' }])
      expect(evaluateGateReport(report, { status: 0 }, selected).problems.join('\n')).toContain(
        'missing 1 selected journey'
      )
    })

    it('rejects a report that carries a journey that was not selected', () => {
      const selected = collectReportJourneys(journeyReport([{ title: 'journey one' }]))
      const report = journeyReport([{ title: 'journey one' }, { title: 'journey two' }])
      expect(evaluateGateReport(report, { status: 0 }, selected).problems.join('\n')).toContain(
        'not selected'
      )
    })

    it('accepts a report that matches the selected journeys exactly', () => {
      const report = journeyReport([{ title: 'journey one' }, { title: 'journey two' }])
      const selected = collectReportJourneys(report)
      expect(evaluateGateReport(report, { status: 0 }, selected).problems).toEqual([])
    })
  })

  describe('sanitized run summary', () => {
    it('binds the revision, the selected cases, the outcomes and the exit code', () => {
      // A uniquely created directory, never a predictably named file directly
      // in the system temporary directory (CodeQL js/insecure-temporary-file).
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-dnd-summary-'))
      const filePath = path.join(dir, 'playwright-summary.json')
      try {
        const report = journeyReport([{ title: 'journey one' }, { title: 'journey two' }])
        const summary = writeSanitizedRunSummary({
          lane: LANE,
          revision: 'abc123',
          branch: 'feat/example',
          command: COMMAND,
          report,
          run: { status: 0 },
          selectedJourneys: collectReportJourneys(report),
          verdict: 'pass',
          filePath,
        })

        expect(summary).toMatchObject({
          lane: LANE,
          revision: 'abc123',
          branch: 'feat/example',
          command: COMMAND,
          processExit: 0,
          verdict: 'pass',
        })
        expect(summary.selected).toEqual(['journey one', 'journey two'])
        expect(summary.journeys).toEqual([
          { title: 'journey one', status: 'expected' },
          { title: 'journey two', status: 'expected' },
        ])
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(summary)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('does not carry the raw report text into the summary', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-dnd-summary-'))
      const filePath = path.join(dir, 'playwright-summary.json')
      try {
        const report = {
          ...journeyReport([{ title: 'journey one', outcome: 'unexpected' }]),
          errors: [{ message: 'the upstream said: private-token-value' }],
        }
        const summary = writeSanitizedRunSummary({
          lane: LANE,
          revision: 'abc123',
          branch: 'feat/example',
          command: COMMAND,
          report,
          run: { status: 1 },
          selectedJourneys: collectReportJourneys(report),
          verdict: 'fail',
          filePath,
        })

        expect(JSON.stringify(summary)).not.toContain('private-token-value')
        expect(summary.processExit).toBe(1)
        expect(summary.verdict).toBe('fail')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('stale attempt artifacts', () => {
    it('removes a previous PASS summary when the next attempt starts (success → early failure)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-dnd-artifacts-'))
      try {
        // A previous attempt completed and passed, leaving its artifacts.
        const report = journeyReport([{ title: 'journey one' }])
        writeSanitizedRunSummary({
          lane: LANE,
          revision: 'abc123',
          branch: 'feat/example',
          command: COMMAND,
          report,
          run: { status: 0 },
          selectedJourneys: collectReportJourneys(report),
          verdict: 'pass',
          filePath: path.join(dir, 'playwright-summary.json'),
        })
        fs.writeFileSync(path.join(dir, 'playwright-report.json'), '{}')
        fs.writeFileSync(path.join(dir, 'playwright-selection.json'), '{}')
        expect(fs.existsSync(path.join(dir, 'playwright-summary.json'))).toBe(true)

        // The next attempt fails before it can write its own summary. The
        // previous pass must not survive it as apparent evidence.
        invalidatePreviousAttemptArtifacts(dir)
        for (const name of [
          'playwright-summary.json',
          'playwright-report.json',
          'playwright-selection.json',
        ]) {
          expect(fs.existsSync(path.join(dir, name))).toBe(false)
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('tolerates an artifact directory with nothing to remove', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-dnd-artifacts-'))
      try {
        expect(() => invalidatePreviousAttemptArtifacts(dir)).not.toThrow()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('report inventory', () => {
    it('identifies a journey by its file and title path', () => {
      const journeys = collectReportJourneys(journeyReport([{ title: 'journey one' }]))
      expect(journeys).toHaveLength(1)
      expect(journeys[0]?.identity).toBe(`${FILE}::journey one`)
    })

    it('tallies the outcomes the way Playwright does', () => {
      const journeys = collectReportJourneys(
        journeyReport([{ title: 'one' }, { title: 'two' }, { title: 'three', outcome: 'skipped' }])
      )
      expect(tallyReportJourneys(journeys)).toEqual({
        expected: 2,
        skipped: 1,
        unexpected: 0,
        flaky: 0,
        incomplete: 0,
      })
    })
  })
})
