import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [reportPath, metaPath, outputPath] = process.argv.slice(2)
const allowedTargets = new Set([
  'tokenStore.markerOperationsDrain.test.ts',
  'appService.acceptedPriorRecovery.regression.test.ts',
  'appService.passwordLoginRollback.regression.test.ts',
  'appService.pendingExternalLogoutKeytarUnavailable.test.ts',
  'appService.persistenceMutation.contract.test.ts',
  'windowsSessionAuthorityAcl.native.test.ts',
  'windowsSessionAuthorityDurableFileOps.native.test.ts',
])
const targets = (process.env.PR977_AUTH_TEST_FILES ?? '')
  .split(',')
  .map(target => target.trim())
  .filter(Boolean)
if (
  !reportPath ||
  !metaPath ||
  !outputPath ||
  targets.length === 0 ||
  new Set(targets).size !== targets.length ||
  targets.some(candidate => !allowedTargets.has(candidate))
) {
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
  targets.some(candidate => String(suite.name).replaceAll('\\', '/').endsWith(candidate))
)
const suitesByTarget = targets.map(candidate =>
  matchingSuites.filter(suite => String(suite.name).replaceAll('\\', '/').endsWith(candidate))
)
const assertions = matchingSuites.flatMap(suite => suite.assertionResults ?? [])
const failed = assertions.filter(assertion => assertion.status === 'failed').length
const pending = assertions.filter(assertion => assertion.status === 'pending').length
const skipped = assertions.filter(assertion => assertion.status === 'skipped').length
const todo = assertions.filter(assertion => assertion.status === 'todo').length
const passed = assertions.filter(assertion => assertion.status === 'passed').length
const allowedPending = targets.includes('appService.pendingExternalLogoutKeytarUnavailable.test.ts')
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
      targets.includes('appService.pendingExternalLogoutKeytarUnavailable.test.ts') &&
      name.includes('uses memory-only mode when Linux safeStorage selects the basic_text backend')
    )
)
const expectedSkipCount = targets.includes(
  'appService.pendingExternalLogoutKeytarUnavailable.test.ts'
)
  ? 1
  : 0
const total = assertions.length
const reportSuccess = report?.success === true
const targetSuitesPassed =
  suitesByTarget.length === targets.length &&
  suitesByTarget.every(
    matches =>
      matches.length === 1 &&
      matches[0].status === 'passed' &&
      matches[0].assertionResults.length > 0 &&
      matches[0].assertionResults.some(assertion => assertion.status === 'passed')
  )
const sourceBlobs = Array.isArray(meta.sourceTestBlobs) ? meta.sourceTestBlobs : []
const sourceProvenanceMatches =
  meta.sourceTestBlobMatchesPin === true &&
  Array.isArray(meta.testFiles) &&
  meta.testFiles.length === targets.length &&
  meta.testFiles.every((file, index) => file === targets[index]) &&
  sourceBlobs.length === targets.length &&
  sourceBlobs.every(
    (entry, index) => entry?.file === targets[index] && /^[a-f0-9]{40}$/.test(entry.gitBlob ?? '')
  )
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
  'source-test-not-found',
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
      : suites.length !== targets.length || matchingSuites.length !== targets.length
        ? 'report-selection-mismatch'
        : !sourceProvenanceMatches
          ? 'source-test-provenance-mismatch'
          : !summaryMatchesResults
            ? 'invalid-report'
            : (failed > 0 || !targetSuitesPassed || report.numFailedTestSuites > 0) &&
                /timed? ?out|timeout|exceeded.*time/i.test(failureDetails)
              ? 'test-timeout'
              : failed > 0
                ? 'assertion-failure'
                : !targetSuitesPassed || report.numFailedTestSuites > 0
                  ? 'suite-failure'
                  : meta.failureClass && meta.failureClass !== 'none'
                    ? allowedProcessFailureClasses.has(meta.failureClass)
                      ? meta.failureClass
                      : 'process-failure'
                    : 'report-or-process-failure'
