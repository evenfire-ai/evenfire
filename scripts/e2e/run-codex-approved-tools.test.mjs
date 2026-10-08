import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openOwnedFile, readOwnedDescriptor } from './prepare-codex-approved-tools.mjs'
import {
  expectedTitles,
  modelStepRetryExpectedDelta,
  modelStepRetryTitles,
  specFileFor,
  toolCallLimitBoundaryTitle,
  toolCallLimitTitle,
  validateModelStepEvidence,
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
          file: `desktop/${specFileFor(title)}`,
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
test('the tool-call limit and model-step retry cases are mandatory only in deterministic mode', () => {
  assert.equal(expectedTitles('deterministic').length, 14)
  assert.equal(expectedTitles('real').length, 6)
  assert.equal(modelStepRetryTitles.length, 6)
  for (const title of [toolCallLimitTitle, toolCallLimitBoundaryTitle, ...modelStepRetryTitles]) {
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
  'model-step case reported from the approved-tools spec': report => {
    report.suites[0].specs.find(spec => spec.title === modelStepRetryTitles[0]).file =
      'desktop/codex-subscription-approved-tools.spec.ts'
  },
  'approved-tools case reported from the model-step spec': report => {
    report.suites[0].specs[0].file = 'desktop/model-step-retry-codex.spec.ts'
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

test('a real report never carries a model-step retry case', () => {
  const report = greenReport('real')
  const extra = structuredClone(report.suites[0].specs[0])
  extra.title = modelStepRetryTitles[0]
  extra.file = 'desktop/model-step-retry-codex.spec.ts'
  report.suites[0].specs.push(extra)
  report.stats.expected += 1
  assert.throws(
    () => validateReport(report, 'real'),
    /Incomplete, failed, flaky or skipped approved-tools report/
  )
  // Liveness witness: the same report without the extra case is accepted.
  assert.equal(validateReport(greenReport('real'), 'real').tests, 6)
})

function modelStepEvidence(counts) {
  return { modelStepRetry: { ...counts } }
}
const zeroCounts = Object.fromEntries(Object.keys(modelStepRetryExpectedDelta).map(key => [key, 0]))

test('accepts exactly the expected model-step evidence change', () => {
  const before = modelStepEvidence({ ...zeroCounts, turns: 2, markerSearches: 2 })
  const after = modelStepEvidence(
    Object.fromEntries(
      Object.entries(modelStepRetryExpectedDelta).map(([key, value]) => [
        key,
        before.modelStepRetry[key] + value,
      ])
    )
  )
  assert.deepEqual(validateModelStepEvidence(before, after), modelStepRetryExpectedDelta)
})

for (const field of Object.keys(modelStepRetryExpectedDelta)) {
  test(`rejects a model-step evidence change off by one in ${field}`, () => {
    const after = modelStepEvidence({ ...modelStepRetryExpectedDelta })
    after.modelStepRetry[field] += 1
    assert.throws(() => validateModelStepEvidence(modelStepEvidence(zeroCounts), after), {
      message: `Model-step retry evidence ${field} moved by ${modelStepRetryExpectedDelta[field] + 1}, expected ${modelStepRetryExpectedDelta[field]}`,
    })
  })
}

test('rejects model-step evidence that is missing, reset or not reported', () => {
  const after = modelStepEvidence(modelStepRetryExpectedDelta)
  assert.throws(() => validateModelStepEvidence({}, after), /missing or reset: turns/)
  assert.throws(
    () => validateModelStepEvidence(modelStepEvidence({ ...zeroCounts, turns: 9 }), after),
    /missing or reset: turns/
  )
  const partial = modelStepEvidence(modelStepRetryExpectedDelta)
  delete partial.modelStepRetry.resends
  assert.throws(
    () => validateModelStepEvidence(modelStepEvidence(zeroCounts), partial),
    /missing or reset: resends/
  )
})

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
  const specFiles = ['codex-subscription-approved-tools.spec.ts', 'model-step-retry-codex.spec.ts']
  const sources = Object.fromEntries(
    specFiles.map(file => [
      file,
      fs.readFileSync(path.join(repo, 'tests/e2e/playwright/desktop', file), 'utf8'),
    ])
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
  for (const [file, spec] of Object.entries(sources)) {
    for (const match of spec.matchAll(/^[ \t]*test\(\s*(['"`])([\s\S]*?)\1\s*,/gm)) {
      const title = match[2]
      const placeholders = [...title.matchAll(/\$\{([^}]*)\}/g)].map(entry => entry[1].trim())
      const titles =
        placeholders.length === 0
          ? [title]
          : sizes.map(size => title.replace('${scenario.catalogSize}', String(size)))
      if (placeholders.length)
        assert.deepEqual(
          placeholders,
          ['scenario.catalogSize'],
          `unsupported interpolation in a spec title: ${title}`
        )
      // Each title is registered against the file that declares it.
      for (const entry of titles) assert.equal(specFileFor(entry), file, entry)
      declared.push(...titles)
    }
  }
  assert.equal(declared.length, new Set(declared).size, 'the spec declares a duplicate title')
  assert.deepEqual([...declared].sort(), [...expectedTitles('deterministic')].sort())
})
