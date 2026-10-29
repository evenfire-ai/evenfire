import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [reportPath, summaryPath] = process.argv.slice(2)
if (!reportPath || !summaryPath) throw new Error('Expected report and summary paths')

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const allowedTypes = [
  'AssertionError',
  'DirectoryNotFoundException',
  'FileNotFoundException',
  'InvalidOperationException',
  'MethodInvocationException',
  'NotAuthenticatedError',
  'NotFoundError',
  'PrivilegeNotHeldException',
  'TimeoutError',
  'TypeError',
  'UnauthorizedAccessException',
  'Win32Exception',
]
const allowedCodes = [
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EIO',
  'EINVAL',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTEMPTY',
  'EPERM',
  'ETIMEDOUT',
]

function sanitizeExcerpt(messages) {
  const firstLine = String(messages?.[0] ?? 'No failure message was recorded')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)[0]
  return firstLine
    .replace(/EVENFIRE_[A-Z0-9_]+=\{[^}]*\}/g, '<structured-diagnostic>')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\b(token|password|credential|secret)\s*[:=]?\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-token>')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<redacted-email>')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '<redacted-value>')
    .replace(/(?:[A-Z]:\\|\\\\)[^\s,;)}]+/gi, '<redacted-path>')
    .replace(/\/(?:Users|home|private|tmp)\/[^\s,;)}]+/g, '<redacted-path>')
    .slice(0, 240)
}

function categoryFor(messages, code, type) {
  const joined = messages.join('\n')
  if (joined.includes('Native Windows ACL fixture failed:')) return 'native-acl-fixture'
  if (
    code === 'ENOENT' ||
    type === 'FileNotFoundException' ||
    type === 'DirectoryNotFoundException'
  ) {
    return 'missing-filesystem-entry'
  }
  if (code === 'EACCES' || code === 'EPERM' || type === 'UnauthorizedAccessException') {
    return 'filesystem-access-denied'
  }
  if (code === 'EBUSY') return 'filesystem-sharing-conflict'
  if (code === 'ETIMEDOUT' || type === 'TimeoutError') return 'operation-timeout'
  if (/not authenticated|authentication was not established/i.test(joined)) {
    return 'authentication-state-mismatch'
  }
  if (/Windows session authority ACL verification failed/i.test(joined)) {
    return 'session-authority-acl-rejection'
  }
  if (/expected .* (?:to be|to equal|to match)/i.test(joined)) return 'assertion-mismatch'
  if (type === 'MethodInvocationException') return 'powerShell-method-invocation'
  if (type === 'InvalidOperationException') return 'invalid-operation'
  return 'unclassified'
}

const failed = []
for (const suite of report.testResults ?? []) {
  for (const assertion of suite.assertionResults ?? []) {
    if (assertion.status !== 'failed') continue
    const messages = assertion.failureMessages ?? []
    const joined = messages.join('\n')
    const type = allowedTypes.find(value => new RegExp(`\\b${value}\\b`).test(joined)) ?? 'Error'
    const code = allowedCodes.find(value =>
      new RegExp(`(^|[^A-Za-z0-9_])${value}([^A-Za-z0-9_]|$)`).test(joined)
    )
    const location = joined.match(/([^\\/\s()]+\.test\.[cm]?[jt]sx?):(\d+):(\d+)/)
    failed.push({
      file: path.basename(String(suite.name).replaceAll('\\', '/')),
      location: location ? `${location[1]}:${location[2]}` : 'unavailable',
      errorType: type,
      ...(code ? { code } : {}),
      category: categoryFor(messages, code, type),
      safeExcerpt: sanitizeExcerpt(messages),
    })
  }
}

const safe = {
  sourceSha: process.env.PR977_SOURCE_SHA ?? '075794e5606a65c30f4626a15f17718447393ec5',
  testFile: 'appService.passwordLoginRollback.regression.test.ts',
  totalFiles: report.numTotalTestSuites,
  totalTests: report.numTotalTests,
  passed: report.numPassedTests,
  failed: report.numFailedTests,
  skipped: report.numPendingTests,
  success: Boolean(report.success),
  failures: failed,
}

const safePath = path.join(path.dirname(reportPath), 'pr977-password-rollback-windows.safe.json')
writeFileSync(safePath, `${JSON.stringify(safe, null, 2)}\n`)
const lines = [
  '# PR 977 focused Windows authentication diagnostic',
  `Application source SHA: ${safe.sourceSha}`,
  `Focused file: ${safe.testFile}`,
  `Tests: total=${safe.totalTests} passed=${safe.passed} failed=${safe.failed} skipped=${safe.skipped}`,
]
for (const item of failed) {
  lines.push(
    `Failure: file=${item.file} at=${item.location} type=${item.errorType} ` +
      `category=${item.category}${item.code ? ` code=${item.code}` : ''}`
  )
  lines.push(`Safe excerpt: ${item.safeExcerpt}`)
}
writeFileSync(summaryPath, `${lines.join('\n')}\n`, { flag: 'a' })
process.stdout.write(`${lines.join('\n')}\n`)
