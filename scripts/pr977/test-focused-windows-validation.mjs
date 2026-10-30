import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregateFocusedResults,
  executeFocusedSequence,
  focusedCaseCount,
  focusedTestNamePattern,
  validateFocusedManifest,
} from './focused-windows-plan.mjs'
import { verifyFocusedProcess } from './verify-focused-windows-report.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(
  readFileSync(path.join(here, '../../.validation/windows/focused-test-cases.json'), 'utf8')
)
const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot || !path.isAbsolute(scratchRoot))
  throw new Error('CODEX_SCRATCH_ROOT must name the configured absolute scratch directory')
const scratchParent = path.join(scratchRoot, 'evenfire')
mkdirSync(scratchParent, { recursive: true })
const fixtureRoot = mkdtempSync(path.join(scratchParent, 'pr977-focused-validation-'))
const sourceSha = 'a'.repeat(40)
const harnessSha = 'b'.repeat(40)
const targetPath = path.join(fixtureRoot, 'targets.txt')
const manifestPath = path.join(fixtureRoot, 'cases.json')
const identityPath = path.join(fixtureRoot, 'identity.json')
writeFileSync(targetPath, 'src/__tests__/pluginStorageWindowsAcl.native.test.ts\n')
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
writeFileSync(
  identityPath,
  `${JSON.stringify({
    sourceSha,
    harnessSha,
    expectedSourceSha: sourceSha,
    expectedHarnessSha: harnessSha,
  })}\n`
)
validateFocusedManifest(manifest)
const totalCases = focusedCaseCount(manifest)
assert.equal(totalCases, 14)

const duplicateManifest = structuredClone(manifest)
duplicateManifest.processes[1].selected.push(duplicateManifest.processes[0].selected[0])
assert.throws(() => validateFocusedManifest(duplicateManifest), /hard runtime limits/)
const unrecordedDeselection = structuredClone(manifest)
unrecordedDeselection.deselected[0] = 'unrecorded test case'
assert.throws(
  () => validateFocusedManifest(unrecordedDeselection),
  /five selected and nine deselected/
)
const zeroSelection = structuredClone(manifest)
zeroSelection.selected = []
assert.throws(() => validateFocusedManifest(zeroSelection), /five selected/)
const staleBudget = structuredClone(manifest)
staleBudget.processes[1].maximumRuntimeMs = 360_000
assert.throws(() => validateFocusedManifest(staleBudget), /hard runtime limits/)

for (const spec of manifest.processes) {
  const pattern = new RegExp(focusedTestNamePattern(spec))
  for (const title of spec.selected)
    assert.equal(pattern.test(`Windows plugin storage DACL privacy ${title}`), true)
  for (const title of manifest.selected.filter(title => !spec.selected.includes(title)))
    assert.equal(pattern.test(`Windows plugin storage DACL privacy ${title}`), false)
  for (const title of manifest.deselected)
    assert.equal(pattern.test(`Windows plugin storage DACL privacy ${title}`), false)
  assert.equal(
    pattern.test(`Windows plugin storage DACL privacy prefix ${spec.selected[0]} suffix`),
    false
  )
}

