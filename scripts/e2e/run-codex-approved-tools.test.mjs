import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openOwnedFile, readOwnedDescriptor } from './prepare-codex-approved-tools.mjs'
import {
  expectedTitles,
  grokModelStepRetryTitles,
  hybridRetryTitles,
  modelStepRetryExpectedDelta,
  modelStepRetrySetupTitle,
  modelStepRetryTitles,
  readsModelStepEvidence,
  requiredRunnerKeys,
  specFileFor,
  toolCallLimitBoundaryTitle,
  toolCallLimitTitle,
  validateHybridEvidence,
  validateModelStepEvidence,
  validateReport,
  validateSuite,
} from './run-codex-approved-tools.mjs'

// Synthetic reporter records exercise false-green rejection, not product data.
function greenReport(mode = 'deterministic', provider = 'codex', suite = 'approved-tools') {
  const titles = expectedTitles(mode, provider, suite)
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
for (const mode of ['deterministic', 'real', 'real-hybrid']) {
  test(`accepts exactly all mandatory green cases in ${mode} mode`, () => {
    assert.deepEqual(validateReport(greenReport(mode), mode, 'codex', 'approved-tools'), {
      tests: expectedTitles(mode, 'codex', 'approved-tools').length,
      skipped: 0,
      failed: 0,
    })
  })
}
test('the tool-call limit cases are mandatory only in deterministic approved-tools mode', () => {
  const deterministic = expectedTitles('deterministic', 'codex', 'approved-tools')
  assert.equal(deterministic.length, 8)
  assert.equal(expectedTitles('real', 'codex', 'approved-tools').length, 6)
  assert.deepEqual(expectedTitles('real-hybrid', 'codex', 'approved-tools'), hybridRetryTitles)
  assert.equal(modelStepRetryTitles.length, 11)
  for (const title of [toolCallLimitTitle, toolCallLimitBoundaryTitle]) {
    assert.ok(deterministic.includes(title))
    assert.ok(!expectedTitles('real', 'codex', 'approved-tools').includes(title))
  }
  // The retry cases left the approved-tools suite: they are their own suite.
  for (const title of [modelStepRetrySetupTitle, ...modelStepRetryTitles])
    assert.ok(!deterministic.includes(title), title)
  assert.throws(
    () => expectedTitles('mock', 'codex', 'approved-tools'),
    /Select deterministic, real or real-hybrid upstream mode explicitly/
  )
})
test('the suite splits the registry: a Codex model-step run is the setup case plus C1-C11', () => {
  const modelStep = expectedTitles('deterministic', 'codex', 'model-step-retry')
  assert.equal(modelStep.length, 12)
  assert.deepEqual(modelStep, [modelStepRetrySetupTitle, ...modelStepRetryTitles])
  for (const title of modelStep) {
    assert.equal(specFileFor(title), 'model-step-retry-codex.spec.ts', title)
    assert.ok(!expectedTitles('deterministic', 'codex', 'approved-tools').includes(title), title)
  }
  for (const title of expectedTitles('deterministic', 'codex', 'approved-tools'))
    assert.equal(specFileFor(title), 'codex-subscription-approved-tools.spec.ts', title)
  // The Grok suite keeps its three provider-specific cases plus the same setup.
  assert.deepEqual(expectedTitles('deterministic', 'grok', 'model-step-retry'), [
    modelStepRetrySetupTitle,
    ...grokModelStepRetryTitles,
  ])
})
test('the suite setup title is its own constant outside the case registries', () => {
  // The config selects the setup project with the unanchored pattern Playwright
  // matches against the joined project/file/title path.
  assert.ok(modelStepRetrySetupTitle.startsWith('model step retry setup: '))
  for (const title of [
    ...modelStepRetryTitles,
    ...grokModelStepRetryTitles,
    ...hybridRetryTitles,
    ...expectedTitles('deterministic', 'codex', 'approved-tools'),
  ]) {
    assert.ok(!title.includes('model step retry setup: '), title)
    assert.notEqual(title, modelStepRetrySetupTitle)
  }
})

test('refuses every suite, provider and mode combination the lane does not run', () => {
  // No default: the suite is required everywhere it selects a case registry.
  assert.throws(
    () => expectedTitles('deterministic', 'codex'),
    /approved-tools or model-step-retry/
  )
  assert.throws(() => validateSuite('approved'), /approved-tools or model-step-retry/)
  assert.throws(() => expectedTitles('deterministic', 'grok', 'approved-tools'), /model-step-retry/)
  for (const mode of ['real', 'real-hybrid'])
    assert.throws(() => expectedTitles(mode, 'codex', 'model-step-retry'), /deterministic/)
  // Liveness witness: the refused calls above are accepted with their own suite.
  assert.equal(validateSuite('model-step-retry'), 'model-step-retry')
  assert.equal(expectedTitles('deterministic', 'grok', 'model-step-retry').length, 4)
  assert.equal(expectedTitles('real-hybrid', 'codex', 'approved-tools').length, 2)
})
test('a model-step report without its setup case, or with it twice, is refused', () => {
  const report = greenReport('deterministic', 'codex', 'model-step-retry')
  assert.deepEqual(validateReport(report, 'deterministic', 'codex', 'model-step-retry'), {
    tests: 12,
    skipped: 0,
    failed: 0,
  })
  const missing = greenReport('deterministic', 'codex', 'model-step-retry')
  missing.suites[0].specs.splice(
    missing.suites[0].specs.findIndex(spec => spec.title === modelStepRetrySetupTitle),
    1
  )
  missing.stats.expected -= 1
  assert.throws(
    () => validateReport(missing, 'deterministic', 'codex', 'model-step-retry'),
    /Incomplete, failed, flaky or skipped approved-tools report/
  )
  // A retry case reported from the approved-tools spec is not the registered case.
  const wrongFile = greenReport('deterministic', 'codex', 'model-step-retry')
  wrongFile.suites[0].specs.find(spec => spec.title === modelStepRetryTitles[0]).file =
    'desktop/codex-subscription-approved-tools.spec.ts'
  assert.throws(
    () => validateReport(wrongFile, 'deterministic', 'codex', 'model-step-retry'),
    new RegExp(`Required case missing or duplicated: ${modelStepRetryTitles[0]}`)
  )
  // A setup project that is not excluded from the model-step project reports the
  // same title twice; the reporter merges both projects into one spec with two
  // tests, which no suite accepts.
  const doubled = greenReport('deterministic', 'codex', 'model-step-retry')
  const setup = doubled.suites[0].specs.find(spec => spec.title === modelStepRetrySetupTitle)
  setup.tests.push(structuredClone(setup.tests[0]))
  assert.throws(
    () => validateReport(doubled, 'deterministic', 'codex', 'model-step-retry'),
    /Case not green: model step retry setup/
  )
})
test('the workflow and unauthorized keys are required only by the approved-tools suite', () => {
  const approved = requiredRunnerKeys('deterministic', 'codex', 'approved-tools')
  const modelStep = requiredRunnerKeys('deterministic', 'codex', 'model-step-retry')
  for (const key of [
    'APPROVED_TOOLS_WORKFLOW_SCENARIO',
    'APPROVED_TOOLS_UNAUTHORIZED_EMAIL',
    'APPROVED_TOOLS_UNAUTHORIZED_PASSWORD',
  ]) {
    assert.ok(approved.includes(key), key)
    assert.ok(!modelStep.includes(key), key)
  }
  // Witness: the model-step list keeps every profile precondition it needs.
  for (const key of ['MINIKUBE_PROFILE', 'APPROVED_TOOLS_SCENARIOS'])
    assert.ok(modelStep.includes(key), key)
  const grok = requiredRunnerKeys('deterministic', 'grok', 'model-step-retry')
  assert.ok(grok.includes('APPROVED_TOOLS_GROK_CONNECTION_NAME'))
  assert.ok(!grok.includes('APPROVED_TOOLS_WORKFLOW_SCENARIO'))
  // Real-hybrid prepares no workflow and no unauthorized-user journey.
  assert.ok(
    !requiredRunnerKeys('real-hybrid', 'codex', 'approved-tools').includes(
      'APPROVED_TOOLS_WORKFLOW_SCENARIO'
    )
  )
})
test('the model-step upstream evidence block is read only by its own suite', () => {
  assert.equal(readsModelStepEvidence('deterministic', 'model-step-retry'), true)
  // The approved-tools lane no longer runs C1-C11, so its deltas do not exist.
  assert.equal(readsModelStepEvidence('deterministic', 'approved-tools'), false)
  assert.equal(readsModelStepEvidence('real', 'approved-tools'), false)
  // Real-hybrid counters live in the same evidence block and stay read.
  assert.equal(readsModelStepEvidence('real-hybrid', 'approved-tools'), true)
  assert.throws(() => readsModelStepEvidence('deterministic'), /approved-tools or model-step-retry/)
  assert.throws(
    () => readsModelStepEvidence('mock', 'model-step-retry'),
    /deterministic, real or real-hybrid/
  )
})
test('real-hybrid evidence requires two R1 and R2 injections plus real forwarding', () => {
  const before = {
    forwarded: 10,
    injected503: 0,
    r1: 0,
    r2: 0,
    r1DistinctToolResults: 0,
    r2DistinctToolResults: 0,
  }
  const after = {
    forwarded: 14,
    injected503: 4,
    r1: 2,
    r2: 2,
    r1DistinctToolResults: 3,
    r2DistinctToolResults: 6,
  }
  assert.deepEqual(validateHybridEvidence(before, after), { forwarded: 4, injected503: 4 })
  assert.throws(
    () => validateHybridEvidence(before, { ...after, injected503: 2 }),
    /injected503 did not move by 4/
  )
  assert.throws(
    () => validateHybridEvidence(before, { ...after, forwarded: 10 }),
    /did not forward real provider requests/
  )
})
test('rejects a deterministic report without the tool-call limit case', () => {
  assert.throws(
    () => validateReport(greenReport('real'), 'deterministic', 'codex', 'approved-tools'),
    /Incomplete, failed, flaky or skipped approved-tools report/
  )
})
test('rejects a full-size deterministic report whose limit case is renamed', () => {
  const report = greenReport('deterministic')
  const limitSpec = report.suites[0].specs.find(spec => spec.title === toolCallLimitTitle)
  limitSpec.title = 'an unrelated green case'
  assert.throws(() => validateReport(report, 'deterministic', 'codex', 'approved-tools'), {
    message: `Required case missing or duplicated: ${toolCallLimitTitle}`,
  })
})
test('rejects a real report that carries the deterministic-only case', () => {
  assert.throws(
    () => validateReport(greenReport('deterministic'), 'real', 'codex', 'approved-tools'),
    /Incomplete, failed, flaky or skipped approved-tools report/
  )
})
const corruptions = {
  'missing case': report => report.suites[0].specs.pop(),
  'duplicate case': report => {
    report.suites[0].specs[0].title = expectedTitles('deterministic', 'codex', 'approved-tools')[1]
  },
  'different physical file': report => {
    report.suites[0].specs[0].file = 'other.spec.ts'
  },
  'same basename in a different directory': report => {
    report.suites[0].specs[0].file = 'other/codex-subscription-approved-tools.spec.ts'
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
    assert.throws(() => validateReport(report, 'deterministic', 'codex', 'approved-tools'))
  })
}

