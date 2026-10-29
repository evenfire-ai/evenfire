import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ADMIN_PASSWORD_KEYS,
  ADMIN_USER_KEYS,
  CONFIRM_MUTATIONS_FLAG,
  REQUIRED_JOURNEY_INVENTORY,
  collectGateProblems,
  collectReportJourneys,
  evaluateGateReport,
  invalidatePreviousAttemptArtifacts,
  missingRequiredJourneyInventories,
  tallyReportJourneys,
  writeSanitizedRunSummary,
} from '../../e2e/run-gfs-drag-and-drop.mjs'

/**
 * The EvenDrive drag-and-drop gate is the frontend-owned entry point that
 * makes a missing setup LOUD. These regressions pin the three halves of that
 * contract: the gate refuses to run without the required setup, it never
 * reads a zero-journey or skipped-journey run as a green result, and it
 * never reads an INCOMPLETE report as one.
 */

const completeSetup = {
  [CONFIRM_MUTATIONS_FLAG]: '1',
  [ADMIN_USER_KEYS[0]]: 'admin',
  [ADMIN_PASSWORD_KEYS[0]]: 'secret-value',
  CONTROL_UI_URL: 'http://127.0.0.1:3100',
  CONTROL_API_URL: 'http://127.0.0.1:8090',
}

type Outcome = 'expected' | 'skipped' | 'unexpected' | 'flaky'

const LANE = 'control-ui'
const COMMAND = 'npm run e2e:gfs-drag-and-drop'
const FILE = 'gfs-drag-and-drop.spec.ts'

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
        journeyReport([{ title: 'journey one', outcome: 'skipped' }])
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
      const problems = evaluateGateReport(report).problems.join('\n')
      expect(problems).toContain('carry no outcome')
    })

    it('rejects a journey whose recorded outcome contradicts the counters', () => {
      // Playwright counts a journey with no result as skipped; a report that
      // claims otherwise does not reconcile.
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

  describe('required breadcrumb journey inventory', () => {
    const breadcrumbJourneys = [
      { title: 'file drag onto a breadcrumb crumb moves it up after one confirmation' },
      { title: 'file drag onto the main drive-root crumb moves it to the root' },
      { title: 'drop onto the active breadcrumb crumb explains it is already there' },
      { title: 'folder drag onto an ancestor crumb above its parent commits after confirmation' },
    ]
    const unrelatedJourneys = [
      { title: 'file drag into folder moves it' },
      { title: 'folder drag opens the one confirmation and Cancel changes nothing' },
    ]

    it('accepts an inventory that carries every required lane', () => {
      const journeys = collectReportJourneys(
        journeyReport([...breadcrumbJourneys, ...unrelatedJourneys])
      )
      expect(missingRequiredJourneyInventories(journeys)).toEqual([])
    })

    it('fails an inventory that lost the breadcrumb journeys entirely', () => {
      // The pre-breadcrumb spec: still a valid Playwright inventory, but it
      // can no longer certify the breadcrumb drop-move feature.
      const journeys = collectReportJourneys(journeyReport(unrelatedJourneys))
      const missing = missingRequiredJourneyInventories(journeys)
      expect(missing).toEqual(REQUIRED_JOURNEY_INVENTORY.map(lane => lane.label))
    })

    it.each(
      breadcrumbJourneys.map((lane, index) => ({
        laneTitle: lane.title,
        laneLabel: REQUIRED_JOURNEY_INVENTORY[index].label,
      }))
    )('fails when only the $laneLabel goes missing', ({ laneTitle, laneLabel }) => {
      // Every lane is required INDEPENDENTLY: removing any single journey —
      // including the root move — must fail the gate even while the other
      // three breadcrumb journeys survive.
      const remaining = breadcrumbJourneys.filter(journey => journey.title !== laneTitle)
      expect(remaining).toHaveLength(breadcrumbJourneys.length - 1)
      const journeys = collectReportJourneys(journeyReport([...remaining, ...unrelatedJourneys]))
      expect(missingRequiredJourneyInventories(journeys)).toEqual([laneLabel])
    })

    it('requires the four lanes through disjoint anchored patterns', () => {
      const titles = breadcrumbJourneys.map(journey => journey.title)
      for (const lane of REQUIRED_JOURNEY_INVENTORY) {
        // The lane pattern matches exactly one journey title — its own —
        // so no sibling lane can satisfy it by accident.
        const matches = titles.filter(title => lane.pattern.test(title))
        expect(matches, lane.label).toHaveLength(1)
      }
      // And nothing outside the breadcrumb lanes is captured.
      for (const lane of REQUIRED_JOURNEY_INVENTORY) {
        for (const journey of unrelatedJourneys) {
          expect(lane.pattern.test(journey.title), lane.label).toBe(false)
        }
      }
    })
  })
})
