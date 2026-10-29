import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) throw new Error('Expected input and output report paths')

const report = JSON.parse(readFileSync(inputPath, 'utf8'))
const summaryFields = [
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numPendingTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
]
if (
  !report ||
  typeof report !== 'object' ||
  !Array.isArray(report.testResults) ||
  typeof report.success !== 'boolean' ||
  summaryFields.some(key => !Number.isInteger(report[key]) || report[key] < 0)
) {
  throw new Error('Vitest report is incomplete or malformed')
}

const allowedSkips = new Set([
  'uses memory-only mode when Linux safeStorage selects the basic_text backend',
  'quarantines only a confirmed wrong-mode writer journal after its denial fence callback',
  'preserves confirmed invalid-file evidence when descriptor close also fails transiently',
  'rejects an actual nonregular FIFO without blocking',
  'discard refuses a real nonregular FIFO before decrypting bytes',
  'repair refuses a real nonregular FIFO before decrypting bytes',
])
const safeTitle = value =>
  String(value ?? 'unknown case')
    .replace(/[\r\n]/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{20,}\b/g, '<token>')
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, '<value>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s:]+/g, '<path>')
    .slice(0, 180)
const safeTestPath = value => {
  const normalized = String(value).replaceAll('\\', '/')
  const marker = '/desktop-app/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length)
  if (normalized.startsWith('desktop-app/')) return normalized.slice('desktop-app/'.length)
  if (/^(src|test|ui\/src)\//.test(normalized)) return normalized
  throw new Error('Vitest report contains a test path outside Desktop source')
}
const errorCodes = [
  'E2BIG',
  'EACCES',
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
const errorTypes = [
  'PrivilegeNotHeldException',
  'UnauthorizedAccessException',
  'PlatformNotSupportedException',
  'DirectoryNotFoundException',
  'FileNotFoundException',
  'Win32Exception',
  'AssertionError',
  'TimeoutError',
  'TypeError',
  'ReferenceError',
  'RangeError',
]
const classifyFailure = message => {
  const structured = extractStructuredDiagnostic(message)
  const errorType =
    errorTypes.find(type => new RegExp(`\\b${type}\\b`).test(message)) ?? 'unclassified'
  const code = errorCodes.find(value =>
    new RegExp(`(^|[^A-Za-z0-9_])${value}([^A-Za-z0-9_]|$)`).test(message)
  )
  const category =
    structured?.source === 'native-fixture'
      ? 'native-fixture'
      : structured?.source === 'verifier'
        ? 'native-verifier'
        : /expected \[Function\] to throw(?: an error)?/i.test(message)
          ? 'expected-rejection-not-observed'
          : /expected .*to throw/i.test(message)
            ? 'expected-rejection-mismatch'
            : errorType === 'PrivilegeNotHeldException'
              ? 'privilege-not-held'
              : errorType === 'PlatformNotSupportedException'
                ? 'platform-api-unavailable'
                : code === 'EACCES' ||
                    code === 'EPERM' ||
                    errorType === 'UnauthorizedAccessException'
                  ? 'access-denied'
                  : code === 'ETIMEDOUT' || errorType === 'TimeoutError'
                    ? 'timeout'
                    : errorType === 'AssertionError'
                      ? 'assertion'
                      : 'unclassified'
  const match = message.match(/([^\\/\s()]+\.test\.[cm]?[jt]sx?):(\d+):(\d+)/)
  return {
    category,
    errorType,
    ...(code ? { code } : {}),
    location: match ? `${match[1]}:${match[2]}` : 'unavailable',
    ...(structured ? { diagnostic: structured.fields } : {}),
  }
}

const safeErrorTypes = new Set([
  'ArgumentException',
  'DirectoryNotFoundException',
  'FileNotFoundException',
  'IOException',
  'InvalidCastException',
  'InvalidOperationException',
  'MethodInvocationException',
  'PlatformNotSupportedException',
  'PrivilegeNotHeldException',
  'UnauthorizedAccessException',
  'Win32Exception',
])
const safeFailureCategories = new Set([
  'privilege-not-held',
  'access-denied',
  'win32-api-failure',
  'argument-rejected',
  'platform-api-unavailable',
  'fixture-ace-readback-mismatch',
  'invalid-cast',
  'method-invocation-failed',
  'script-parse-failed',
  'overload-resolution-failed',
  'unclassified-powershell-failure',
])
const safeFixtureOperations = new Set([
  'add-everyone-modify',
  'add-trusted-installer-modify',
  'add-authenticated-users-create-directory',
  'add-current-user-inherit-only-ace',
  'create-authority-child-junction',
  'create-user-data-parent-junction',
  'remove-user-data-parent-junction',
  'set-allowed-child-owner',
])
const allowedDiagnosticEnums = {
  ownerClass: new Set([
    'current-user',
    'system',
    'administrators',
    'trusted-installer',
    'everyone',
    'authenticated-users',
    'builtin-users',
    'interactive',
    'creator-owner',
    'other',
  ]),
  aceClass: new Set([
    'current-user',
    'system',
    'administrators',
    'trusted-installer',
    'everyone',
    'authenticated-users',
    'builtin-users',
    'interactive',
    'creator-owner',
    'other',
  ]),
}

function sanitizeDiagnosticFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'operation' && typeof item === 'string' && safeFixtureOperations.has(item))
      fields[key] = item
    else if (
      key === 'powershellFailureCategory' &&
      typeof item === 'string' &&
      safeFailureCategories.has(item)
    )
      fields[key] = item
    else if (
      ['errorType', 'innerErrorType', 'verifierErrorType', 'verifierInnerErrorType'].includes(
        key
      ) &&
      typeof item === 'string' &&
      safeErrorTypes.has(item)
    )
      fields[key] = item
    else if (
      ['ownerClass', 'aceClass', 'verifierOwnerClass', 'verifierAceClass'].includes(key) &&
      typeof item === 'string' &&
      allowedDiagnosticEnums[
        key.replace(/^verifier/, '').replace(/^./, char => char.toLowerCase())
      ]?.has(item)
    )
      fields[key] = item
    else if (
      [
        'phase',
        'verifierExecutionPhase',
        'verifierPhase',
        'innerNativeOperation',
        'verifierInnerNativeOperation',
      ].includes(key) &&
      typeof item === 'string' &&
      /^[A-Za-z0-9-]{1,80}$/.test(item)
    )
      fields[key] = item
    else if (
      ['detail', 'verifierDetail'].includes(key) &&
      typeof item === 'string' &&
      /^[A-Za-z0-9-]{1,80}$/.test(item)
    )
      fields[key] = item
    else if (
      ['hresult', 'innerHresult', 'verifierHresult', 'verifierInnerHresult'].includes(key) &&
      typeof item === 'string' &&
      /^0x[0-9A-F]{8}$/i.test(item)
    )
      fields[key] = item
    else if (
      ['processErrorCode', 'verifierProcessErrorCode'].includes(key) &&
      typeof item === 'string' &&
      errorCodes.includes(item)
    )
      fields[key] = item
    else if (key === 'signal' && typeof item === 'string' && ['SIGTERM', 'SIGKILL'].includes(item))
      fields[key] = item
    else if (
      [
        'processStarted',
        'processSignaled',
        'stdoutPresent',
        'stderrPresent',
        'verifierAceWriteContent',
        'verifierAceDeleteChild',
        'verifierAceDelete',
        'verifierAceWriteDacl',
        'verifierAceTakeOwnership',
        'verifierAceWriteMetadata',
        'verifierAceInherited',
      ].includes(key) &&
      typeof item === 'boolean'
    )
      fields[key] = item
    else if (
      ['exitStatus', 'innerNativeErrorCode', 'verifierInnerNativeErrorCode'].includes(key) &&
      Number.isSafeInteger(item) &&
      (key === 'exitStatus' || (item >= 0 && item <= 0xffff))
    )
      fields[key] = item
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

function extractStructuredDiagnostic(message) {
  const markers = [
    { text: 'Native Windows ACL fixture failed:', source: 'native-fixture' },
    { text: 'Windows session authority ACL verification failed', source: 'verifier' },
    {
      text: 'Windows session authority ACL verification returned invalid evidence',
      source: 'verifier',
    },
    {
      text: 'Windows session authority ACL verification returned incomplete evidence',
      source: 'verifier',
    },
  ]
  for (const marker of markers) {
    const markerIndex = message.indexOf(marker.text)
    if (markerIndex < 0) continue
    const jsonStart = message.indexOf('{', markerIndex + marker.text.length)
    if (jsonStart < 0) continue
    let value
    try {
      value = JSON.parse(message.slice(jsonStart, message.indexOf('}', jsonStart) + 1))
    } catch {
      continue
    }
    const fields = sanitizeDiagnosticFields(value)
    if (fields) return { source: marker.source, fields }
  }
  return undefined
}

const testResults = report.testResults.map(suite => {
  if (!suite || typeof suite.name !== 'string' || !Array.isArray(suite.assertionResults)) {
    throw new Error('Vitest report contains an invalid suite entry')
  }
  const assertionResults = suite.assertionResults.map((assertion, index) => {
    if (
      !assertion ||
      !['passed', 'failed', 'pending', 'skipped', 'todo'].includes(assertion.status)
    ) {
      throw new Error('Vitest report contains an invalid assertion entry')
    }
    const safeAssertion = {
      status: assertion.status,
      title:
        ['skipped', 'pending', 'todo'].includes(assertion.status) &&
        allowedSkips.has(String(assertion.title ?? ''))
          ? String(assertion.title)
          : safeTitle(assertion.title ?? `case-${index + 1}`),
    }
    if (assertion.status === 'failed') {
      safeAssertion.failure = classifyFailure((assertion.failureMessages ?? []).join('\n'))
    }
    return safeAssertion
  })
  if (!['passed', 'failed', 'pending', 'skipped'].includes(suite.status)) {
    throw new Error('Vitest report contains an invalid suite status')
  }
  const suiteFailure =
    typeof suite.message === 'string' && suite.message.length > 0
      ? classifyFailure(suite.message)
      : undefined
  return {
    name: safeTestPath(suite.name),
    status: suite.status,
    assertionResults,
    ...(suiteFailure ? { failure: suiteFailure } : {}),
  }
})

const suiteCounts = testResults.reduce(
  (counts, suite) => {
    counts.total += 1
    if (suite.status === 'passed') counts.passed += 1
    else if (suite.status === 'failed') counts.failed += 1
    else counts.pending += 1
    return counts
  },
  { total: 0, passed: 0, failed: 0, pending: 0 }
)
const assertionCounts = testResults.reduce(
  (counts, suite) => {
    for (const assertion of suite.assertionResults) {
      counts.total += 1
      if (assertion.status === 'passed') counts.passed += 1
      else if (assertion.status === 'failed') counts.failed += 1
      else if (assertion.status === 'pending' || assertion.status === 'skipped') counts.pending += 1
      else counts.todo += 1
    }
    return counts
  },
  { total: 0, passed: 0, failed: 0, pending: 0, todo: 0 }
)
const derivedSummary = {
  numTotalTestSuites: suiteCounts.total,
  numPassedTestSuites: suiteCounts.passed,
  numFailedTestSuites: suiteCounts.failed,
  numPendingTestSuites: suiteCounts.pending,
  numTotalTests: assertionCounts.total,
  numPassedTests: assertionCounts.passed,
  numFailedTests: assertionCounts.failed,
  numPendingTests: assertionCounts.pending,
  numTodoTests: assertionCounts.todo,
}
const counterDiscrepancies = summaryFields.flatMap(field =>
  report[field] === derivedSummary[field]
    ? []
    : [{ field, reported: report[field], derived: derivedSummary[field] }]
)
const countersConsistent = counterDiscrepancies.length === 0
const hasFailures = suiteCounts.failed > 0 || assertionCounts.failed > 0

const safeReport = {
  success: report.success && countersConsistent && !hasFailures,
  ...Object.fromEntries(summaryFields.map(key => [key, report[key]])),
  counterConsistency: { valid: countersConsistent, discrepancies: counterDiscrepancies },
  testResults,
}
writeFileSync(outputPath, `${JSON.stringify(safeReport)}\n`)
process.stdout.write(
  `Sanitized Windows report: files=${safeReport.numTotalTestSuites} ` +
    `tests=${safeReport.numTotalTests} passed=${safeReport.numPassedTests} ` +
    `failed=${safeReport.numFailedTests} skipped=${safeReport.numPendingTests}\n`
)
if (!countersConsistent) {
  process.stdout.write(
    `Counter mismatch: ${counterDiscrepancies.map(({ field }) => field).join(', ')}\n`
  )
}
for (const suite of testResults) {
  if (suite.failure) {
    process.stdout.write(
      `Failed suite: file=${path.basename(suite.name)} type=${suite.failure.errorType} ` +
        `category=${suite.failure.category}${suite.failure.code ? ` code=${suite.failure.code}` : ''} ` +
        `at=${suite.failure.location}\n`
    )
  }
  for (const [index, assertion] of suite.assertionResults.entries()) {
    if (assertion.status !== 'failed' || !assertion.failure) continue
    process.stdout.write(
      `Failed test: file=${path.basename(suite.name)} case=${index + 1} title=${assertion.title} ` +
        `type=${assertion.failure.errorType} category=${assertion.failure.category}` +
        `${assertion.failure.code ? ` code=${assertion.failure.code}` : ''} ` +
        `at=${assertion.failure.location}\n`
    )
  }
}
if (!countersConsistent) process.exitCode = 1
