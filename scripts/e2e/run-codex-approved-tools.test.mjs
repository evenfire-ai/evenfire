import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openOwnedFile, readOwnedDescriptor } from './prepare-codex-approved-tools.mjs'
import {
  admissionDelta,
  expectedTitles,
  grokModelStepRetryTitles,
  hybridRetryTitles,
  modelStepRetryExpectedDelta,
  modelStepRetrySetupTitle,
  modelStepRetryTitles,
  nativeWorkflowTitle,
  observeRetryLayer,
  parseAdmissionCounters,
  persistRetryLayer,
  readsModelStepEvidence,
  requiredRunnerKeys,
  runLane,
  scenarioRows,
  specFileFor,
  toolCallLimitBoundaryTitle,
  toolCallLimitTitle,
  upstreamEvidenceOrigin,
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
  assert.equal(deterministic.length, 7)
  assert.equal(expectedTitles('real', 'codex', 'approved-tools').length, 5)
  assert.deepEqual(expectedTitles('real-hybrid', 'codex', 'approved-tools'), hybridRetryTitles)
  assert.equal(modelStepRetryTitles.length, 12)
  for (const title of [toolCallLimitTitle, toolCallLimitBoundaryTitle]) {
    assert.ok(deterministic.includes(title))
    assert.ok(!expectedTitles('real', 'codex', 'approved-tools').includes(title))
  }
  // The retry cases left the approved-tools suite: they are their own suite.
  for (const title of [modelStepRetrySetupTitle, ...modelStepRetryTitles])
    assert.ok(!deterministic.includes(title), title)
  // #1048 MS-NW: the workflow case left the base group and is its own suite.
  assert.ok(!deterministic.includes(nativeWorkflowTitle))
  assert.deepEqual(expectedTitles('deterministic', 'codex', 'native-workflow'), [
    nativeWorkflowTitle,
  ])
  assert.throws(
    () => expectedTitles('mock', 'codex', 'approved-tools'),
    /Select deterministic, real or real-hybrid upstream mode explicitly/
  )
})
test('the suite splits the registry: a Codex model-step run is the setup case plus C1-C12', () => {
  const modelStep = expectedTitles('deterministic', 'codex', 'model-step-retry')
  assert.equal(modelStep.length, 13)
  assert.deepEqual(modelStep, [modelStepRetrySetupTitle, ...modelStepRetryTitles])
  for (const title of modelStep) {
    assert.equal(specFileFor(title), 'model-step-retry-codex.spec.ts', title)
    assert.ok(!expectedTitles('deterministic', 'codex', 'approved-tools').includes(title), title)
  }
  for (const title of expectedTitles('deterministic', 'codex', 'approved-tools'))
    assert.equal(specFileFor(title), 'codex-subscription-approved-tools.spec.ts', title)
  // The native workflow case is registered to its own spec, never to the base one.
  assert.equal(specFileFor(nativeWorkflowTitle), 'codex-native-workflow.spec.ts')
  assert.ok(
    !expectedTitles('deterministic', 'codex', 'approved-tools').includes(nativeWorkflowTitle)
  )
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
    /approved-tools, native-workflow or model-step-retry/
  )
  assert.throws(
    () => validateSuite('approved'),
    /approved-tools, native-workflow or model-step-retry/
  )
  assert.throws(() => expectedTitles('deterministic', 'grok', 'approved-tools'), /model-step-retry/)
  for (const mode of ['real', 'real-hybrid'])
    assert.throws(() => expectedTitles(mode, 'codex', 'model-step-retry'), /deterministic/)
  // The native workflow lane is codex + deterministic only: its coordinator image
  // fixture does not exist for the other cells.
  for (const mode of ['real', 'real-hybrid'])
    assert.throws(() => expectedTitles(mode, 'codex', 'native-workflow'), /deterministic/)
  assert.throws(
    () => expectedTitles('deterministic', 'grok', 'native-workflow'),
    /model-step-retry/
  )
  // Liveness witness: the refused calls above are accepted with their own suite.
  assert.equal(validateSuite('model-step-retry'), 'model-step-retry')
  assert.equal(validateSuite('native-workflow'), 'native-workflow')
  assert.equal(expectedTitles('deterministic', 'grok', 'model-step-retry').length, 4)
  assert.equal(expectedTitles('real-hybrid', 'codex', 'approved-tools').length, 2)
})
test('a model-step report without its setup case, or with it twice, is refused', () => {
  const report = greenReport('deterministic', 'codex', 'model-step-retry')
  assert.deepEqual(validateReport(report, 'deterministic', 'codex', 'model-step-retry'), {
    tests: 13,
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
test('the workflow and unauthorized keys are required only by the suites that use them', () => {
  const approved = requiredRunnerKeys('deterministic', 'codex', 'approved-tools')
  const modelStep = requiredRunnerKeys('deterministic', 'codex', 'model-step-retry')
  const nativeWorkflow = requiredRunnerKeys('deterministic', 'codex', 'native-workflow')
  // #1048 MS-NW: the workflow scenario is prepared by its own suite only; the
  // base suite prepares no `WorkflowRecipe` and cannot supply that key.
  assert.ok(nativeWorkflow.includes('APPROVED_TOOLS_WORKFLOW_SCENARIO'))
  for (const key of ['APPROVED_TOOLS_UNAUTHORIZED_EMAIL', 'APPROVED_TOOLS_UNAUTHORIZED_PASSWORD'])
    assert.ok(!nativeWorkflow.includes(key), key)
  assert.ok(!approved.includes('APPROVED_TOOLS_WORKFLOW_SCENARIO'))
  for (const key of ['APPROVED_TOOLS_UNAUTHORIZED_EMAIL', 'APPROVED_TOOLS_UNAUTHORIZED_PASSWORD']) {
    assert.ok(approved.includes(key), key)
    assert.ok(!modelStep.includes(key), key)
    assert.ok(!nativeWorkflow.includes(key), key)
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
  assert.throws(
    () => readsModelStepEvidence('deterministic'),
    /approved-tools, native-workflow or model-step-retry/
  )
  assert.throws(
    () => readsModelStepEvidence('mock', 'model-step-retry'),
    /deterministic, real or real-hybrid/
  )
})
test('real-hybrid evidence requires four R1 and R2 injections plus real forwarding', () => {
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
    injected503: 8,
    r1: 4,
    r2: 4,
    r1DistinctToolResults: 3,
    r2DistinctToolResults: 6,
  }
  assert.deepEqual(validateHybridEvidence(before, after), { forwarded: 4, injected503: 8 })
  assert.throws(
    () => validateHybridEvidence(before, { ...after, injected503: 4 }),
    /injected503 did not move by 8/
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
  assert.equal(validateReport(greenReport('real'), 'real', 'codex', 'approved-tools').tests, 5)
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

// The frozen literals are the lane's contract: three automatic retries per
// failed step, three absorbed outages in C11 and the C12 cap case. A count that
// drifts without this table changing must not pass.
test('the Codex model-step delta is the frozen literal for three retries and C12', () => {
  assert.deepEqual(modelStepRetryExpectedDelta, {
    turns: 12,
    markerSearches: 11,
    unavailableResponses: 46,
    zeroToolUnavailable: 1,
    continuationUnavailable: 4,
    continuations: 6,
    toolResults: 6,
    resends: 2,
    followUps: 3,
    unexpectedRetries: 0,
    approvalRequests: 3,
    approvalFinals: 1,
    absorbed: 1,
    cappedHeld: 1,
  })
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
  const specFiles = [
    'codex-subscription-approved-tools.spec.ts',
    'codex-native-workflow.spec.ts',
    'model-step-retry-codex.spec.ts',
  ]
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
      ...expectedTitles('deterministic', 'codex', 'native-workflow'),
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
    injected503: 8,
    r1: 4,
    r2: 4,
    r1DistinctToolResults: 4,
    r2DistinctToolResults: 8,
  }
  assert.deepEqual(validateHybridEvidence(before, after), { forwarded: 4, injected503: 8 })
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

test('Grok evidence requires all fourteen exact counters for the three recovery cases', () => {
  const expected = {
    turns: 3,
    markerSearches: 2,
    unavailableResponses: 8,
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
    cappedHeld: 0,
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

// #1048 MS-1 (runner part): the layer evidence must survive a red report, and a
// broken capture may never replace the phase's own error.
const retryScenario = {
  catalogSize: 83,
  agentName: 'approved-tools-aabbccddeeff-agent-83',
  upstreamEvidenceUrl: 'http://127.0.0.1:43111',
}
const admissionText = [
  '# HELP password_admission_denials_total Password admission denials',
  'password_admission_denials_total{reason="global_pace"} 3',
  'password_admission_denials_total{reason="source_rate"} 1',
  'rate_limit_hits_total{bucket_type="external_authentication_attempt",result="unavailable"} 0',
].join('\n')
const proxyLog = [
  'level=info method=continue-model-step checkpointId=abc',
  'level=error msg="continue model step forward failed" status=502',
  'level=info method=continue-model-step checkpointId=def',
].join('\n')
const hostLog = [
  '{"level":50,"msg":"Model-step continuation admission failed","code":"checkpoint_expired"}',
  '{"level":50,"msg":"Error continuing model-step checkpoint"}',
  '{"level":40,"msg":"host_draining"}',
  '{"level":50,"msg":"Model-step continuation admission failed","code":"checkpoint_expired"}',
].join('\n')

function retryLayerReads(overrides = {}) {
  return {
    readProxyLog: () => proxyLog,
    readHostLog: () => hostLog,
    readAdmission: async () =>
      parseAdmissionCounters(
        admissionText.replace('reason="global_pace"} 3', 'reason="global_pace"} 5')
      ),
    readFixtureEvidence: async () => ({
      requests: [
        { stage: 'model_step_search' },
        { stage: 'model_step_continued' },
        { stage: 'model_step_continued' },
      ],
      completions: 3,
      searchCalls: 1,
      describeCalls: 1,
      businessCalls: 2,
      finalResponses: 1,
      deniedResponses: 0,
      rejected: 0,
      ignoredEvidence: 'not-a-count',
      modelStepRetry: { turns: 1, continuations: 1, approvalRequests: 0, cappedAbortedEarly: true },
    }),
    ...overrides,
  }
}

async function observeSample(overrides = {}) {
  return observeRetryLayer({
    provider: 'codex',
    suite: 'model-step-retry',
    mode: 'deterministic',
    since: '2026-10-31T00:00:00.000Z',
    scenarioRows: [retryScenario],
    hostDeployment: retryScenario.agentName,
    admissionBefore: parseAdmissionCounters(
      admissionText.replace('reason="source_rate"} 1', 'reason="source_rate"} 0')
    ),
    ...retryLayerReads(overrides),
  })
}

test('the retry layer counts proxy and Host markers without keeping a body', async () => {
  const record = await observeSample()
  assert.deepEqual(record.retryLayer.proxy, { continueRequests: 2, forwardFailed: 1 })
  assert.deepEqual(record.retryLayer.host, {
    deployment: retryScenario.agentName,
    admissionFailed: 2,
    admissionCodes: { checkpoint_expired: 2 },
    continueFailed: 1,
    hostDraining: 1,
  })
  assert.deepEqual(record.retryLayer.fixture, {
    counters: { turns: 1, continuations: 1, approvalRequests: 0 },
    ordinaryCounters: {
      completions: 3,
      searchCalls: 1,
      describeCalls: 1,
      businessCalls: 2,
      finalResponses: 1,
      deniedResponses: 0,
      rejected: 0,
    },
    stages: ['model_step_search', 'model_step_continued'],
    stageCounts: { model_step_search: 1, model_step_continued: 2 },
    rejections: {},
  })
  // No field of the record carries a log or request body.
  const serialized = JSON.stringify(record)
  assert.ok(!serialized.includes('checkpointId'))
  assert.ok(!serialized.includes('502'))
  assert.ok(!serialized.includes('cappedAbortedEarly'))
})

test('the retry layer keeps bounded fixture rejection names and drops anything else', async () => {
  const record = await observeSample({
    readFixtureEvidence: async () => ({
      requests: [{ stage: 'model_step_search' }],
      modelStepRetry: { turns: 1 },
      rejections: {
        missing_business_result: 2,
        unexpected_retry: 1,
        'Not A Name!': 5,
        negative_count: -1,
        fractional_count: 1.5,
        string_count: '3',
      },
    }),
  })
  // Liveness witness: the valid counters and stages still arrive, so the
  // filtered rejections are the filter firing, not a dead evidence read.
  assert.deepEqual(record.retryLayer.fixture.counters, { turns: 1 })
  assert.deepEqual(record.retryLayer.fixture.stages, ['model_step_search'])
  assert.deepEqual(record.retryLayer.fixture.rejections, {
    missing_business_result: 2,
    unexpected_retry: 1,
  })
})

test('the admission record keeps the per-reason before/after delta only', async () => {
  const record = await observeSample()
  assert.deepEqual(record.admission, {
    counters: 'password_admission_denials_total',
    before: { global_pace: 3, source_rate: 0 },
    after: { global_pace: 5, source_rate: 1 },
    delta: { global_pace: 2, source_rate: 1 },
  })
  assert.ok(!JSON.stringify(record.admission).includes('rate_limit_hits_total'))
})

test('writes retry-layer.json and admission.json into the run directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-layer-'))
  const record = await observeSample()
  persistRetryLayer(directory, record)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(directory, 'retry-layer.json'), 'utf8')),
    record.retryLayer
  )
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(directory, 'admission.json'), 'utf8')),
    record.admission
  )
  // A second write cannot silently replace the first run's evidence.
  assert.throws(() => persistRetryLayer(directory, record), /EEXIST/)
  for (const name of ['retry-layer.json', 'admission.json'])
    assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600)
})

test('a failing report still writes the layer evidence, and capture never replaces its error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-layer-red-'))
  const record = await observeSample()
  const reportError = new Error('Incomplete, failed, flaky or skipped approved-tools report')
  let captured = false
  await assert.rejects(
    runLane({
      runPhase: () => {
        throw reportError
      },
      capture: async () => {
        captured = true
        persistRetryLayer(directory, record)
      },
      validate: () => assert.fail('a failed phase never validates a report'),
    }),
    error => error === reportError
  )
  assert.equal(captured, true, 'the capture ran on the failing report')
  assert.ok(fs.existsSync(path.join(directory, 'retry-layer.json')))
  assert.ok(fs.existsSync(path.join(directory, 'admission.json')))
})

