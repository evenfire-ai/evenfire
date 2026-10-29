import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [reportDirectory, sourceDesktopRoot, sourceSha, harnessSha] = process.argv.slice(2)
const expectedShardCount = 8
if (!reportDirectory || !sourceDesktopRoot || !sourceSha || !harnessSha) {
  throw new Error('Expected report directory, source root, source SHA and harness SHA')
}

const sourceHead = execFileSync(
  'git',
  ['-C', path.dirname(sourceDesktopRoot), 'rev-parse', 'HEAD'],
  {
    encoding: 'utf8',
  }
).trim()
if (sourceHead !== sourceSha)
  throw new Error('Aggregate checkout does not match the tested source SHA')

const includePatterns = [
  /^src\/(?:.*\/)?[^/]+\.test\.ts$/,
  /^src\/(?:.*\/)?__tests__\/(?:.*\/)?[^/]+\.ts$/,
  /^test\/(?:.*\/)?[^/]+\.test\.ts$/,
  /^ui\/src\/(?:.*\/)?[^/]+\.test\.ts$/,
  /^ui\/src\/(?:.*\/)?[^/]+\.test\.tsx$/,
  /^ui\/src\/(?:.*\/)?__tests__\/(?:.*\/)?[^/]+\.ts$/,
  /^ui\/src\/(?:.*\/)?__tests__\/(?:.*\/)?[^/]+\.tsx$/,
]

const trackedFiles = execFileSync(
  'git',
  ['-C', path.dirname(sourceDesktopRoot), 'ls-files', '-z', '--', 'desktop-app'],
  { encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean)
  .map(file => file.replaceAll('\\', '/').replace(/^desktop-app\//, ''))

const isExcluded = file =>
  file.startsWith('dist/') ||
  file.startsWith('node_modules/') ||
  file.startsWith('test/e2e/') ||
  file.startsWith('test/e2e-playwright/') ||
  file.split('/').includes('__fixtures__')

const expectedFiles = new Set(
  trackedFiles.filter(
    file => !isExcluded(file) && includePatterns.some(pattern => pattern.test(file))
  )
)
const overlayFile = 'src/__tests__/windowsSessionAuthorityDurableFileOps.native.test.ts'
expectedFiles.add(overlayFile)

const reports = readdirSync(reportDirectory)
  .filter(file => /^shard-[1-8]\.json$/.test(file))
  .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]))
if (reports.length !== expectedShardCount) {
  throw new Error(`Expected ${expectedShardCount} shard reports; found ${reports.length}`)
}

const seenFiles = new Set()
const allResults = []
let totalSuites = 0
let totalTests = 0
let totalPassed = 0
let totalFailed = 0
let totalSkipped = 0

