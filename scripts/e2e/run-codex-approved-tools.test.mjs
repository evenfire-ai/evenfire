import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openOwnedFile, readOwnedDescriptor } from './prepare-codex-approved-tools.mjs'
import { expectedTitles, toolCallLimitTitle, validateReport } from './run-codex-approved-tools.mjs'

// Synthetic reporter records exercise false-green rejection, not product data.
function greenReport(mode = 'deterministic') {
  const titles = expectedTitles(mode)
  return {
    errors: [],
    stats: { expected: titles.length, unexpected: 0, skipped: 0, flaky: 0 },
    suites: [
      {
        specs: titles.map(title => ({
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
for (const mode of ['deterministic', 'real']) {
  test(`accepts exactly all mandatory green cases in ${mode} mode`, () => {
    assert.deepEqual(validateReport(greenReport(mode), mode), {
      tests: expectedTitles(mode).length,
      skipped: 0,
      failed: 0,
    })
  })
}
test('the tool-call limit case is mandatory only in deterministic mode', () => {
  assert.equal(expectedTitles('deterministic').length, 7)
  assert.equal(expectedTitles('real').length, 6)
  assert.ok(expectedTitles('deterministic').includes(toolCallLimitTitle))
  assert.ok(!expectedTitles('real').includes(toolCallLimitTitle))
  assert.throws(
    () => expectedTitles('mock'),
    /Select deterministic or real upstream mode explicitly/
  )
})
test('rejects a deterministic report without the tool-call limit case', () => {
  assert.throws(
    () => validateReport(greenReport('real'), 'deterministic'),
    /Incomplete, failed, flaky or skipped approved-tools report/
  )
})
test('rejects a full-size deterministic report whose limit case is renamed', () => {
  const report = greenReport('deterministic')
  const limitSpec = report.suites[0].specs.find(spec => spec.title === toolCallLimitTitle)
  limitSpec.title = 'an unrelated green case'
  assert.throws(() => validateReport(report, 'deterministic'), {
    message: `Required case missing or duplicated: ${toolCallLimitTitle}`,
  })
})
test('rejects a real report that carries the deterministic-only case', () => {
  assert.throws(
    () => validateReport(greenReport('deterministic'), 'real'),
    /Incomplete, failed, flaky or skipped approved-tools report/
  )
})
const corruptions = {
  'missing case': report => report.suites[0].specs.pop(),
  'duplicate case': report => {
    report.suites[0].specs[0].title = expectedTitles('deterministic')[1]
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
    assert.throws(() => validateReport(report, 'deterministic'))
  })
}

test('report verification reads only the reserved reporter inode, never a replacement green report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-report-'))
  const file = openOwnedFile(root, 'report.json', { create: true })
  try {
    fs.renameSync(path.join(root, 'report.json'), path.join(root, 'reserved.json'))
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(greenReport()), { mode: 0o600 })
    assert.throws(() => validateReport(JSON.parse(readOwnedDescriptor(file)), 'deterministic'))
    fs.writeSync(file.fd, JSON.stringify(greenReport()))
    assert.equal(
      validateReport(JSON.parse(readOwnedDescriptor(file)), 'deterministic').tests,
      expectedTitles('deterministic').length
    )
  } finally {
    fs.closeSync(file.fd)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
