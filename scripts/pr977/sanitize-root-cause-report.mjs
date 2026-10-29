import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [kind, reportPath, phasePath, metaPath] = process.argv.slice(2)
if (!['auth', 'acl'].includes(kind) || !reportPath || !phasePath || !metaPath) {
  throw new Error('Expected diagnostic kind and report paths')
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
const phaseAllowlist = new Set([
  'hook-before-start',
  'hook-before-end',
  'hook-after-start',
  'hook-after-end',
  'test-start',
  'first-login-start',
  'first-login-end',
  'accepted-source-read-start',
  'accepted-source-read-end',
  'replacement-login-start',
  'replacement-login-end',
  'restart-start',
  'restart-end',
  'http-password-start',
  'http-me-start',
  'http-me-end',
  'keytar-get-start',
  'keytar-get-end',
  'keytar-set-start',
  'keytar-set-end',
  'keytar-delete-start',
  'keytar-delete-end',
  'chat-prepare-start',
  'chat-prepare-rejected',
  'chat-prepare-ready',
  'chat-bind-start',
  'chat-bind-end',
  'acl-provision-start',
  'acl-provision-end',
  'acl-provision-error',
  'acl-verify-start',
  'acl-verify-end',
  'acl-verify-error',
  'transaction-begin-start',
  'transaction-begin-end',
  'transaction-begin-error',
  'transaction-publish-start',
  'transaction-publish-end',
  'transaction-publish-error',
  'read-existing-acl',
  'set-owner',
  'write-acl',
  'read-back-owner',
  'owner-readback-mismatch',
])
const phases = existsSync(phasePath)
  ? readFileSync(phasePath, 'utf8')
      .split(/\r?\n/)
      .filter(value => phaseAllowlist.has(value))
  : []
const assertions = (report?.testResults ?? []).flatMap(suite =>
  (suite.assertionResults ?? []).map(assertion => ({
    name: String(assertion.fullName ?? assertion.title ?? ''),
    status: ['passed', 'failed', 'pending', 'skipped'].includes(assertion.status)
      ? assertion.status
      : 'unknown',
    message: [String(suite.message ?? ''), ...(assertion.failureMessages ?? [])].join('\n'),
  }))
)
const allowlistedTypes = [
  'AssertionError',
  'InvalidOperationException',
  'MethodInvocationException',
  'PrivilegeNotHeldException',
  'TimeoutError',
  'TypeError',
  'UnauthorizedAccessException',
  'Win32Exception',
]
const text = assertions.map(item => item.message).join('\n')
const type = allowlistedTypes.find(value => new RegExp(`\\b${value}\\b`).test(text)) ?? null
const fixturePhase = text.match(
  /"fixturePhase":"(read-existing-acl|set-owner|write-acl|read-back-owner|owner-readback-mismatch)"/
)?.[1]
const fixturePrivileges = text.match(
  /EVENFIRE_OWNER_FIXTURE_PRIVILEGES=restore:(enabled|disabled|not-listed);takeOwnership:(enabled|disabled|not-listed)/
)
const hresults = [...new Set(text.match(/0x[0-9A-F]{8}/gi) ?? [])].slice(0, 2)
const categories = [
  'authentication-state-mismatch',
  'assertion-mismatch',
  'filesystem-access-denied',
  'filesystem-sharing-conflict',
  'native-acl-fixture',
  'operation-timeout',
  'powerShell-method-invocation',
  'session-authority-acl-rejection',
  'unclassified',
]
const category =
  categories.find(value => text.toLowerCase().includes(value.toLowerCase())) ??
  (meta.watchdogExpired
    ? 'external-watchdog-expired'
    : /timed out in \d+ms/i.test(text)
      ? 'vitest-test-or-hook-timeout'
      : null)

const safe = {
  kind,
  sourceSha: process.env.PR977_SOURCE_SHA,
  harnessSha: process.env.GITHUB_SHA,
  testFiles: report?.numTotalTestSuites ?? 0,
  totalTests: report?.numTotalTests ?? 0,
  passed: report?.numPassedTests ?? 0,
  failed: report?.numFailedTests ?? 0,
  skipped: report?.numPendingTests ?? 0,
  exitCode: Number.isInteger(meta.exitCode) ? meta.exitCode : null,
  watchdogExpired: Boolean(meta.watchdogExpired),
  elapsedSeconds: Number.isFinite(meta.elapsedSeconds) ? meta.elapsedSeconds : null,
  phaseSequence: phases,
  lastPhase: phases.at(-1) ?? null,
  failureType: type,
  failureCategory: category,
  fixturePhase: kind === 'acl' ? (fixturePhase ?? null) : null,
  fixturePrivileges:
    kind === 'acl' && fixturePrivileges
      ? { restore: fixturePrivileges[1], takeOwnership: fixturePrivileges[2] }
      : null,
  hresults,
  selectedAssertions: assertions.map(({ name, status }) => ({
    name: name.slice(0, 180),
    status,
  })),
}
const outputPath = path.join(path.dirname(metaPath), `pr977-${kind}-root-cause.safe.json`)
writeFileSync(outputPath, `${JSON.stringify(safe, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`)
