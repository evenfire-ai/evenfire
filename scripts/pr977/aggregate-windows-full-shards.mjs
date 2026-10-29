import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [reportDirectory, sourceDesktopRoot, sourceSha, harnessSha, nativeReportPath] =
  process.argv.slice(2)
const expectedShardCount = 8
if (!reportDirectory || !sourceDesktopRoot || !sourceSha || !harnessSha || !nativeReportPath) {
  throw new Error('Expected shard reports, source root, source SHA, harness SHA, and native report')
}

const sourceRoot = path.dirname(sourceDesktopRoot)
const sourceHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
if (sourceHead !== sourceSha) throw new Error('Aggregate checkout does not match tested source SHA')

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
  ['-C', sourceRoot, 'ls-files', '-z', '--', 'desktop-app'],
  {
    encoding: 'utf8',
  }
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

const nativeFiles = new Set([
  'src/__tests__/windowsSessionAuthorityAcl.native.test.ts',
  'src/__tests__/windowsSessionAuthorityDurableFileOps.native.test.ts',
])
for (const file of nativeFiles) {
  if (!expectedFiles.has(file))
    throw new Error(`Required native suite is not source-tracked: ${file}`)
}

const allowedWindowsSkips = new Map([
  [
    'appService.pendingExternalLogoutKeytarUnavailable.test.ts',
    new Set(['uses memory-only mode when Linux safeStorage selects the basic_text backend']),
  ],
  [
    'sessionPersistenceJournal.test.ts',
    new Set([
      'quarantines only a confirmed wrong-mode writer journal after its denial fence callback',
      'preserves confirmed invalid-file evidence when descriptor close also fails transiently',
    ]),
  ],
  [
    'tokenStore.fallbackRetirement.test.ts',
    new Set(['rejects an actual nonregular FIFO without blocking']),
  ],
  [
    'tokenStore.encryptedGuards.test.ts',
    new Set([
      'discard refuses a real nonregular FIFO before decrypting bytes',
      'repair refuses a real nonregular FIFO before decrypting bytes',
    ]),
  ],
])
const expectedSkipKeys = new Set(
  [...allowedWindowsSkips].flatMap(([file, titles]) =>
    [...titles].map(title => `${file}\0${title}`)
  )
)

const shardFiles = readdirSync(reportDirectory)
  .filter(file => /^shard-[1-8]\.json$/.test(file))
  .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]))
if (shardFiles.length !== expectedShardCount) {
  throw new Error(`Expected ${expectedShardCount} shard reports; found ${shardFiles.length}`)
}