test('a green report is failed by a broken capture, and the report error wins over it', async () => {
  const captureError = new Error('Retry layer observation failed')
  await assert.rejects(
    runLane({
      runPhase: () => {},
      capture: async () => {
        throw captureError
      },
      validate: () => ({ tests: 7 }),
    }),
    error => error === captureError
  )
  const reportError = new Error('Case not green: native workflow')
  await assert.rejects(
    runLane({
      runPhase: () => {},
      capture: async () => {
        throw captureError
      },
      validate: () => {
        throw reportError
      },
    }),
    error => error === reportError
  )
  assert.deepEqual(
    await runLane({
      runPhase: () => {},
      capture: async () => {},
      validate: () => ({ tests: 7 }),
    }),
    { tests: 7 }
  )
})

test('the evidence origin must be one profile-owned loopback origin', () => {
  assert.equal(
    upstreamEvidenceOrigin([retryScenario]).href,
    'http://127.0.0.1:43111/approved-tools/evidence'
  )
  assert.throws(() => upstreamEvidenceOrigin([]), /at least one prepared scenario/)
  assert.throws(
    () =>
      upstreamEvidenceOrigin([
        retryScenario,
        { ...retryScenario, upstreamEvidenceUrl: 'http://127.0.0.1:43112' },
      ]),
    /disagree on the evidence origin/
  )
  assert.throws(
    () =>
      upstreamEvidenceOrigin([{ ...retryScenario, upstreamEvidenceUrl: 'https://example.test' }]),
    /loopback/
  )
})