test('a real report never carries a model-step retry case from the other suite', () => {
  const report = greenReport('real')
  const extra = structuredClone(report.suites[0].specs[0])
  extra.title = modelStepRetryTitles[0]
  extra.file = 'desktop/model-step-retry-codex.spec.ts'
  report.suites[0].specs.push(extra)
  report.stats.expected += 1
  assert.throws(
    () => validateReport(report, 'real', 'codex', 'approved-tools'),
    /Incomplete, failed, flaky or skipped approved-tools report/
  )
  // Liveness witness: the same report without the extra case is accepted.
  assert.equal(validateReport(greenReport('real'), 'real', 'codex', 'approved-tools').tests, 6)
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
    () =>
      validateModelStepEvidence(
        modelStepEvidence({ ...zeroCounts, turns: modelStepRetryExpectedDelta.turns + 1 }),
        after
      ),
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
    assert.throws(() =>
      validateReport(
        JSON.parse(readOwnedDescriptor(file)),
        'deterministic',
        'codex',
        'approved-tools'
      )
    )
    fs.writeSync(file.fd, JSON.stringify(greenReport()))
    assert.equal(
      validateReport(
        JSON.parse(readOwnedDescriptor(file)),
        'deterministic',
        'codex',
        'approved-tools'
      ).tests,
      expectedTitles('deterministic', 'codex', 'approved-tools').length
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
  // Every declared case belongs to exactly one suite; the union is the registry.
  assert.deepEqual(
    [...declared].sort(),
    [
      ...expectedTitles('deterministic', 'codex', 'approved-tools'),
      ...expectedTitles('deterministic', 'codex', 'model-step-retry'),
    ].sort()
  )
})

test('R2 evidence rejects missing, reset and unexpected distinct tool result deltas', () => {
  const before = {
    forwarded: 10,
    injected503: 0,
    r1: 0,
    r2: 0,
    r1DistinctToolResults: 1,
    r2DistinctToolResults: 2,
  }
  const after = {
    forwarded: 14,
    injected503: 4,
    r1: 2,
    r2: 2,
    r1DistinctToolResults: 4,
    r2DistinctToolResults: 8,
  }
  assert.deepEqual(validateHybridEvidence(before, after), { forwarded: 4, injected503: 4 })
  for (const value of [undefined, 1, 2, 7, 9]) {
    assert.throws(
      () => validateHybridEvidence(before, { ...after, r2DistinctToolResults: value }),
      /r2DistinctToolResults/
    )
  }
})

test('Grok requires precisely the setup case and C1 C2 C11 in their physical spec', () => {
  const titles = [modelStepRetrySetupTitle, ...grokModelStepRetryTitles]
  assert.deepEqual(expectedTitles('deterministic', 'grok', 'model-step-retry'), titles)
  const valid = greenReport('deterministic', 'grok', 'model-step-retry')
  assert.deepEqual(validateReport(valid, 'deterministic', 'grok', 'model-step-retry'), {
    tests: 4,
    skipped: 0,
    failed: 0,
  })
  assert.throws(() => validateReport(greenReport(), 'deterministic', 'grok', 'model-step-retry'))
  // The Grok suite never falls back to the nineteen Codex-only titles.
  assert.equal(grokModelStepRetryTitles.length, 3)
  assert.throws(() => expectedTitles('deterministic', 'grok', 'approved-tools'), /model-step-retry/)
  for (const corrupt of [
    report => report.suites[0].specs.pop(),
    report => {
      report.suites[0].specs[0].file = 'desktop/codex-subscription-approved-tools.spec.ts'
    },
    report => {
      report.suites[0].specs[0].tests[0].results.push({ status: 'passed' })
    },
  ]) {
    const report = structuredClone(valid)
    corrupt(report)
    assert.throws(() => validateReport(report, 'deterministic', 'grok', 'model-step-retry'))
  }
  assert.throws(() => expectedTitles('real', 'grok', 'model-step-retry'), /deterministic/)
  assert.throws(() => expectedTitles('deterministic', 'unknown', 'model-step-retry'), /provider/)
})

test('Grok evidence requires all thirteen exact counters for the three recovery cases', () => {
  const expected = {
    turns: 3,
    markerSearches: 2,
    unavailableResponses: 4,
    zeroToolUnavailable: 1,
    continuationUnavailable: 0,
    continuations: 1,
    toolResults: 1,
    resends: 1,
    followUps: 0,
    unexpectedRetries: 0,
    approvalRequests: 0,
    approvalFinals: 0,
    absorbed: 1,
  }
  const before = modelStepEvidence(zeroCounts)
  assert.deepEqual(validateModelStepEvidence(before, modelStepEvidence(expected), 'grok'), expected)
  for (const field of Object.keys(expected)) {
    assert.throws(
      () =>
        validateModelStepEvidence(
          before,
          modelStepEvidence({ ...expected, [field]: expected[field] + 1 }),
          'grok'
        ),
      new RegExp(field)
    )
  }
})
