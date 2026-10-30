import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot || !path.isAbsolute(scratchRoot)) {
  throw new Error('CODEX_SCRATCH_ROOT must name the configured absolute scratch directory')
}

const here = path.dirname(fileURLToPath(import.meta.url))
const sanitizer =
  process.env.PR977_SANITIZER_PATH ?? path.join(here, 'sanitize-windows-vitest-report.mjs')
const workflowPath =
  process.env.PR977_FOCUSED_WORKFLOW_PATH ??
  path.join(here, '../../.github/workflows/pr977-windows-focused.yml')
const tempParent = path.join(scratchRoot, 'evenfire')
mkdirSync(tempParent, { recursive: true })
const tempRoot = mkdtempSync(path.join(tempParent, 'pr977-acl-sanitizer-fixtures-'))
process.on('exit', () => rmSync(tempRoot, { recursive: true, force: true }))

const focusedWorkflow = readFileSync(workflowPath, 'utf8')
assert.ok(
  !/^\s*continue-on-error:\s*true\s*$/m.test(focusedWorkflow),
  'Focused ACL workflow must fail the job when native assertions fail'
)

function runCase(name, report) {
  const input = path.join(tempRoot, `${name}-input.json`)
  const output = path.join(tempRoot, `${name}-output.json`)
  writeFileSync(input, `${JSON.stringify(report)}\n`)
  const result = spawnSync(process.execPath, [sanitizer, input, output], { encoding: 'utf8' })
  const sanitized = JSON.parse(readFileSync(output, 'utf8'))
  return { result, sanitized }
}

function report({ success, suites, totals, assertions }) {
  return {
    success,
    numTotalTestSuites: totals.suites,
    numPassedTestSuites: totals.passedSuites,
    numFailedTestSuites: totals.failedSuites,
    numPendingTestSuites: 0,
    numTotalTests: totals.tests,
    numPassedTests: totals.passed,
    numFailedTests: totals.failed,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: suites.map((status, index) => ({
      name: `src/__tests__/case-${index + 1}.test.ts`,
      status,
      assertionResults: assertions[index],
    })),
  }
}

const passedAssertion = { status: 'passed', title: 'controlled passing assertion' }
const passing = runCase(
  'passing',
  report({
    success: true,
    suites: ['passed'],
    totals: { suites: 1, passedSuites: 1, failedSuites: 0, tests: 1, passed: 1, failed: 0 },
    assertions: [[passedAssertion]],
  })
)
assert.equal(passing.result.status, 0)
assert.equal(passing.sanitized.success, true)
assert.equal(passing.sanitized.counterConsistency.valid, true)

const rawVerifierFailure = JSON.stringify({
  phase: 'acl-verifier-rejected',
  processStarted: true,
  exitStatus: 1,
  stdoutPresent: true,
  stderrPresent: false,
  verifierExecutionPhase: 'validate-authority-tree',
  verifierErrorType: 'UnauthorizedAccessException',
  verifierHresult: '0x80070005',
  verifierDetail: 'unsafe-ace',
  verifierOwnerClass: 'everyone',
  privatePath: 'C:\\Users\\private\\credentials.json',
  rawDescriptor: 'SENSITIVE-SECURITY-DESCRIPTOR',
})
const failed = runCase(
  'verifier-failure',
  report({
    success: false,
    suites: ['failed'],
    totals: { suites: 1, passedSuites: 0, failedSuites: 1, tests: 1, passed: 0, failed: 1 },
    assertions: [
      [
        {
          status: 'failed',
          title: 'rejects an unsafe ACL on an existing child',
          failureMessages: [
            `Error: Windows session authority ACL verification failed: ${rawVerifierFailure}`,
          ],
        },
      ],
    ],
  })
)
assert.equal(failed.result.status, 0)
assert.equal(failed.sanitized.success, false)
assert.equal(
  failed.sanitized.testResults[0].assertionResults[0].failure.category,
  'native-verifier'
)
assert.equal(
  failed.sanitized.testResults[0].assertionResults[0].failure.diagnostic.verifierExecutionPhase,
  'validate-authority-tree'
)
assert.equal(
  failed.sanitized.testResults[0].assertionResults[0].failure.diagnostic.verifierOwnerClass,
  'everyone'
)
assert.doesNotMatch(JSON.stringify(failed.sanitized), /private|SENSITIVE|credentials\.json/i)

const assertionMismatch = runCase(
  'assertion-mismatch',
  report({
    success: false,
    suites: ['failed'],
    totals: { suites: 1, passedSuites: 0, failedSuites: 1, tests: 1, passed: 0, failed: 1 },
    assertions: [
      [
        {
          status: 'failed',
          title: 'rejects an unsafe ACL on an existing child',
          failureMessages: ['AssertionError: expected [Function] to throw an error'],
        },
      ],
    ],
  })
)
assert.equal(
  assertionMismatch.sanitized.testResults[0].assertionResults[0].failure.category,
  'expected-rejection-not-observed'
)

const inconsistent = runCase(
  'inconsistent-counters',
  report({
    success: false,
    suites: ['failed'],
    totals: { suites: 2, passedSuites: 1, failedSuites: 1, tests: 2, passed: 0, failed: 1 },
    assertions: [
      [
        {
          status: 'failed',
          title: 'controlled failing assertion',
          failureMessages: ['AssertionError: controlled failure'],
        },
      ],
    ],
  })
)
assert.equal(inconsistent.result.status, 1)
assert.equal(inconsistent.sanitized.success, false)
assert.equal(inconsistent.sanitized.counterConsistency.valid, false)
assert.equal(inconsistent.sanitized.numFailedTests, 1)
assert.equal(inconsistent.sanitized.testResults[0].assertionResults[0].status, 'failed')

const nativeFixtureFailure = runCase(
  'native-fixture-failure',
  report({
    success: false,
    suites: ['failed'],
    totals: { suites: 1, passedSuites: 0, failedSuites: 1, tests: 1, passed: 0, failed: 1 },
    assertions: [
      [
        {
          status: 'failed',
          title: 'provisions a protected authority directory',
          failureMessages: [
            'Error: Native Windows ACL fixture failed: ' +
              JSON.stringify({
                operation: 'add-everyone-modify',
                processStarted: true,
                processErrorCode: 'ENOENT',
                exitStatus: 1,
                processSignaled: false,
                stdoutPresent: false,
                stderrPresent: true,
                powershellFailureCategory: 'access-denied',
                errorType: 'UnauthorizedAccessException',
                hresult: '0x80070005',
              }),
          ],
        },
      ],
    ],
  })
)
assert.equal(
  nativeFixtureFailure.sanitized.testResults[0].assertionResults[0].failure.category,
  'native-fixture'
)
assert.equal(
  nativeFixtureFailure.sanitized.testResults[0].assertionResults[0].failure.diagnostic.operation,
  'add-everyone-modify'
)

const collectionFailure = runCase('collection-module-resolution-failure', {
  success: false,
  numTotalTestSuites: 1,
  numPassedTestSuites: 0,
  numFailedTestSuites: 1,
  numPendingTestSuites: 0,
  numTotalTests: 0,
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [
    {
      name: 'test/__tests__/gfsDragAndDropGate.test.ts',
      status: 'failed',
      assertionResults: [],
      diagnosticErrors: [
        {
          name: 'Error',
          code: 'ERR_MODULE_NOT_FOUND',
          message: 'Cannot find module private-package from C:\\Users\\private\\path',
          phase: 'collection',
          failedHooks: [],
        },
      ],
    },
  ],
})
assert.equal(collectionFailure.result.status, 0)
assert.equal(collectionFailure.sanitized.success, false)
assert.equal(collectionFailure.sanitized.testResults[0].failure.phase, 'collection')
assert.equal(collectionFailure.sanitized.testResults[0].failure.category, 'module-resolution')
assert.equal(collectionFailure.sanitized.testResults[0].failure.code, 'ERR_MODULE_NOT_FOUND')
assert.doesNotMatch(
  JSON.stringify(collectionFailure.sanitized),
  /private-package|Users|private\\path/
)