function createFixture(processId) {
  writeFileSync(
    identityPath,
    JSON.stringify({
      sourceSha,
      harnessSha,
      expectedSourceSha: sourceSha,
      expectedHarnessSha: harnessSha,
    })
  )
  const processSpec = manifest.processes.find(value => value.id === processId)
  const processCases = new Set(processSpec.selected)
  const assertions = [...manifest.selected, ...manifest.deselected].map(title => ({
    title,
    status: processCases.has(title) ? 'passed' : 'pending',
  }))
  const passed = processSpec.selected.length
  const skipped = totalCases - passed
  const reportPath = path.join(fixtureRoot, `${processId}-report.json`)
  const progressPath = path.join(fixtureRoot, `${processId}-progress.jsonl`)
  const statusPath = path.join(fixtureRoot, `${processId}-status.json`)
  const outputPath = path.join(fixtureRoot, `${processId}-verified.json`)
  const report = {
    success: true,
    numTestFiles: 1,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: totalCases,
    numPassedTests: passed,
    numFailedTests: 0,
    numPendingTests: skipped,
    numTodoTests: 0,
    counterConsistency: { valid: true, discrepancies: [] },
    testResults: [
      {
        name: 'src/__tests__/pluginStorageWindowsAcl.native.test.ts',
        status: 'passed',
        assertionResults: assertions,
      },
    ],
  }
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`)
  const progress = []
  for (let ordinal = 1; ordinal <= passed; ordinal += 1) {
    const cleanupEvents = [
      ['cleanup-start', 0],
      ['enumeration-start', 0],
      ['enumeration-complete', 0],
      ['directory-remove-complete', 2],
      ['cleanup-complete', 2],
    ]
    if (ordinal === 1)
      cleanupEvents.splice(
        3,
        0,
        ['entry-file-delete-start', 1],
        ['entry-delete-complete', 1],
        ['entry-file-delete-start', 2],
        ['entry-delete-complete', 2]
      )
    for (const [cleanupPhase, cleanupOrdinal] of cleanupEvents) {
      progress.push({
        elapsedMs: progress.length,
        event: 'plugin-acl-cleanup-phase',
        activeFile: 'pluginStorageWindowsAcl.native.test.ts',
        activeCase: null,
        activeHook: 'afterEach',
        lastCompletedOperation: cleanupPhase,
        filesStarted: 1,
        filesCompleted: 0,
        casesCompleted: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        cleanupPhase,
        cleanupOrdinal,
        cleanupElapsedMs: 5,
      })
    }
  }
  const terminal = {
    elapsedMs: progress.length,
    event: 'run-completed',
    runReason: 'passed',
    activeFile: null,
    activeCase: null,
    activeHook: null,
    lastCompletedOperation: 'run-completed',
    filesStarted: 1,
    filesCompleted: 1,
    casesCompleted: totalCases,
    passed,
    failed: 0,
    skipped,
  }
  progress.push(terminal)
  writeFileSync(progressPath, `${progress.map(value => JSON.stringify(value)).join('\n')}\n`)
  writeFileSync(
    statusPath,
    `${JSON.stringify({
      outcome: 'completed',
      exitCode: 0,
      signal: null,
      elapsedMs: 10_000,
      lastProgress: terminal,
    })}\n`
  )
  return {
    reportPath,
    progressPath,
    statusPath,
    outputPath,
    processId,
    targetPath,
    caseManifestPath: manifestPath,
    identityPath,
    expectedSourceSha: sourceSha,
    expectedHarnessSha: harnessSha,
  }
}

function verify(processId) {
  return verifyFocusedProcess(createFixture(processId))
}

try {
  const consent = verify('consent')
  const audit = verify('audit-rotation')
  assert.equal(consent.passed, 4)
  assert.equal(consent.skippedInProcess, 10)
  assert.equal(audit.passed, 1)
  assert.equal(audit.skippedInProcess, 13)
  const aggregate = aggregateFocusedResults([consent, audit], manifest)
  assert.equal(aggregate.requiredCases, 5)
  assert.equal(aggregate.passedRequiredCases, 5)
  assert.equal(aggregate.intentionallyDeselectedCases, 9)
  assert.equal(aggregate.intentionallyDeselectedSkippedInEachProcess, 9)
  assert.equal(aggregate.deferredRequiredCaseSkipsAcrossProcesses, 5)
  assert.equal(aggregate.totalProcessElapsedMs, 20_000)

  const historicalArtifact = path.join(here, 'fixtures/focused-run-41128010590/process-consent')
  const historicalResult = verifyFocusedProcess({
    reportPath: path.join(historicalArtifact, 'focused-report.fixture'),
    targetPath,
    caseManifestPath: path.join(here, '../../.validation/windows/focused-test-cases.json'),
    progressPath: path.join(historicalArtifact, 'progress.fixture'),
    statusPath: path.join(historicalArtifact, 'watchdog-status.fixture'),
    identityPath: path.join(historicalArtifact, 'source-identity.fixture'),
    processId: 'consent',
    expectedSourceSha: '0725bd5b872682c49c231225eda98aaea21fc16a',
    expectedHarnessSha: '788b943f172dfcb2b3c5998a15c61035ab8973ee',
  })
  assert.deepEqual(historicalResult.selected, manifest.processes[0].selected)
  assert.equal(historicalResult.passed, 4)
  assert.equal(historicalResult.skippedInProcess, 10)
  assert.equal(historicalResult.elapsedMs, 292_920)

  for (const [name, mutate] of [
    [
      'selected skip',
      fixture => {
        const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8'))
        report.testResults[0].assertionResults[0].status = 'pending'
        writeFileSync(fixture.reportPath, JSON.stringify(report))
      },
    ],
    [
      'missing required case',
      fixture => {
        const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8'))
        report.testResults[0].assertionResults.pop()
        writeFileSync(fixture.reportPath, JSON.stringify(report))
      },
    ],
    [
      'duplicate case',
      fixture => {
        const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8'))
        report.testResults[0].assertionResults.push(report.testResults[0].assertionResults[0])
        writeFileSync(fixture.reportPath, JSON.stringify(report))
      },
    ],
    [
      'unexpected case',
      fixture => {
        const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8'))
        report.testResults[0].assertionResults[0].title = 'unexpected native test'
        writeFileSync(fixture.reportPath, JSON.stringify(report))
      },
    ],
    [
      'failed assertion',
      fixture => {
        const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8'))
        report.success = false
        report.numFailedTests = 1
        report.testResults[0].assertionResults[0].status = 'failed'
        writeFileSync(fixture.reportPath, JSON.stringify(report))
      },
    ],
    [
      'inconsistent counters',
      fixture => {
        const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8'))
        report.counterConsistency.valid = false
        writeFileSync(fixture.reportPath, JSON.stringify(report))
      },
    ],
    [
      'expired watchdog',
      fixture => {
        writeFileSync(
          fixture.statusPath,
          JSON.stringify({
            outcome: 'watchdog-expired',
            reason: 'maximum-runtime',
            elapsedMs: 345_001,
          })
        )
      },
    ],
    [
      'malformed watchdog report',
      fixture => {
        writeFileSync(fixture.statusPath, '{')
      },
    ],
    [
      'wrong source SHA',
      fixture => {
        writeFileSync(
          fixture.identityPath,
          JSON.stringify({
            sourceSha: 'c'.repeat(40),
            harnessSha,
            expectedSourceSha: sourceSha,
            expectedHarnessSha: harnessSha,
          })
        )
      },
    ],
    [
      'wrong harness SHA',
      fixture => {
        writeFileSync(
          fixture.identityPath,
          JSON.stringify({
            sourceSha,
            harnessSha: 'c'.repeat(40),
            expectedSourceSha: sourceSha,
            expectedHarnessSha: harnessSha,
          })
        )
      },
    ],
    [
      'fatal cleanup failure',
      fixture => {
        const progress = readFileSync(fixture.progressPath, 'utf8').trim().split(/\r?\n/)
        const cleanup = JSON.parse(progress[0])
        cleanup.cleanupPhase = 'cleanup-failed'
        progress[0] = JSON.stringify(cleanup)
        writeFileSync(fixture.progressPath, `${progress.join('\n')}\n`)
      },
    ],
    [
      'duplicate cleanup phase',
      fixture => {
        const progress = readFileSync(fixture.progressPath, 'utf8').trim().split(/\r?\n/)
        progress.splice(3, 0, progress[2])
        writeFileSync(fixture.progressPath, `${progress.join('\n')}\n`)
      },
    ],
    [
      'sensitive reporter field',
      fixture => {
        const progress = readFileSync(fixture.progressPath, 'utf8').trim().split(/\r?\n/)
        const terminal = JSON.parse(progress.at(-1))
        terminal.privatePath = 'C:\\Users\\private\\secret.txt'
        progress[progress.length - 1] = JSON.stringify(terminal)
        writeFileSync(fixture.progressPath, `${progress.join('\n')}\n`)
      },
    ],
  ]) {
    const fixture = createFixture('consent')
    mutate(fixture)
    assert.throws(() => verifyFocusedProcess(fixture), undefined, name)
  }

  const missingReport = createFixture('consent')
  rmSync(missingReport.reportPath)
  assert.throws(() => verifyFocusedProcess(missingReport), /missing or malformed/)
  const malformedReport = createFixture('consent')
  writeFileSync(malformedReport.reportPath, '{')
  assert.throws(() => verifyFocusedProcess(malformedReport), /missing or malformed/)
  const missingProgress = createFixture('consent')
  rmSync(missingProgress.progressPath)
  assert.throws(() => verifyFocusedProcess(missingProgress))

  const aggregateVariants = [
    [[consent], /missing one or more process results/],
    [[consent, { ...audit, processId: 'consent' }], /did not produce complete passing evidence/],
    [[consent, { ...audit, sourceSha: 'c'.repeat(40) }], /exact-source selected cases/],
    [
      [consent, { ...audit, selected: [consent.selected[0]] }],
      /did not produce complete passing evidence/,
    ],
    [[consent, { ...audit, elapsedMs: 180_001 }], /did not produce complete passing evidence/],
  ]
  for (const [results, expectedError] of aggregateVariants)
    assert.throws(() => aggregateFocusedResults(results, manifest), expectedError)

  for (const failure of [
    { name: 'test assertion', message: 'Vitest exited 1 with failed assertions' },
    { name: 'timeout', message: 'watchdog maximum-runtime expired' },
    { name: 'collection error', message: 'collection failed before tests ran' },
    { name: 'process termination', message: 'child was terminated by SIGTERM' },
    { name: 'missing report', message: 'sanitized report was not produced' },
  ]) {
    const started = []
    await assert.rejects(
      executeFocusedSequence(manifest, async spec => {
        started.push(spec.id)
        if (spec.id === 'consent') throw new Error(failure.message)
        return audit
      }),
      new RegExp(failure.message)
    )
    assert.deepEqual(started, ['consent'], `${failure.name} must prevent Process B`)
  }

  const invalidConsentStarted = []
  await assert.rejects(
    executeFocusedSequence(manifest, async spec => {
      invalidConsentStarted.push(spec.id)
      return { ...consent, passed: 3 }
    }),
    /did not produce complete passing evidence/
  )
  assert.deepEqual(invalidConsentStarted, ['consent'])

  const bothStarted = []
  const successfulSequence = await executeFocusedSequence(manifest, async spec => {
    bothStarted.push(spec.id)
    return spec.id === 'consent' ? consent : audit
  })
  assert.deepEqual(bothStarted, ['consent', 'audit-rotation'])
  assert.equal(successfulSequence.passedRequiredCases, 5)

  bothStarted.length = 0
  await assert.rejects(
    executeFocusedSequence(manifest, async spec => {
      bothStarted.push(spec.id)
      if (spec.id === 'consent') return consent
      throw new Error('audit process failed')
    }),
    /audit process failed/
  )
  assert.deepEqual(bothStarted, ['consent', 'audit-rotation'])
  process.stdout.write(
    'Focused process selection, SHA/report/counter/cleanup rejection, sequential gating, and aggregation passed.\n'
  )
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
