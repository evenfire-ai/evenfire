import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectedTitles, validateReport } from './run-codex-approved-tools.mjs'

// Synthetic reporter records exercise false-green rejection, not product data.
function greenReport() {
  return {
    errors: [],
    stats: { expected: 4, unexpected: 0, skipped: 0, flaky: 0 },
    suites: [
      {
        specs: expectedTitles.map(title => ({
          title,
          file: 'desktop/codex-subscription-approved-tools.spec.ts',
          ok: true,
          tests: [
            {
              expectedStatus: 'passed',
              status: 'expected',
              results: [{ status: 'passed', errors: [] }],
            },
          ],
        })),
        suites: [],
      },
    ],
  }
}
test('accepts exactly the required four green cases', () => {
  assert.deepEqual(validateReport(greenReport()), { tests: 4, skipped: 0, failed: 0 })
})
const corruptions = {
  'missing case': report => report.suites[0].specs.pop(),
  'duplicate case': report => {
    report.suites[0].specs[0].title = expectedTitles[1]
  },
  'different physical file': report => {
    report.suites[0].specs[0].file = 'other.spec.ts'
  },
  'same basename in a different directory': report => {
    report.suites[0].specs[0].file = 'other/codex-subscription-approved-tools.spec.ts'
  },
  'zero executions': report => {
    report.suites[0].specs[0].tests[0].results = []
  },
  'teardown error': report => report.errors.push({ message: 'teardown failed' }),
  skip: report => {
    report.stats.skipped = 1
  },
  'individual skipped result': report => {
    report.suites[0].specs[0].tests[0].results[0].status = 'skipped'
  },
  'expected failure': report => {
    report.suites[0].specs[0].tests[0].expectedStatus = 'failed'
  },
  retry: report =>
    report.suites[0].specs[0].tests[0].results.push({ status: 'passed', errors: [] }),
  'incomplete reporter': report => {
    delete report.stats
  },
}
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`rejects ${name}`, () => {
    const report = greenReport()
    corrupt(report)
    assert.throws(() => validateReport(report))
  })
}
