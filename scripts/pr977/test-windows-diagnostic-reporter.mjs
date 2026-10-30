import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [dependencyRoot, applicationRoot] = process.argv.slice(2)
const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (
  ![dependencyRoot, applicationRoot, scratchRoot].every(value => value && path.isAbsolute(value))
) {
  throw new Error('Expected absolute dependency, application Desktop and scratch roots')
}
const here = path.dirname(fileURLToPath(import.meta.url))
const scratchDirectory = path.join(scratchRoot, 'evenfire')
mkdirSync(scratchDirectory, { recursive: true })
const directory = mkdtempSync(path.join(scratchDirectory, 'pr977-reporter-proof-'))
try {
  symlinkSync(
    path.join(dependencyRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  writeFileSync(
    path.join(directory, 'vitest.config.mjs'),
    `export default { test: { include: ['*.test.ts'], fileParallelism: false } }\n`
  )
  writeFileSync(
    path.join(directory, 'boundary.test.ts'),
    `
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { verifyWindowsSessionAuthorityDirectory } from ${JSON.stringify(path.join(applicationRoot, 'src/windowsSessionAuthorityAcl.ts'))}
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', descriptor); vi.unstubAllEnvs() })
describe('producer-backed diagnostics', () => {
  it('verifier rejection', () => {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    vi.stubEnv('SystemRoot', 'C:\\\\Windows'); vi.stubEnv('TEMP', 'C:\\\\fixture')
    spawn.mockReturnValue({ pid: 123, status: 1, signal: null, stdout: JSON.stringify({ ok: false, phase: 'validate-authority-tree', errorType: 'UnauthorizedAccessException', hresult: '0x80070005', detail: 'unsafe-ace' }), stderr: 'EVENFIRE_ACL_PHASE=validate-authority-tree\\n' })
    verifyWindowsSessionAuthorityDirectory('C:\\\\fixture', 'C:\\\\fixture\\\\sessions')
  })
  it('plugin ACL timeout diagnostic', () => {
    throw Object.assign(new Error('Plugin storage privacy could not be verified'), {
      name: 'PluginStoragePrivacyError',
      reason: 'native-inspection-process-timeout',
      diagnostic: {
        failure: 'process-timeout',
        elapsedMs: 15000,
        processErrorCode: 'ETIMEDOUT',
        exitStatus: null,
        nativePhase: 'inspect-object',
        privatePath: 'C:\\\\Users\\\\private\\\\secret.txt',
      },
    })
  })
  it('plugin ACL helper-load diagnostic', () => {
    throw Object.assign(new Error('Plugin storage privacy could not be verified'), {
      name: 'PluginStoragePrivacyError',
      reason: 'native-inspection-helper-load-failed',
      diagnostic: {
        failure: 'helper-load-failed',
        elapsedMs: 4200,
        exitStatus: 2,
        nativePhase: 'load-native-helper',
        nativeErrorType: 'FileNotFoundException',
        hresult: '0x80070002',
        nativeReason: 'native-helper-path-missing',
        privatePath: 'C:\\Users\\private\\secret.dll',
      },
    })
  })
  it('plugin ACL request-setup diagnostic', () => {
    throw Object.assign(new Error('Plugin storage privacy could not be verified'), {
      name: 'PluginStoragePrivacyError',
      reason: 'native-inspection-request-setup-failed',
      diagnostic: {
        failure: 'request-setup-failed',
        elapsedMs: 1200,
        exitStatus: 2,
        nativePhase: 'prepare-request',
        nativeErrorType: 'FormatException',
        hresult: '0x80131537',
        nativeReason: 'private-token-value',
        privatePath: 'C:\\Users\\private\\request.json',
      },
    })
  })
  it('assertion mismatch', () => { expect('synthetic-private-value').toBe('expected-value') })
  it('test timeout', async () => { await new Promise(() => {}) }, 20)
  describe('setup', () => {
    beforeEach(() => { throw new Error('Native Windows ACL fixture failed: {"operation":"add-everyone-modify","exitStatus":1,"powershellFailureCategory":"access-denied"}') })
    it('fixture setup', () => {})
  })
  describe('teardown', () => {
    afterEach(() => { throw new Error('private teardown details') })
    it('fixture teardown', () => {})
  })
})
`
  )
  writeFileSync(
    path.join(directory, 'passing.test.ts'),
    `
import { describe, it, expect } from 'vitest'
describe('outer', () => { describe('inner', () => { it('passes', ({ task }) => { expect(task.timeout).toBe(150000); expect(1).toBe(1) }) }) })
`
  )
  writeFileSync(
    path.join(directory, 'collection.test.ts'),
    `import './missing-collection-module.js'\n`
  )
  const vitest = path.join(dependencyRoot, 'node_modules/vitest/vitest.mjs')
  const outputs = {}
  for (const [name, reporter] of [
    ['standard', 'json'],
    ['enriched', path.join(here, 'windows-diagnostic-reporter.mjs')],
  ]) {
    const output = path.join(directory, `${name}.json`)
    const progress = path.join(directory, `${name}-progress.jsonl`)
    const processResult = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        '--root',
        directory,
        '--testTimeout=150000',
        '--hookTimeout=30000',
        `--reporter=${reporter}`,
        `--outputFile=${output}`,
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PR977_DESKTOP_ROOT: dependencyRoot,
          PR977_PROGRESS_PATH: name === 'enriched' ? progress : '',
        },
      }
    )
    assert.equal(processResult.status, 1, 'Controlled failed assertions must keep Vitest red')
    if (!existsSync(output))
      throw new Error(`Reporter omitted ${name} JSON: ${processResult.stderr}`)
    outputs[name] = JSON.parse(readFileSync(output, 'utf8'))
  }
  assert.ok(outputs.enriched.numTotalTestSuites > outputs.enriched.testResults.length)
  for (const field of [
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites',
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
  ]) {
    assert.equal(outputs.enriched[field], outputs.standard[field], `Reporter changed ${field}`)
  }
  const standardCases = outputs.standard.testResults.flatMap(file => file.assertionResults)
  const timeout = standardCases.find(test => test.title === 'test timeout')
  assert.match(timeout.failureMessages[0], /STACK_TRACE_ERROR/)
  assert.doesNotMatch(timeout.failureMessages[0], /Test timed out/)
  // Normalize only generated fixture filenames to a permitted Desktop-relative namespace.
  outputs.enriched.testResults.forEach(file => {
    file.name = `src/__tests__/${path.basename(file.name)}`
  })
  const raw = path.join(directory, 'enriched-normalized.json')
  const safe = path.join(directory, 'safe.json')
  writeFileSync(raw, JSON.stringify(outputs.enriched))
  const sanitized = spawnSync(
    process.execPath,
    [
      process.env.PR977_SANITIZER_PATH ?? path.join(here, 'sanitize-windows-vitest-report.mjs'),
      raw,
      safe,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(sanitized.status, 0)
  const report = JSON.parse(readFileSync(safe, 'utf8'))
  assert.equal(report.success, false)
  assert.equal(report.counterConsistency.valid, true)
  assert.equal(report.numTestFiles, 3)
  const cases = new Map(
    report.testResults.flatMap(file => file.assertionResults).map(test => [test.title, test])
  )
  assert.equal(cases.get('passes').status, 'passed')
  assert.equal(report.numFailedTests, 8)
  assert.equal(cases.get('verifier rejection').failure.category, 'native-verifier')
  assert.equal(cases.get('verifier rejection').failure.diagnostic.verifierHresult, '0x80070005')
  assert.equal(
    cases.get('plugin ACL timeout diagnostic').failure.category,
    'native-process-timeout'
  )
  assert.deepEqual(cases.get('plugin ACL timeout diagnostic').failure.pluginStorageDiagnostic, {
    failure: 'process-timeout',
    elapsedMs: 15000,
    processErrorCode: 'ETIMEDOUT',
    exitStatus: null,
    nativePhase: 'inspect-object',
  })
  assert.equal(
    cases.get('plugin ACL helper-load diagnostic').failure.category,
    'native-helper-load-failed'
  )
  assert.deepEqual(cases.get('plugin ACL helper-load diagnostic').failure.pluginStorageDiagnostic, {
    failure: 'helper-load-failed',
    elapsedMs: 4200,
    exitStatus: 2,
    nativePhase: 'load-native-helper',
    nativeErrorType: 'FileNotFoundException',
    hresult: '0x80070002',
    nativeReason: 'native-helper-path-missing',
  })
  assert.equal(
    cases.get('plugin ACL request-setup diagnostic').failure.category,
    'native-request-setup-failed'
  )
  assert.deepEqual(
    cases.get('plugin ACL request-setup diagnostic').failure.pluginStorageDiagnostic,
    {
      failure: 'request-setup-failed',
      elapsedMs: 1200,
      exitStatus: 2,
      nativePhase: 'prepare-request',
      nativeErrorType: 'FormatException',
      hresult: '0x80131537',
    }
  )
  assert.equal(cases.get('test timeout').failure.category, 'timeout')
  assert.equal(cases.get('fixture setup').failure.phase, 'setup')
  assert.equal(cases.get('fixture setup').failure.category, 'native-fixture')
  assert.equal(cases.get('fixture teardown').failure.phase, 'test-or-teardown')
  assert.deepEqual(cases.get('fixture teardown').failure.failedHooks, ['afterEach'])
  assert.equal(cases.get('assertion mismatch').failure.category, 'assertion')
  const collection = report.testResults.find(file => file.name.endsWith('/collection.test.ts'))
  assert.equal(collection.status, 'failed')
  assert.equal(collection.failure.phase, 'collection')
  assert.equal(collection.failure.category, 'module-resolution')
  assert.equal(collection.failure.code, 'ERR_MODULE_NOT_FOUND')
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-value|private-token-value|teardown details|Users|C:\\\\/
  )
  const progress = readFileSync(path.join(directory, 'enriched-progress.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line))
  assert.ok(progress.some(event => event.event === 'file-started'))
  assert.ok(progress.some(event => event.event === 'case-started'))
  const startedCases = new Map(
    progress
      .filter(event => event.event === 'case-started')
      .map(event => [event.activeCase, event.activeFile])
  )
  for (const title of [
    'verifier rejection',
    'plugin ACL timeout diagnostic',
    'plugin ACL helper-load diagnostic',
    'plugin ACL request-setup diagnostic',
    'assertion mismatch',
    'test timeout',
    'fixture setup',
    'fixture teardown',
  ]) {
    assert.equal(startedCases.get(title), 'boundary.test.ts', `Incorrect owner for ${title}`)
  }
  assert.equal(startedCases.get('passes'), 'passing.test.ts', 'Incorrect owner for passing case')
  assert.ok(
    progress.some(event => event.event === 'hook-started' && event.activeHook === 'beforeEach')
  )
  assert.ok(progress.some(event => event.event === 'hook-completed'))
  assert.ok(progress.some(event => event.event === 'case-completed'))
  assert.ok(progress.some(event => event.event === 'file-completed'))
  assert.ok(
    progress.every(event => !/Users|C:\\\\|synthetic-private-value/.test(JSON.stringify(event)))
  )
  process.stdout.write(
    'Actual Vitest nested-suite, original-message, verifier, timeout, setup, teardown and assertion proofs passed.\n'
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