const normalizeTestFile = name => {
  let normalizedName = String(name).replaceAll('\\', '/')
  const desktopRootMarker = '/desktop-app/'
  const markerIndex = normalizedName.lastIndexOf(desktopRootMarker)
  if (markerIndex >= 0)
    normalizedName = normalizedName.slice(markerIndex + desktopRootMarker.length)
  else normalizedName = normalizedName.replace(/^\.\//, '').replace(/^desktop-app\//, '')
  return normalizedName
}
const nativeReport = JSON.parse(readFileSync(nativeReportPath, 'utf8'))
if (
  !Array.isArray(nativeReport.testResults) ||
  nativeReport.testResults.length !== 2 ||
  nativeReport.numTestFiles !== 2
) {
  throw new Error('Native Windows report is missing one or both required suites')
}
if (nativeReport.counterConsistency?.valid !== true)
  throw new Error('Native Windows report has inconsistent aggregate counters')
const nativeNames = new Set(nativeReport.testResults.map(result => normalizeTestFile(result.name)))
if (
  nativeNames.size !== nativeFiles.size ||
  [...nativeFiles].some(file => !nativeNames.has(file))
) {
  throw new Error('Native Windows report does not match the two required source suites')
}

const reports = [
  ...shardFiles.map(file => ({
    label: Number(file.match(/\d+/)[0]),
    file,
    report: JSON.parse(readFileSync(path.join(reportDirectory, file), 'utf8')),
  })),
  { label: 'native', file: path.basename(nativeReportPath), report: nativeReport },
]
const seenFiles = new Set()
const allResults = []
const observedSkipKeys = new Map()
let totalSuites = 0
let totalTests = 0
let totalPassed = 0
let totalFailed = 0
let totalSkipped = 0
let totalTodo = 0

for (const { label, file, report } of reports) {
  if (
    report.counterConsistency?.valid !== true ||
    !report.success ||
    report.numTestFiles <= 0 ||
    report.numTotalTests <= 0
  ) {
    throw new Error(`${file} failed or executed no test suites/cases`)
  }
  if (!Array.isArray(report.testResults)) throw new Error(`${file} has no test result list`)
  totalSuites += report.numTestFiles
  totalTests += report.numTotalTests
  totalPassed += report.numPassedTests
  totalFailed += report.numFailedTests
  totalSkipped += report.numPendingTests
  totalTodo += report.numTodoTests ?? 0

  for (const result of report.testResults) {
    const normalizedName = normalizeTestFile(result.name)
    if (!expectedFiles.has(normalizedName)) {
      throw new Error(`${file} reported a file outside the expected Desktop suite`)
    }
    if (seenFiles.has(normalizedName))
      throw new Error(`A test file ran more than once: ${normalizedName}`)
    seenFiles.add(normalizedName)
    allResults.push(result)
    for (const [index, assertion] of (result.assertionResults ?? []).entries()) {
      if (assertion.status === 'passed') continue
      if (assertion.status === 'failed') {
        const failure = assertion.failure ?? {}
        const errorType = String(failure.errorType ?? 'unclassified')
        const category = String(failure.category ?? 'unclassified')
        const code = typeof failure.code === 'string' ? failure.code : null
        const location = String(failure.location ?? 'unavailable')
        const title = String(assertion.title ?? `case-${index + 1}`).slice(0, 180)
        process.stdout.write(
          `Failed test: shard=${label} file=${path.basename(normalizedName)} case=${index + 1} ` +
            `title=${title} type=${errorType} category=${category}${code ? ` code=${code}` : ''} at=${location}\n`
        )
        continue
      }
      if (!['skipped', 'pending'].includes(assertion.status)) {
        throw new Error(`Unknown assertion status in ${path.basename(normalizedName)}`)
      }
      const fileName = path.basename(normalizedName)
      const title = String(assertion.title ?? '')
      const key = `${fileName}\0${title}`
      if (!expectedSkipKeys.has(key)) {
        throw new Error(`Unapproved Windows skip: ${fileName} case-${index + 1}`)
      }
      observedSkipKeys.set(key, (observedSkipKeys.get(key) ?? 0) + 1)
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
  throw new Error('Windows test-file coverage is incomplete')
for (const key of expectedSkipKeys) {
  if (observedSkipKeys.get(key) !== 1)
    throw new Error('Windows skip inventory did not match the approved allowlist')
}
if (totalSkipped !== expectedSkipKeys.size)
  throw new Error('Windows suite had an unaccounted skipped test')
if (totalTodo !== 0) throw new Error('Windows suite contains todo tests')

for (const file of nativeFiles) {
  const result = allResults.find(item => normalizeTestFile(item.name) === file)
  const assertions = result?.assertionResults ?? []
  if (
    !result ||
    assertions.length === 0 ||
    assertions.some(assertion => assertion.status !== 'passed')
  ) {
    throw new Error(
      `Required native suite failed, skipped a case or ran no cases: ${path.basename(file)}`
    )
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
    result => path.basename(normalizeTestFile(result.name)) === file
  )
  if (matches.length !== 1) throw new Error(`Producer-backed suite missing or duplicated: ${file}`)
  const assertions = matches[0].assertionResults ?? []
  const passed = assertions.filter(assertion => assertion.status === 'passed')
  const expectedLinuxSkips = assertions.filter(
    assertion =>
      assertion.title === linuxSkipTitle && ['skipped', 'pending'].includes(assertion.status)
  )
  if (passed.length === 0) throw new Error(`Producer-backed suite ran no passing cases: ${file}`)
  if (
    file === 'appService.pendingExternalLogoutKeytarUnavailable.test.ts'
      ? expectedLinuxSkips.length !== 1
      : expectedLinuxSkips.length !== 0
  ) {
    throw new Error(`Producer-backed suite skip inventory was unexpected: ${file}`)
  }
}

if (totalFailed !== 0 || totalPassed + totalSkipped + totalTodo !== totalTests) {
  throw new Error('The complete Windows Desktop suite contains failed or unaccounted cases')
}

const summary =
  [
    '# PR 977 exact-source Windows full Desktop suite',
    `Application source SHA: ${sourceSha}`,
    `Workflow trigger and harness SHA: ${harnessSha}`,
    `Windows shards: ${expectedShardCount}`,
    'Native ACL and durability suites: separately gated before shards',
    `Complete test-file coverage: ${seenFiles.size}/${expectedFiles.size}`,
    `Full Desktop suite: files=${totalSuites} tests=${totalTests} passed=${totalPassed} failed=${totalFailed} skipped=${totalSkipped} todo=${totalTodo}`,
  ].join('\n') + '\n'
process.stdout.write(summary)
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })
