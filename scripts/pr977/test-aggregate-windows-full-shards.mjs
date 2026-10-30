import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot || !path.isAbsolute(scratchRoot)) {
  throw new Error('Set CODEX_SCRATCH_ROOT to an absolute task-owned scratch root')
}

const here = path.dirname(fileURLToPath(import.meta.url))
const aggregateScript = path.join(here, 'aggregate-windows-full-shards.mjs')
const temporaryRoot = mkdtempSync(path.join(scratchRoot, 'pr977-aggregate-proof-'))
const repository = path.join(temporaryRoot, 'source')
const desktop = path.join(repository, 'desktop-app')
const reportDirectory = path.join(temporaryRoot, 'reports')
const nativeReportPath = path.join(temporaryRoot, 'native.json')
let sourceSha = ''
const harnessSha = 'synthetic-harness-sha'

const testFiles = [
  'src/__tests__/windowsSessionAuthorityAcl.native.test.ts',
  'src/__tests__/windowsSessionAuthorityDurableFileOps.native.test.ts',
  'src/__tests__/appService.pendingExternalLogoutKeytarUnavailable.test.ts',
  'src/__tests__/appService.persistenceMutation.contract.test.ts',
  'src/__tests__/appService.passwordLoginRollback.regression.test.ts',
  'src/__tests__/sessionPersistenceJournal.test.ts',
  'src/__tests__/tokenStore.fallbackRetirement.test.ts',
  'src/__tests__/tokenStore.encryptedGuards.test.ts',
  'src/__tests__/tokenStore.fallbackRetirement.regression.test.ts',
  'src/__tests__/pluginAuditLog.test.ts',
  'src/__tests__/pluginConsentStore.test.ts',
  ...Array.from({ length: 10 }, (_, index) => `src/__tests__/ordinary-${index}.test.ts`),
]

const approvedSkips = new Map([
  [
    'src/__tests__/appService.pendingExternalLogoutKeytarUnavailable.test.ts',
    ['uses memory-only mode when Linux safeStorage selects the basic_text backend'],
  ],
  [
    'src/__tests__/sessionPersistenceJournal.test.ts',
    [
      'quarantines only a confirmed wrong-mode writer journal after its denial fence callback',
      'preserves confirmed invalid-file evidence when descriptor close also fails transiently',
    ],
  ],
  [
    'src/__tests__/tokenStore.fallbackRetirement.test.ts',
    ['rejects an actual nonregular FIFO without blocking'],
  ],
  [
    'src/__tests__/tokenStore.encryptedGuards.test.ts',
    [
      'discard refuses a real nonregular FIFO before decrypting bytes',
      'repair refuses a real nonregular FIFO before decrypting bytes',
    ],
  ],
  [
    'src/__tests__/tokenStore.fallbackRetirement.regression.test.ts',
    ['requires a durable directory sync on retry after a prior unlink succeeded'],
  ],
  ['src/__tests__/pluginAuditLog.test.ts', ['writes the file with POSIX mode 0600']],
  ['src/__tests__/pluginConsentStore.test.ts', ['writes the file with POSIX mode 0600']],
])

function fileResult(name, options = {}) {
  const titles = ['observable producer contract passes', ...(approvedSkips.get(name) ?? [])]
  return {
    name: `desktop-app/${name}`,
    status: 'passed',
    assertionResults: titles.map((title, index) => ({
      title,
      status: options.failedIndex === index ? 'failed' : index === 0 ? 'passed' : 'skipped',
      ...(options.unexpectedSkipIndex === index ? { status: 'skipped' } : {}),
      ...(options.failedIndex === index
        ? { failure: { category: 'assertion', errorType: 'AssertionError' } }
        : {}),
    })),
  }
}

function report(results, overrides = {}) {
  const assertions = results.flatMap(result => result.assertionResults)
  const passed = assertions.filter(result => result.status === 'passed').length
  const failed = assertions.filter(result => result.status === 'failed').length
  const skipped = assertions.filter(result => result.status === 'skipped').length
  return {
    success: failed === 0,
    numTotalTestSuites: results.length + 3,
    numPassedTestSuites: results.length + 3,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTestFiles: results.length,
    numTotalTests: assertions.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: skipped,
    numTodoTests: 0,
    counterConsistency: { valid: true },
    testResults: results,
    ...overrides,
  }
}

