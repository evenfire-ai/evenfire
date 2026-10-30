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
  'requires a durable directory sync on retry after a prior unlink succeeded',
  'writes the file with POSIX mode 0600',
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
  'ENOBUFS',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_REQUIRE_ESM',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_INVALID_MODULE_SPECIFIER',
  'ERR_UNSUPPORTED_DIR_IMPORT',
]
const errorTypes = [
  'PrivilegeNotHeldException',
  'UnauthorizedAccessException',
  'PlatformNotSupportedException',
  'DirectoryNotFoundException',
  'FileNotFoundException',
  'Win32Exception',
  'AssertionError',
  'Error',
  'SyntaxError',
  'ModuleNotFoundError',
  'TimeoutError',
  'TypeError',
  'ReferenceError',
  'RangeError',
]
const pluginStorageReasons = new Set([
  'native-inspection-helper-load-failed',
  'native-inspection-response-rejected',
  'native-inspection-process-timeout',
  'native-inspection-process-start-failed',
  'native-inspection-process-error',
  'native-inspection-process-terminated',
  'native-inspection-response-missing',
  'native-inspection-response-malformed',
  'native-verifier-rejected',
  'native-inspection-process-exit-failed',
  'native-inspection-evidence-invalid',
])
const pluginStorageFailureCategories = {
  'native-inspection-helper-load-failed': 'native-helper-load-failed',
  'native-inspection-response-rejected': 'native-response-rejected',
  'native-inspection-process-timeout': 'native-process-timeout',
  'native-inspection-process-start-failed': 'native-process-start-failed',
  'native-inspection-process-error': 'native-process-error',
  'native-inspection-process-terminated': 'native-process-terminated',
  'native-inspection-response-missing': 'native-response-missing',
  'native-inspection-response-malformed': 'native-response-malformed',
  'native-verifier-rejected': 'native-verifier-rejection',
  'native-inspection-process-exit-failed': 'native-process-exit-failed',
  'native-inspection-evidence-invalid': 'native-evidence-invalid',
}
const pluginStorageFailures = new Set([
  'helper-load-failed',
  'response-rejected',
  'process-timeout',
  'process-start-failed',
  'process-error',
  'process-terminated',
  'process-exit-failed',
  'response-missing',
  'response-malformed',
  'verifier-rejected',
  'evidence-invalid',
])
const pluginStoragePhases = new Set(['inspect-object', 'load-native-helper', 'verification'])
const pluginStorageNativeErrors = new Set([
  'ArgumentException',
  'FileNotFoundException',
  'FormatException',
  'IOException',
  'InvalidDataException',
  'InvalidOperationException',
  'PlatformNotSupportedException',
  'ReflectionTypeLoadException',
  'RuntimeException',
  'SecurityException',
  'TypeLoadException',
  'TypeInitializationException',
  'UnauthorizedAccessException',
  'Win32Exception',
])
const pluginStorageOperations = new Set([
  'access-check',
  'duplicate-token',
  'entry-exists',
  'file-information',
  'final-path',
  'get-security-info',
  'open-object',
  'open-object-for-owner',
  'open-process-token',
  'security-descriptor-control',
  'set-owner',
])

function sanitizePluginStorageError(error) {
  const value = error?.diagnostic
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const safe = {}
  if (pluginStorageFailures.has(value.failure)) safe.failure = value.failure
  if (Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 60_000)
    safe.elapsedMs = value.elapsedMs
  if (typeof value.processErrorCode === 'string' && errorCodes.includes(value.processErrorCode))
    safe.processErrorCode = value.processErrorCode
  if (
    value.exitStatus === null ||
    (Number.isSafeInteger(value.exitStatus) && value.exitStatus >= -1 && value.exitStatus <= 255)
  )
    safe.exitStatus = value.exitStatus
  if (
    typeof value.signal === 'string' &&
    ['SIGABRT', 'SIGBREAK', 'SIGINT', 'SIGKILL', 'SIGTERM'].includes(value.signal)
  )
    safe.signal = value.signal
  if (pluginStoragePhases.has(value.nativePhase)) safe.nativePhase = value.nativePhase
  if (pluginStorageNativeErrors.has(value.nativeErrorType))
    safe.nativeErrorType = value.nativeErrorType
  if (typeof value.hresult === 'string' && /^0x[0-9A-F]{8}$/i.test(value.hresult))
    safe.hresult = `0x${value.hresult.slice(2).toUpperCase()}`
  if (pluginStorageOperations.has(value.nativeOperation))
    safe.nativeOperation = value.nativeOperation
  if (Number.isSafeInteger(value.win32Error) && value.win32Error >= 0 && value.win32Error <= 0xffff)
    safe.win32Error = value.win32Error
  if (typeof value.nativeReason === 'string' && /^[a-z-]{1,60}$/.test(value.nativeReason))
    safe.nativeReason = value.nativeReason
  return Object.keys(safe).length ? safe : undefined
}