const allowedProgressMarkers = new Set([
  'none',
  'beforeEach-start',
  'module-reset-complete',
  'temp-directory-ready',
  'app-service-import-start',
  'app-service-import-complete',
  'beforeEach-complete',
  'afterEach-start',
  'afterEach-unstub-complete',
  'afterEach-mocks-complete',
  'afterEach-directory-remove-start',
  'afterEach-directory-remove-complete',
  'afterEach-env-restore-complete',
  'afterEach-fixture-clear-complete',
  'afterEach-modules-reset-complete',
  'afterEach-complete',
  'fetch-request-start',
  'password-login-http-start',
  'password-login-http-response',
  'me-http-start',
  'me-http-response',
  'credential-write-start',
  'credential-write-complete',
  'pending-logout-start',
  'pending-logout-settled',
  'accepted-login-start',
  'accepted-login-settled',
  'acceptance-transaction-start',
  'acceptance-transaction-settled',
  'login-persistence-start',
  'login-persistence-settled',
  'test-1-start',
  'test-2-start',
  'test-3-start',
  'test-4-start',
  'test-5-start',
  'test-1-complete',
  'test-2-complete',
  'test-3-complete',
  'test-4-complete',
  'test-5-complete',
  'password-a-start',
  'password-a-complete',
  'authority-before-start',
  'authority-before-complete',
  'password-b-start',
  'password-b-complete',
  'authority-after-start',
  'authority-after-complete',
  'restart-initialize-start',
  'restart-initialize-complete',
  'test-1-complete',
  'transaction-reconcile-start',
  'transaction-reconcile-end',
  'transaction-plan-start',
  'transaction-plan-end',
  'transaction-begin-start',
  'transaction-begin-end',
  'transaction-prior-source-start',
  'transaction-prior-source-end',
  'transaction-publish-verify-start',
  'transaction-publish-verify-end',
  'transaction-execute-start',
  'transaction-execute-end',
  'acl-powershell-start',
  'acl-powershell-fast',
  'acl-powershell-slow',
  'acl-powershell-timeout',
  'fileops-powershell-start',
  'fileops-powershell-fast',
  'fileops-powershell-slow',
  'fileops-powershell-timeout',
])
const hasPasswordRollbackTarget = targets.includes(
  'appService.passwordLoginRollback.regression.test.ts'
)
const overlayValid =
  !hasPasswordRollbackTarget ||
  (meta.testOverlay === 'diagnostic-markers-only' &&
    /^[a-f0-9]{64}$/.test(meta.sourceTestSha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(meta.overlayTestSha256 ?? ''))
const progressMarker = allowedProgressMarkers.has(meta.lastProgressMarker)
  ? meta.lastProgressMarker
  : 'invalid-marker'
const phaseMarkersValid =
  Array.isArray(meta.phaseMarkers) &&
  meta.phaseMarkers.length <= 128 &&
  meta.phaseMarkers.every(marker => allowedProgressMarkers.has(marker))
const progressValid =
  !hasPasswordRollbackTarget ||
  (meta.sourceTestBlobMatchesPin === true &&
    /^[a-f0-9]{40}$/.test(meta.sourceTestGitBlob ?? '') &&
    Number.isInteger(meta.phaseMarkerCount) &&
    meta.phaseMarkerCount > 0 &&
    phaseMarkersValid &&
    meta.phaseMarkers.length === meta.phaseMarkerCount &&
    meta.phaseMarkers.at(-1) === progressMarker &&
    (meta.diagnosticScope === 'password-login-test-1-only'
      ? meta.completedTestCount === 1
      : meta.completedTestCount === 5) &&
    progressMarker === 'afterEach-complete')
const success = Boolean(
  meta.exitCode === 0 &&
  !meta.watchdogExpired &&
  suites.length === targets.length &&
  matchingSuites.length === targets.length &&
  targetSuitesPassed &&
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
  reportSuccess &&
  overlayValid &&
  sourceProvenanceMatches &&
  progressMarker !== 'invalid-marker' &&
  progressValid
)
const safe = {
  applicationSourceSha: process.env.PR977_SOURCE_SHA ?? null,
  workflowTriggerSha: process.env.GITHUB_SHA ?? null,
  harnessCheckoutSha: process.env.GITHUB_SHA ?? null,
  testOverlay: meta.testOverlay ?? 'none',
  sourceTestSha256: meta.sourceTestSha256 ?? null,
  overlayTestSha256: meta.overlayTestSha256 ?? null,
  sourceTestBlobMatchesPin: meta.sourceTestBlobMatchesPin ?? null,
  sourceTestGitBlob: meta.sourceTestGitBlob ?? null,
  sourceTestBlobs: sourceBlobs.map(entry => ({ file: entry.file, gitBlob: entry.gitBlob })),
  phaseMarkerCount: Number.isInteger(meta.phaseMarkerCount) ? meta.phaseMarkerCount : null,
  completedTestCount: Number.isInteger(meta.completedTestCount) ? meta.completedTestCount : null,
  lastProgressMarker: progressMarker,
  phaseMarkers: phaseMarkersValid ? meta.phaseMarkers : [],
  diagnosticScope:
    meta.diagnosticScope === 'password-login-test-1-only'
      ? 'password-login-test-1-only'
      : meta.diagnosticScope === 'two-focused-files'
        ? 'two-focused-files'
        : 'full-file',
  testFiles: targets,
  testFileResults: targets.map((file, index) => {
    const suite = suitesByTarget[index]?.[0]
    const results = suite?.assertionResults ?? []
    return {
      file,
      suiteStatus: suite?.status ?? null,
      total: results.length,
      passed: results.filter(assertion => assertion.status === 'passed').length,
      failed: results.filter(assertion => assertion.status === 'failed').length,
      skipped: results.filter(
        assertion => assertion.status === 'pending' || assertion.status === 'skipped'
      ).length,
    }
  }),
  reportedSuiteCount: suites.length,
  reportedNestedSuiteCount: report?.numTotalTestSuites ?? null,
  reportedTotalTests: report?.numTotalTests ?? null,
  reportSuccess,
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
