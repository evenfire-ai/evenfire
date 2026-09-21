import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openOwnedFile, readOwnedDescriptor } from './prepare-codex-approved-tools.mjs'
import {
  expectedTitles,
  toolCallLimitBoundaryTitle,
  toolCallLimitTitle,
  validateReport,
} from './run-codex-approved-tools.mjs'

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
  assert.equal(expectedTitles('deterministic').length, 8)
  assert.equal(expectedTitles('real').length, 6)
  for (const title of [toolCallLimitTitle, toolCallLimitBoundaryTitle]) {
    assert.ok(expectedTitles('deterministic').includes(title))
    assert.ok(!expectedTitles('real').includes(title))
  }
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

// A registry that is only ever compared against itself cannot notice a case the
// spec added and it does not list, and validateReport's count check turns that
// omission into an unnamed lane failure. Read the two real sources instead.
test('every deterministic spec case is registered, and every registered case exists', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const spec = fs.readFileSync(
    path.join(repo, 'tests/e2e/playwright/desktop/codex-subscription-approved-tools.spec.ts'),
    'utf8'
  )
  const helpers = fs.readFileSync(
    path.join(repo, 'tests/e2e/playwright/helpers/approved-tools-scenarios.ts'),
    'utf8'
  )
  const sizesSource = helpers.match(/export const catalogSizes = \[([^\]]*)\]/)
  assert.ok(sizesSource, 'catalogSizes is no longer a literal array; update this cross-check')
  const sizes = sizesSource[1].split(',').map(entry => Number(entry.trim()))
  assert.ok(sizes.length > 0 && sizes.every(Number.isInteger), 'catalogSizes must be integers')

  const declared = []
  for (const match of spec.matchAll(/^[ \t]*test\(\s*(['"`])([\s\S]*?)\1\s*,/gm)) {
    const title = match[2]
    const placeholders = [...title.matchAll(/\$\{([^}]*)\}/g)].map(entry => entry[1].trim())
    if (placeholders.length === 0) {
      declared.push(title)
      continue
    }
    assert.deepEqual(
      placeholders,
      ['scenario.catalogSize'],
      `unsupported interpolation in a spec title: ${title}`
    )
    declared.push(...sizes.map(size => title.replace('${scenario.catalogSize}', String(size))))
  }
  assert.equal(declared.length, new Set(declared).size, 'the spec declares a duplicate title')
  assert.deepEqual([...declared].sort(), [...expectedTitles('deterministic')].sort())
})
