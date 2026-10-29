import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [kind, reportPath, phasePath, metaPath, timingPath] = process.argv.slice(2)
if (!['auth', 'acl'].includes(kind) || !reportPath || !phasePath || !metaPath || !timingPath) {
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
  'http-password-end',
  'complete-password-start',
  'complete-password-end',
  'credential-producer-start',
  'credential-producer-end',
  'credential-producer-error',
  'session-persistence-start',
  'session-persistence-end',
  'session-persistence-error',
  'login-install-start',
  'login-install-end',
  'login-install-error',
  'login-install-once-start',
  'login-install-once-end',
  'login-install-once-error',
  'acceptance-install-start',
  'acceptance-install-end',
  'acceptance-install-error',
  'within-persistence-start',
  'within-persistence-end',
  'within-persistence-error',
  'legacy-recovery-start',
  'legacy-recovery-end',
  'legacy-recovery-error',
  'legacy-scope-start',
  'legacy-scope-end',
  'legacy-observe-first-start',
  'legacy-observe-first-end',
  'legacy-resume-start',
  'legacy-resume-end',
  'legacy-observe-resume-start',
  'legacy-observe-resume-end',
  'legacy-initialize-start',
  'legacy-initialize-end',
  'legacy-observe-initialized-start',
  'legacy-observe-initialized-end',
  'legacy-observation-accepted',
  'legacy-path-resolve-start',
  'legacy-path-resolve-end',
  'legacy-capture-start-source',
  'legacy-capture-end-source',
  'journal-capture-start',
  'journal-capture-end',
  'journal-capture-error',
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
  'load-native-helper',
  'validate-request',
  'inspect-native-object',
  'validate-effective-access',
  'validate-user-data-ancestry',
  'validate-authority-tree',
  'validate-user-data-root',
  'provision-authority-directory',
  'validate-staged-authority',
  'publish-authority-directory-write-through',
  'validate-authority-directory',
  'validate-published-authority-identity',
  'revalidate-user-data-root',
  'transaction-begin-start',
  'transaction-begin-end',
  'transaction-begin-error',
  'transaction-publish-start',
  'transaction-publish-end',
  'transaction-publish-error',
  'read-existing-acl',
  'set-owner',
  'enable-restore-privilege',
  'write-acl',
  'read-back-owner',
  'owner-readback-mismatch',
  'fixture-owner-readback-verified',
  'owner-test-start',
  'owner-provision-start',
  'owner-provision-complete',
  'owner-child-created',
  'owner-fixture-start',
  'owner-fixture-complete',
  'production-verifier-start',
  'production-verifier-accepted',
  'production-verifier-rejected',
  'owner-assertion-complete',
  'owner-teardown-start',
  'owner-teardown-remove-start',
  'owner-teardown-remove-complete',
  'owner-teardown-remove-failed',
  'owner-teardown-complete',
])
const rawPhases = existsSync(phasePath) ? readFileSync(phasePath, 'utf8').split(/\r?\n/) : []
const objectCountMatch = rawPhases.find(value =>
  /^production-verifier-object-count=\d{1,3}$/.test(value)
)
const productionVerifierObjectCount = objectCountMatch
  ? Number(objectCountMatch.slice('production-verifier-object-count='.length))
  : null
const phases = rawPhases.filter(value => phaseAllowlist.has(value))
const timingLines = existsSync(timingPath)
  ? readFileSync(timingPath, 'utf8').split(/\r?\n/).filter(Boolean)
  : []
const aclOperationDurationsMs = []
let unfinishedAclOperationCount = 0
for (const line of timingLines) {
  if (line === 'acl-operation-start') {
    unfinishedAclOperationCount += 1
    continue
  }
  const match = /^acl-operation-ms=(\d{1,6})$/.exec(line)
  if (!match) continue
  const duration = Number(match[1])
  if (!Number.isSafeInteger(duration) || duration > 120000) continue
  aclOperationDurationsMs.push(duration)
  unfinishedAclOperationCount = Math.max(0, unfinishedAclOperationCount - 1)
}
const aclPhaseDurationsMs = timingLines.flatMap(line => {
  const match = /^acl-phase=([A-Za-z0-9-]{1,80});elapsed-ms=(\d{1,6})$/.exec(line)
  if (!match || !phaseAllowlist.has(match[1])) return []
  const elapsedMs = Number(match[2])
  return Number.isSafeInteger(elapsedMs) && elapsedMs <= 120000
    ? [{ phase: match[1], elapsedMs }]
    : []
})
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
const selectedName =
  kind === 'auth'
    ? 'restores the accepted prior source when candidate preparation fails after publication'
    : "accepts a child owned by the allowlisted 'SYSTEM' principal with current-user access intact"