function writeFixture(reports) {
  rmSync(reportDirectory, { recursive: true, force: true })
  mkdirSync(reportDirectory, { recursive: true })
  const shardFiles = testFiles.filter(name => !name.endsWith('.native.test.ts'))
  for (let index = 0; index < 8; index += 1) {
    const start = Math.floor((shardFiles.length * index) / 8)
    const end = Math.floor((shardFiles.length * (index + 1)) / 8)
    const contents =
      reports?.[index] ?? report(shardFiles.slice(start, end).map(name => fileResult(name)))
    writeFileSync(path.join(reportDirectory, `shard-${index + 1}.json`), JSON.stringify(contents))
  }
  const nativeResults = testFiles
    .filter(name => name.endsWith('.native.test.ts'))
    .map((name, index) => ({
      name: `desktop-app/${name}`,
      status: 'passed',
      assertionResults: Array.from({ length: index === 0 ? 13 : 4 }, (_, caseIndex) => ({
        title: `native case ${caseIndex + 1}`,
        status: 'passed',
      })),
    }))
  writeFileSync(nativeReportPath, JSON.stringify(report(nativeResults)))
}

function runAggregator() {
  return spawnSync(
    process.execPath,
    [aggregateScript, reportDirectory, desktop, sourceSha, harnessSha, nativeReportPath],
    { encoding: 'utf8' }
  )
}

try {
  mkdirSync(desktop, { recursive: true })
  for (const name of testFiles) {
    const filePath = path.join(desktop, name)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, '')
  }
  execFileSync('git', ['init', '-q', repository])
  execFileSync('git', ['-C', repository, 'add', 'desktop-app'])
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=PR977 test fixture',
    '-c',
    'user.email=pr977-fixture@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture',
  ])
  sourceSha = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()

  writeFixture()
  const passing = runAggregator()
  assert.equal(passing.status, 0, passing.stderr)
  assert.match(passing.stdout, /Complete test-file coverage: 21\/21/)
  assert.match(passing.stdout, /failed=0 skipped=9 todo=0/)

  const incompleteReports = Array.from({ length: 8 }, (_, index) => {
    const shardFiles = testFiles.filter(name => !name.endsWith('.native.test.ts'))
    const start = Math.floor((shardFiles.length * index) / 8)
    const end = Math.floor((shardFiles.length * (index + 1)) / 8)
    return report(shardFiles.slice(start, end).map(name => fileResult(name)))
  })
  incompleteReports[0] = report(incompleteReports[0].testResults.slice(1))
  writeFixture(incompleteReports)
  const missingCoverage = runAggregator()
  assert.notEqual(missingCoverage.status, 0)
  assert.match(missingCoverage.stderr, /omitted .* expected test files/)

  const skipReports = Array.from({ length: 8 }, (_, index) => {
    const shardFiles = testFiles.filter(name => !name.endsWith('.native.test.ts'))
    const start = Math.floor((shardFiles.length * index) / 8)
    const end = Math.floor((shardFiles.length * (index + 1)) / 8)
    return report(shardFiles.slice(start, end).map(name => fileResult(name)))
  })
  skipReports[0].testResults[0].assertionResults[0] = {
    title: 'unexpected silent skip',
    status: 'skipped',
  }
  writeFixture(skipReports)
  const unexpectedSkip = runAggregator()
  assert.notEqual(unexpectedSkip.status, 0)
  assert.match(unexpectedSkip.stderr, /Unapproved Windows skip/)

  const inconsistentReports = Array.from({ length: 8 }, (_, index) => {
    const shardFiles = testFiles.filter(name => !name.endsWith('.native.test.ts'))
    const start = Math.floor((shardFiles.length * index) / 8)
    const end = Math.floor((shardFiles.length * (index + 1)) / 8)
    return report(shardFiles.slice(start, end).map(name => fileResult(name)))
  })
  inconsistentReports[0].counterConsistency.valid = false
  writeFixture(inconsistentReports)
  const inconsistent = runAggregator()
  assert.notEqual(inconsistent.status, 0)
  assert.match(inconsistent.stderr, /failed or executed no test suites\/cases/)

  process.stdout.write('Windows shard aggregator coverage, skip and counter fixtures passed.\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
