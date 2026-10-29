import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot || !path.isAbsolute(scratchRoot)) {
  throw new Error('CODEX_SCRATCH_ROOT must name the configured absolute scratch directory')
}

const here = path.dirname(fileURLToPath(import.meta.url))
const sanitizer =
  process.env.PR977_SANITIZER_PATH ?? path.join(here, 'sanitize-windows-vitest-report.mjs')
const tempRoot = mkdtempSync(path.join(scratchRoot, 'evenfire', 'pr977-acl-sanitizer-fixtures-'))
process.on('exit', () => rmSync(tempRoot, { recursive: true, force: true }))

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
    totals: { suites: 2, passedSuites: 1, failedSuites: 1, tests: 1, passed: 0, failed: 1 },
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

rmSync(tempRoot, { recursive: true, force: true })
process.stdout.write(
  'Sanitized Windows Vitest report fixtures passed (pass, verifier, assertion, mismatch, fixture).\n'
)