for (const reportFile of reports) {
  const shardIndex = Number(reportFile.match(/\d+/)[0])
  const report = JSON.parse(readFileSync(path.join(reportDirectory, reportFile), 'utf8'))
  if (report.numTotalTestSuites <= 0 || report.numTotalTests <= 0) {
    throw new Error(`${reportFile} executed no test suites or cases`)
  }
  if (!Array.isArray(report.testResults)) throw new Error(`${reportFile} has no test result list`)
  totalSuites += report.numTotalTestSuites
  totalTests += report.numTotalTests
  totalPassed += report.numPassedTests
  totalFailed += report.numFailedTests
  totalSkipped += report.numPendingTests

  for (const result of report.testResults) {
    let normalizedName = String(result.name).replaceAll('\\', '/')
    const desktopRootMarker = '/desktop-app/'
    const markerIndex = normalizedName.lastIndexOf(desktopRootMarker)
    if (markerIndex >= 0)
      normalizedName = normalizedName.slice(markerIndex + desktopRootMarker.length)
    else normalizedName = normalizedName.replace(/^\.\//, '').replace(/^desktop-app\//, '')
    if (!expectedFiles.has(normalizedName)) {
      throw new Error(`${reportFile} reported a file outside the expected Desktop suite`)
    }
    if (seenFiles.has(normalizedName))
      throw new Error(`A test file ran in more than one shard: ${normalizedName}`)
    seenFiles.add(normalizedName)
    allResults.push(result)
    for (const assertion of result.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue
      const file = path.basename(normalizedName)
      const title = String(assertion.fullName ?? 'unknown test')
        .replace(/[\r\n]/g, ' ')
        .slice(0, 240)
      const message = (assertion.failureMessages ?? []).join('\n')
      const errorType =
        message.match(
          /\b(PrivilegeNotHeldException|UnauthorizedAccessException|PlatformNotSupportedException|DirectoryNotFoundException|FileNotFoundException|Win32Exception|AssertionError|TimeoutError|TypeError|ReferenceError|RangeError)\b/
        )?.[1] ?? 'unclassified'
      const codes = [
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
      const code = codes.find(value =>
        new RegExp(`(^|[^A-Za-z0-9_])${value}([^A-Za-z0-9_]|$)`).test(message)
      )
      const category = message.includes('Native Windows ACL fixture failed:')
        ? 'native-fixture'
        : errorType === 'PrivilegeNotHeldException'
          ? 'privilege-not-held'
          : errorType === 'PlatformNotSupportedException'
            ? 'platform-api-unavailable'
            : code === 'EACCES' || code === 'EPERM' || errorType === 'UnauthorizedAccessException'
              ? 'access-denied'
              : code === 'ETIMEDOUT' || errorType === 'TimeoutError'
                ? 'timeout'
                : errorType === 'AssertionError'
                  ? 'assertion'
                  : 'unclassified'
      const sourceLocation = message.match(/([^\\/\s()]+\.test\.[cm]?[jt]sx?):(\d+):(\d+)/)
      const location = sourceLocation ? `${sourceLocation[1]}:${sourceLocation[2]}` : 'unavailable'
      const safeCode = code ? ` code=${code}` : ''
      process.stdout.write(
        `Failed test case: shard=${shardIndex} file=${file} title=${title} ` +
          `type=${errorType} category=${category}${safeCode} at=${location}\n`
      )
    }
  }
}

const missingFiles = [...expectedFiles].filter(file => !seenFiles.has(file)).sort()
if (missingFiles.length > 0) {
  throw new Error(
    `The Windows suite omitted ${missingFiles.length} expected test files: ${missingFiles.slice(0, 12).join(', ')}`
  )
}
if (seenFiles.size !== expectedFiles.size)
  throw new Error('Windows shard file coverage is incomplete')

for (const file of [
  'windowsSessionAuthorityAcl.native.test.ts',
  'windowsSessionAuthorityDurableFileOps.native.test.ts',
]) {
  const matches = allResults.filter(
    result => path.basename(String(result.name).replaceAll('\\', '/')) === file
  )
  if (matches.length !== 1) throw new Error(`Required native suite missing or duplicated: ${file}`)
  const assertions = matches[0].assertionResults ?? []
  if (assertions.length === 0 || assertions.some(assertion => assertion.status !== 'passed')) {
    throw new Error(`Required native suite failed, skipped a case or ran no cases: ${file}`)
  }
}

const producerFiles = [
  'appService.pendingExternalLogoutKeytarUnavailable.test.ts',
  'appService.persistenceMutation.contract.test.ts',
  'appService.passwordLoginRollback.regression.test.ts',
]
const linuxSkipTitle = 'uses memory-only mode when Linux safeStorage selects the basic_text backend'
for (const file of producerFiles) {
  const matches = allResults.filter(
    result => path.basename(String(result.name).replaceAll('\\', '/')) === file
  )
  if (matches.length !== 1) throw new Error(`Producer-backed suite missing or duplicated: ${file}`)
  const assertions = matches[0].assertionResults ?? []
  const passed = assertions.filter(assertion => assertion.status === 'passed')
  const expectedLinuxSkips =
    file === 'appService.pendingExternalLogoutKeytarUnavailable.test.ts'
      ? assertions.filter(
          assertion => assertion.title === linuxSkipTitle && assertion.status === 'skipped'
        )
      : []
  if (passed.length === 0) throw new Error(`Producer-backed suite ran no passing cases: ${file}`)
  if (
    file === 'appService.pendingExternalLogoutKeytarUnavailable.test.ts' &&
    expectedLinuxSkips.length !== 1
  ) {
    throw new Error('Expected exactly one named Linux-only Windows skip')
  }
  const unexpected = assertions.filter(
    assertion =>
      assertion.status !== 'passed' &&
      !(
        file === 'appService.pendingExternalLogoutKeytarUnavailable.test.ts' &&
        assertion.title === linuxSkipTitle &&
        assertion.status === 'skipped'
      )
  )
  if (unexpected.length > 0)
    throw new Error(`Producer-backed suite failed or skipped unexpected cases: ${file}`)
  process.stdout.write(
    `Producer-backed suite passed: ${file} passed=${passed.length} namedLinuxSkip=${expectedLinuxSkips.length}\n`
  )
}

if (totalFailed !== 0 || totalPassed + totalSkipped !== totalTests) {
  throw new Error('The complete Windows Desktop suite contains failed or unaccounted test cases')
}

const summary =
  [
    '# PR 977 exact-source Windows full Desktop suite',
    `Application source SHA: ${sourceSha}`,
    `Workflow trigger and harness SHA: ${harnessSha}`,
    `Shard count: ${expectedShardCount}`,
    `Complete test-file coverage: ${seenFiles.size}/${expectedFiles.size}`,
    `Full Desktop suite: files=${totalSuites} tests=${totalTests} passed=${totalPassed} failed=${totalFailed} skipped=${totalSkipped}`,
  ].join('\n') + '\n'
process.stdout.write(summary)
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })
}