const selectedReport = path.join(tempRoot, 'passing-output.json')
const selectedManifest = path.join(tempRoot, 'selected-targets.txt')
const selectedCaseManifest = path.join(tempRoot, 'selected-cases.json')
const selectedProgress = path.join(tempRoot, 'selected-progress.jsonl')
const selectedCases = [
  'verifies the real user-data, consent directory, and produced consent file',
  'rejects an unsafe existing consent file without reading or overwriting it',
  'rejects an unsafe user-data parent before creating consent files',
  'verifies actual audit files and the rotated generation',
]
const deselectedCases = [
  'rechecks a replaced consent file instead of returning cached grants',
  'rechecks a replaced consent directory before returning cached grants',
  'retains inherited effective access after an atomic consent replacement',
  'preserves consent corruption recovery as a verified inherited-DACL file',
  'rejects an in-place DACL change without a filesystem identity change',
  'rejects consent when the produced atomic replacement becomes unsafe',
  'does not append after rotated audit verification rejects the destination',
  'does not append to an audit file with unauthorized effective access',
]
const focusedSummary = {
  ...passing.sanitized,
  numTotalTests: selectedCases.length + deselectedCases.length,
  numPassedTests: selectedCases.length,
  numPendingTests: deselectedCases.length,
  numFailedTests: 0,
  numTodoTests: 0,
  counterConsistency: { valid: true, discrepancies: [] },
  success: true,
  numTestFiles: 1,
  testResults: [
    {
      name: 'src/__tests__/pluginStorageWindowsAcl.native.test.ts',
      status: 'passed',
      assertionResults: [
        ...selectedCases.map(title => ({ title, status: 'passed' })),
        ...deselectedCases.map(title => ({ title, status: 'pending' })),
      ],
    },
  ],
}
writeFileSync(selectedReport, `${JSON.stringify(focusedSummary)}\n`)
writeFileSync(selectedManifest, 'src/__tests__/pluginStorageWindowsAcl.native.test.ts\n')
writeFileSync(
  selectedCaseManifest,
  `${JSON.stringify({ selected: selectedCases, deselected: deselectedCases })}\n`
)
const cleanupProgress = []
for (let cycle = 0; cycle < selectedCases.length; cycle += 1) {
  for (const cleanupPhase of [
    'cleanup-start',
    'enumeration-start',
    'enumeration-complete',
    'entry-file-delete-start',
    'entry-delete-complete',
    'directory-remove-complete',
    'cleanup-complete',
  ]) {
    cleanupProgress.push({
      elapsedMs: cleanupProgress.length,
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
      cleanupOrdinal: 0,
      cleanupElapsedMs: 0,
    })
  }
}
writeFileSync(
  selectedProgress,
  `${cleanupProgress.map(event => JSON.stringify(event)).join('\n')}\n`
)
const selectedPass = spawnSync(
  process.execPath,
  [
    path.join(here, 'verify-focused-windows-report.mjs'),
    selectedReport,
    selectedManifest,
    selectedCaseManifest,
    selectedProgress,
  ],
  { encoding: 'utf8' }
)
assert.equal(selectedPass.status, 0)
const unsafeProgress = path.join(tempRoot, 'unsafe-progress.jsonl')
writeFileSync(
  unsafeProgress,
  `${JSON.stringify({ ...cleanupProgress[0], path: 'C:\\\\private\\\\fixture' })}\n`
)
const unsafeProgressResult = spawnSync(
  process.execPath,
  [
    path.join(here, 'verify-focused-windows-report.mjs'),
    selectedReport,
    selectedManifest,
    selectedCaseManifest,
    unsafeProgress,
  ],
  { encoding: 'utf8' }
)
assert.equal(unsafeProgressResult.status, 1, 'Path-bearing cleanup progress must be rejected')
assert.match(unsafeProgressResult.stderr, /Cleanup progress contains an unsafe or malformed record/)
const selectedFailure = structuredClone(focusedSummary)
selectedFailure.testResults[0].assertionResults[0].status = 'failed'
writeFileSync(selectedReport, `${JSON.stringify(selectedFailure)}\n`)
const selectedRejected = spawnSync(
  process.execPath,
  [
    path.join(here, 'verify-focused-windows-report.mjs'),
    selectedReport,
    selectedManifest,
    selectedCaseManifest,
    selectedProgress,
  ],
  { encoding: 'utf8' }
)
assert.equal(selectedRejected.status, 1, 'A failed selected case must fail verification')
const unexpectedSkip = structuredClone(focusedSummary)
unexpectedSkip.testResults[0].assertionResults[0].status = 'pending'
writeFileSync(selectedReport, `${JSON.stringify(unexpectedSkip)}\n`)
const skippedRequired = spawnSync(
  process.execPath,
  [
    path.join(here, 'verify-focused-windows-report.mjs'),
    selectedReport,
    selectedManifest,
    selectedCaseManifest,
    selectedProgress,
  ],
  { encoding: 'utf8' }
)
assert.equal(skippedRequired.status, 1, 'A skipped selected case must fail verification')
const unexpectedCase = structuredClone(focusedSummary)
unexpectedCase.testResults[0].assertionResults.push({
  title: 'an unexpected case executed',
  status: 'passed',
})
writeFileSync(selectedReport, `${JSON.stringify(unexpectedCase)}\n`)
const unexpectedCaseResult = spawnSync(
  process.execPath,
  [
    path.join(here, 'verify-focused-windows-report.mjs'),
    selectedReport,
    selectedManifest,
    selectedCaseManifest,
    selectedProgress,
  ],
  { encoding: 'utf8' }
)
assert.equal(unexpectedCaseResult.status, 1, 'An unexpected executed case must fail verification')
writeFileSync(selectedManifest, 'src/__tests__/case-1.test.ts\nsrc/__tests__/missing.test.ts\n')
const selectedMissing = spawnSync(
  process.execPath,
  [
    path.join(here, 'verify-focused-windows-report.mjs'),
    selectedReport,
    selectedManifest,
    selectedCaseManifest,
    selectedProgress,
  ],
  { encoding: 'utf8' }
)
assert.equal(selectedMissing.status, 1, 'Missing required selected files must fail verification')

rmSync(tempRoot, { recursive: true, force: true })
process.stdout.write(
  'Sanitized Windows report fixtures passed (including selected-case and intentional-deselection enforcement).\n'
)