const selectedAssertions = assertions.filter(item => item.name.includes(selectedName))
if (
  !meta.watchdogExpired &&
  (selectedAssertions.length !== 1 || selectedAssertions[0]?.status === 'skipped')
) {
  throw new Error('The required selected diagnostic assertion did not execute exactly once')
}
const type = allowlistedTypes.find(value => new RegExp(`\\b${value}\\b`).test(text)) ?? null
const fixturePhase = text.match(
  /"fixturePhase":"(read-existing-acl|set-owner|enable-restore-privilege|write-acl|read-back-owner|owner-readback-mismatch)"/
)?.[1]
const fixturePrivilegesMatch = text.match(
  /"fixturePrivileges":\{"restore":"(enabled|disabled|not-listed)","takeOwnership":"(enabled|disabled|not-listed)"\}/
)
const fixturePrivileges = fixturePrivilegesMatch
  ? { restore: fixturePrivilegesMatch[1], takeOwnership: fixturePrivilegesMatch[2] }
  : null
const hresults = [...new Set(text.match(/0x[0-9A-F]{8}/gi) ?? [])].slice(0, 2)
const categories = [
  'acl-verifier-unavailable',
  'powerShell-process-timeout',
  'powershell-exit-without-rejection-evidence',
  'authentication-state-mismatch',
  'assertion-mismatch',
  'filesystem-access-denied',
  'filesystem-sharing-conflict',
  'native-acl-fixture',
  'operation-timeout',
  'powerShell-method-invocation',
  'session-authority-acl-rejection',
  'unclassified-powershell-failure',
  'access-denied',
  'argument-rejected',
  'win32-api-failure',
  'platform-api-unavailable',
  'method-invocation-failed',
  'overload-resolution-failed',
  'script-parse-failed',
  'fixture-ace-readback-mismatch',
  'privilege-not-held',
  'unclassified',
]
const category =
  categories.find(value => text.toLowerCase().includes(value.toLowerCase())) ??
  (text.includes('ETIMEDOUT')
    ? 'powerShell-process-timeout'
    : meta.watchdogExpired
      ? 'external-watchdog-expired'
      : /timed out in \d+ms/i.test(text)
        ? 'vitest-test-or-hook-timeout'
        : null)

let aclVerifierDiagnostic = null
const aclDiagnosticCandidates = [...text.matchAll(/\{[^{}]{1,2500}\}/g)]
for (const aclDiagnosticMatch of aclDiagnosticCandidates) {
  try {
    const candidate = JSON.parse(aclDiagnosticMatch[0])
    if (
      !(
        'processStarted' in candidate ||
        'verifierExecutionPhase' in candidate ||
        'processErrorCode' in candidate
      )
    )
      continue
    const safe = {}
    for (const field of [
      'phase',
      'verifierExecutionPhase',
      'verifierErrorType',
      'verifierHresult',
      'verifierInnerErrorType',
      'verifierInnerHresult',
      'verifierDetail',
      'verifierOwnerClass',
      'verifierAceClass',
      'verifierInnerNativeOperation',
      'verifierInnerNativeErrorCode',
      'processErrorCode',
      'exitStatus',
      'processStarted',
      'stdoutPresent',
      'stderrPresent',
    ]) {
      const value = candidate?.[field]
      if (field.toLowerCase().endsWith('hresult')) {
        if (typeof value === 'string' && /^0x[0-9A-F]{8}$/i.test(value)) safe[field] = value
      } else if (field === 'exitStatus' || field === 'verifierInnerNativeErrorCode') {
        if (Number.isInteger(value) && value >= 0 && value <= 65535) safe[field] = value
      } else if (['processStarted', 'stdoutPresent', 'stderrPresent'].includes(field)) {
        if (typeof value === 'boolean') safe[field] = value
      } else if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)) {
        safe[field] = value
      }
    }
    if (Object.keys(safe).length) {
      aclVerifierDiagnostic = safe
      break
    }
  } catch {
    continue
  }
}

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
  aclOperationDurationsMs,
  aclPhaseDurationsMs,
  unfinishedAclOperationCount,
  phaseSequence: phases,
  lastPhase: phases.at(-1) ?? null,
  failureType: type,
  failureCategory: category,
  fixturePhase: kind === 'acl' ? fixturePhase : null,
  productionVerifierObjectCount: kind === 'acl' ? productionVerifierObjectCount : null,
  fixturePrivileges: kind === 'acl' ? fixturePrivileges : null,
  aclVerifierDiagnostic,
  hresults,
  selectedAssertions: selectedAssertions.map(({ name, status }) => ({
    name: name.slice(0, 180),
    status,
  })),
}
const outputPath = path.join(path.dirname(metaPath), `pr977-${kind}-root-cause.safe.json`)
writeFileSync(outputPath, `${JSON.stringify(safe, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`)
