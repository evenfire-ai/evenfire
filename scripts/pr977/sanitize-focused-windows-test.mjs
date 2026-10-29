import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [reportPath, metaPath, outputPath] = process.argv.slice(2)
const allowedTargets = new Set([
  'appService.passwordLoginRollback.regression.test.ts',
  'appService.pendingExternalLogoutKeytarUnavailable.test.ts',
  'appService.persistenceMutation.contract.test.ts',
  'windowsSessionAuthorityAcl.native.test.ts',
  'windowsSessionAuthorityDurableFileOps.native.test.ts',
])
const target = process.env.PR977_AUTH_TEST_FILE ?? ''
if (!reportPath || !metaPath || !outputPath || !allowedTargets.has(target)) {
  throw new Error('Focused Windows result inputs are not allowlisted')
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
let report = null
let invalidReport = false
const reportPresent = existsSync(reportPath)
if (reportPresent) {
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    invalidReport = true
  }
}
const supportedStatuses = new Set(['passed', 'failed', 'pending', 'skipped', 'todo'])
const supportedSuiteStatuses = new Set(['passed', 'failed'])
if (
  reportPresent &&
  (report === null ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    typeof report.success !== 'boolean' ||
    !Array.isArray(report.testResults) ||
    ![
      'numTotalTestSuites',
      'numPassedTestSuites',
      'numFailedTestSuites',
      'numPendingTestSuites',
      'numTotalTests',
      'numPassedTests',
      'numFailedTests',
      'numPendingTests',
      'numTodoTests',
    ].every(key => Number.isInteger(report[key]) && report[key] >= 0) ||
    report.testResults.some(
      suite =>
        !suite ||
        typeof suite.name !== 'string' ||
        !supportedSuiteStatuses.has(suite.status) ||
        !Array.isArray(suite.assertionResults) ||
        suite.assertionResults.some(
          assertion =>
            !assertion ||
            !supportedStatuses.has(assertion.status) ||
            (assertion.failureMessages !== undefined && !Array.isArray(assertion.failureMessages))
        )
    ))
) {
  report = null
  invalidReport = true
}
const suites = report?.testResults ?? []
const matchingSuites = suites.filter(suite =>
  String(suite.name).replaceAll('\\', '/').endsWith(target)
)
const assertions = matchingSuites.flatMap(suite => suite.assertionResults ?? [])
const failed = assertions.filter(assertion => assertion.status === 'failed').length
const pending = assertions.filter(assertion => assertion.status === 'pending').length
const skipped = assertions.filter(assertion => assertion.status === 'skipped').length
const todo = assertions.filter(assertion => assertion.status === 'todo').length
const passed = assertions.filter(assertion => assertion.status === 'passed').length
const allowedPending =
  target === 'appService.pendingExternalLogoutKeytarUnavailable.test.ts'
    ? assertions.filter(
        assertion =>
          (assertion.status === 'pending' || assertion.status === 'skipped') &&
          String(assertion.fullName ?? assertion.title ?? '').includes(
            'uses memory-only mode when Linux safeStorage selects the basic_text backend'
          )
      ).length
    : 0
const skippedNames = assertions
  .filter(assertion => assertion.status === 'pending' || assertion.status === 'skipped')
  .map(assertion => String(assertion.fullName ?? assertion.title ?? ''))
const unexpectedSkips = skippedNames.filter(
  name =>
    !(
      target === 'appService.pendingExternalLogoutKeytarUnavailable.test.ts' &&
      name.includes('uses memory-only mode when Linux safeStorage selects the basic_text backend')
    )
)
const expectedSkipCount =
  target === 'appService.pendingExternalLogoutKeytarUnavailable.test.ts' ? 1 : 0
const total = assertions.length
const reportSuccess = report?.success === true
const targetSuitePassed = matchingSuites[0]?.status === 'passed'
const summaryMatchesResults = Boolean(
  report &&
  report.numTotalTests === total &&
  report.numPassedTests === passed &&
  report.numFailedTests === failed &&
  report.numPendingTests === pending + skipped &&
  report.numTodoTests === todo &&
  report.numTotalTestSuites ===
    report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites &&
  report.numTotalTestSuites >= suites.length
)
const allowedProcessFailureClasses = new Set([
  'no-test-files',
  'config-load',
  'invalid-option',
  'test-failure',
  'unclassified-process-failure',
])
const failureDetails = matchingSuites
  .map(suite => suite.message ?? '')
  .concat(
    matchingSuites
      .flatMap(suite => suite.assertionResults ?? [])
      .filter(assertion => assertion.status === 'failed')
      .flatMap(assertion => assertion.failureMessages ?? [])
  )
  .join('\n')
const failureClass = meta.watchdogExpired
  ? 'watchdog-expired'
  : !reportPresent
    ? 'missing-report'
    : invalidReport || !report
      ? 'invalid-report'
      : suites.length !== 1 || matchingSuites.length !== 1
        ? 'report-selection-mismatch'
        : !summaryMatchesResults
          ? 'invalid-report'
          : (failed > 0 || !targetSuitePassed || report.numFailedTestSuites > 0) &&
              /timed? ?out|timeout|exceeded.*time/i.test(failureDetails)
            ? 'test-timeout'
            : failed > 0
              ? 'assertion-failure'
              : !targetSuitePassed || report.numFailedTestSuites > 0
                ? 'suite-failure'
                : meta.failureClass && meta.failureClass !== 'none'
                  ? allowedProcessFailureClasses.has(meta.failureClass)
                    ? meta.failureClass
                    : 'process-failure'
                  : 'report-or-process-failure'
const success = Boolean(
  meta.exitCode === 0 &&
  !meta.watchdogExpired &&
  suites.length === 1 &&
  matchingSuites.length === 1 &&
  targetSuitePassed &&
  report.numFailedTestSuites === 0 &&
  total > 0 &&
  passed > 0 &&
  passed + failed + pending + skipped + todo === total &&
  summaryMatchesResults &&
  failed === 0 &&
  todo === 0 &&
  unexpectedSkips.length === 0 &&
  allowedPending === expectedSkipCount &&
  pending + skipped === expectedSkipCount &&
  reportSuccess
)
const safe = {
  applicationSourceSha: process.env.PR977_SOURCE_SHA ?? null,
  workflowTriggerSha: process.env.GITHUB_SHA ?? null,
  harnessCheckoutSha: process.env.GITHUB_SHA ?? null,
  testOverlay: 'none; checked-out application test source executed directly',
  testFile: target,
  total,
  passed,
  failed,
  skipped: allowedPending,
  unexpectedSkipCount: unexpectedSkips.length,
  watchdogExpired: Boolean(meta.watchdogExpired),
  failureClass: success ? 'none' : failureClass,
  elapsedSeconds: Number(meta.elapsedSeconds),
  success,
}
writeFileSync(outputPath, `${JSON.stringify(safe, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(safe)}\n`)
if (!success) process.exitCode = 1
