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
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
const suites = report?.testResults ?? []
const matchingSuites = suites.filter(suite =>
  String(suite.name).replaceAll('\\', '/').endsWith(target)
)
const assertions = matchingSuites.flatMap(suite => suite.assertionResults ?? [])
const failed = assertions.filter(assertion => assertion.status === 'failed').length
const pending = assertions.filter(assertion => assertion.status === 'pending').length
const skipped = assertions.filter(assertion => assertion.status === 'skipped').length
const todo = assertions.filter(assertion => assertion.status === 'todo').length
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
const reportSuccess = Boolean(report?.success)
const success = Boolean(
  meta.exitCode === 0 &&
  !meta.watchdogExpired &&
  matchingSuites.length === 1 &&
  total > 0 &&
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
  passed: assertions.filter(assertion => assertion.status === 'passed').length,
  failed,
  skipped: allowedPending,
  unexpectedSkipCount: unexpectedSkips.length,
  watchdogExpired: Boolean(meta.watchdogExpired),
  elapsedSeconds: Number(meta.elapsedSeconds),
  success,
}
writeFileSync(outputPath, `${JSON.stringify(safe, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(safe)}\n`)
if (!success) process.exitCode = 1