const classifyFailure = (message, reportedPhase) => {
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
        : [
              'ERR_MODULE_NOT_FOUND',
              'ERR_UNKNOWN_FILE_EXTENSION',
              'ERR_REQUIRE_ESM',
              'ERR_PACKAGE_PATH_NOT_EXPORTED',
              'ERR_INVALID_MODULE_SPECIFIER',
              'ERR_UNSUPPORTED_DIR_IMPORT',
            ].some(value => message.includes(value))
          ? 'module-resolution'
          : /(?:test|hook) timed out|timeout of .* exceeded|ETIMEDOUT/i.test(message)
            ? 'timeout'
            : /STACK_TRACE_ERROR/.test(message) && !/timed out/i.test(message)
              ? 'reporter-message-unavailable'
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
    phase: [
      'setup',
      'teardown',
      'setup-or-teardown',
      'test-or-teardown',
      'collection',
      'test',
    ].includes(reportedPhase)
      ? reportedPhase
      : structured?.source === 'native-fixture'
        ? 'fixture'
        : structured?.source === 'verifier'
          ? 'verifier'
          : 'unknown',
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
    let depth = 0
    let quoted = false
    let escaped = false
    for (let end = jsonStart; end < Math.min(message.length, jsonStart + 16384); end++) {
      const char = message[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try {
          value = JSON.parse(message.slice(jsonStart, end + 1))
        } catch {
          /* fail closed */
        }
        break
      }
    }
    if (!value) continue
    const fields = sanitizeDiagnosticFields(value)
    if (fields) return { source: marker.source, fields }
  }
  return undefined
}

function failuresFor(entry) {
  if (entry.diagnosticErrors !== undefined) {
    if (
      !Array.isArray(entry.diagnosticErrors) ||
      entry.diagnosticErrors.some(
        error =>
          !error ||
          typeof error.message !== 'string' ||
          (error.stack !== undefined && typeof error.stack !== 'string') ||
          ![
            'setup',
            'teardown',
            'setup-or-teardown',
            'test-or-teardown',
            'collection',
            'test',
          ].includes(error.phase)
      )
    )
      throw new Error('Malformed diagnostic errors')
    if (entry.diagnosticErrors.length > 0)
      return entry.diagnosticErrors.map(error => {
        const failure = classifyFailure(
          `${error.name ?? ''} ${error.code ?? ''} ${error.message}\n${error.stack ?? ''}`,
          error.phase
        )
        const safeCode = typeof error.code === 'string' && errorCodes.includes(error.code)
        const safeName = errorTypes.includes(String(error.name))
        const safeReason = pluginStorageReasons.has(error.reason) ? error.reason : undefined
        const pluginDiagnostic = sanitizePluginStorageError(error)
        return {
          ...failure,
          ...(safeReason ? { category: pluginStorageFailureCategories[safeReason] } : {}),
          ...(safeCode ? { code: error.code } : {}),
          ...(safeName ? { errorType: error.name } : {}),
          ...(pluginDiagnostic ? { pluginStorageDiagnostic: pluginDiagnostic } : {}),
          failedHooks: Array.isArray(error.failedHooks)
            ? error.failedHooks.filter(name =>
                ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'].includes(name)
              )
            : [],
        }
      })
  }
  if (
    entry.failureMessages !== undefined &&
    (!Array.isArray(entry.failureMessages) ||
      entry.failureMessages.some(message => typeof message !== 'string'))
  ) {
    throw new Error('Malformed failure messages')
  }
  return (entry.failureMessages ?? []).map(message => classifyFailure(message))
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
      const failures = failuresFor(assertion)
      safeAssertion.failures = failures
      safeAssertion.failure = failures[0] ?? classifyFailure('')
    }
    return safeAssertion
  })
  if (!['passed', 'failed', 'pending', 'skipped'].includes(suite.status)) {
    throw new Error('Vitest report contains an invalid suite status')
  }
  const suiteFailures = failuresFor(suite)
  const suiteFailure =
    suiteFailures[0] ??
    (typeof suite.message === 'string' && suite.message.length > 0
      ? classifyFailure(suite.message)
      : undefined)
  return {
    name: safeTestPath(suite.name),
    status: suite.status,
    assertionResults,
    ...(suiteFailure ? { failure: suiteFailure, failures: suiteFailures } : {}),
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
  numTotalTests: assertionCounts.total,
  numPassedTests: assertionCounts.passed,
  numFailedTests: assertionCounts.failed,
  numPendingTests: assertionCounts.pending,
  numTodoTests: assertionCounts.todo,
}
const counterDiscrepancies = Object.keys(derivedSummary).flatMap(field =>
  report[field] === derivedSummary[field]
    ? []
    : [{ field, reported: report[field], derived: derivedSummary[field] }]
)
// Vitest getSuites includes file + nested describe tasks; JSON exposes only file results.
// Empty/nested describe tasks cannot be reconstructed from assertion ancestorTitles.
if (
  report.numTotalTestSuites !==
  report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites
) {
  counterDiscrepancies.push({
    field: 'suiteCounterSum',
    reported: report.numTotalTestSuites,
    derived: report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites,
  })
}
if (report.numTotalTestSuites < suiteCounts.total) {
  counterDiscrepancies.push({
    field: 'suiteCounterMinimum',
    reported: report.numTotalTestSuites,
    derived: suiteCounts.total,
  })
}
const countersConsistent = counterDiscrepancies.length === 0
const hasFailures = suiteCounts.failed > 0 || assertionCounts.failed > 0

const safeReport = {
  success: report.success && countersConsistent && !hasFailures && report.numFailedTestSuites === 0,
  numTestFiles: testResults.length,
  ...Object.fromEntries(summaryFields.map(key => [key, report[key]])),
  counterConsistency: { valid: countersConsistent, discrepancies: counterDiscrepancies },
  testResults,
}
writeFileSync(outputPath, `${JSON.stringify(safeReport)}\n`)
process.stdout.write(
  `Sanitized Windows report: files=${safeReport.numTestFiles} ` +
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
