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
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { focusedTestNamePattern } from './focused-windows-plan.mjs'

const [dependencyRoot, applicationRoot] = process.argv.slice(2)
const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (
  ![dependencyRoot, applicationRoot, scratchRoot].every(value => value && path.isAbsolute(value))
) {
  throw new Error('Expected absolute dependency, application Desktop and scratch roots')
}
const here = path.dirname(fileURLToPath(import.meta.url))
const requireFromDesktop = createRequire(path.join(applicationRoot, 'package.json'))
const { load: loadYaml } = requireFromDesktop('js-yaml')
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
        nativePhase: 'inspect-start',
        nativeOrdinal: 2,
        ignoredOrdinal: 100,
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
        nativePhase: 'helper-load-start',
        nativeOrdinal: 0,
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
        nativePhase: 'request-prepare-start',
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
  const caseManifest = JSON.parse(
    readFileSync(path.join(here, '../../.validation/windows/focused-test-cases.json'), 'utf8')
  )
  const nativeTestSource = readFileSync(
    path.join(applicationRoot, 'src/__tests__/pluginStorageWindowsAcl.native.test.ts'),
    'utf8'
  )
  const nativeCaseTitles = [...nativeTestSource.matchAll(/\bwindowsIt\s*\(\s*'([^']+)'/g)].map(
    match => match[1]
  )
  const ordinaryCaseTitles = [...nativeTestSource.matchAll(/\bit\s*\(\s*'([^']+)'/g)].map(
    match => match[1]
  )
  const manifestCaseTitles = [...caseManifest.selected, ...caseManifest.deselected]
  assert.equal(nativeCaseTitles.length, 12, 'Unexpected native plugin privacy case inventory')
  assert.equal(new Set(nativeCaseTitles).size, nativeCaseTitles.length, 'Duplicate source cases')
  assert.deepEqual(ordinaryCaseTitles, [
    'records bounded cleanup phases and entry ordinals',
    'reports an allowlisted cleanup error and leaves teardown fatal',
  ])
  const sourceCaseTitles = [...nativeCaseTitles, ...ordinaryCaseTitles]
  assert.equal(sourceCaseTitles.length, 14, 'Unexpected complete plugin storage case inventory')
  assert.equal(new Set(sourceCaseTitles).size, sourceCaseTitles.length, 'Duplicate source cases')
  assert.deepEqual(
    [...manifestCaseTitles].sort(),
    [...sourceCaseTitles].sort(),
    'Focused manifest must account for every native and ordinary source case exactly once'
  )
  assert.throws(() =>
    assert.deepEqual(
      [...manifestCaseTitles].sort(),
      [...sourceCaseTitles, 'unrecorded case'].sort()
    )
  )
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alternatives = caseManifest.selected.map(escapeRegExp).join('|')
  writeFileSync(
    path.join(directory, 'selection.test.ts'),
    `import { describe, it, expect } from 'vitest'
describe('Windows plugin storage DACL privacy', () => {
  ${[...caseManifest.selected, ...caseManifest.deselected]
    .map(title => `it(${JSON.stringify(title)}, () => expect(true).toBe(true))`)
    .concat(
      `it(${JSON.stringify(`prefix ${caseManifest.selected[0]} suffix`)}, () => expect(true).toBe(true))`
    )
    .join('\n  ')}
})
`
  )
  writeFileSync(
    path.join(directory, 'collection.test.ts'),
    `import './missing-collection-module.js'\n`
  )
  const selectionFile = path.join(directory, 'selection.test.ts')
  const vitest = path.join(dependencyRoot, 'node_modules/vitest/vitest.mjs')
  function runSelection(pattern, outputName) {
    const output = path.join(directory, outputName)
    const processResult = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        '--root',
        directory,
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--reporter=json',
        `--outputFile.json=${output}`,
        '--testNamePattern',
        pattern,
        selectionFile,
      ],
      { encoding: 'utf8', timeout: 30000, cwd: directory }
    )
    assert.equal(processResult.status, 0, processResult.stderr)
    return JSON.parse(readFileSync(output, 'utf8'))
  }
  const anchoredSelection = runSelection(`^(?:${alternatives})$`, 'anchored-selection.json')
  assert.equal(anchoredSelection.numPassedTests, 0)
  assert.equal(
    anchoredSelection.numPendingTests,
    caseManifest.selected.length + caseManifest.deselected.length + 1
  )
  const decoyTitle = `prefix ${caseManifest.selected[0]} suffix`
  for (const processSpec of caseManifest.processes) {
    const processPattern = focusedTestNamePattern(processSpec)
    const processSelection = runSelection(processPattern, `${processSpec.id}-selection.json`)
    assert.equal(processSelection.numPassedTests, processSpec.selected.length)
    assert.equal(
      processSelection.numPendingTests,
      manifestCaseTitles.length - processSpec.selected.length + 1
    )
    assert.equal(processSelection.numFailedTests, 0)
    const selectedStatuses = new Map(
      processSelection.testResults.flatMap(file =>
        file.assertionResults.map(item => [item.title, item.status])
      )
    )
    for (const title of processSpec.selected)
      assert.equal(selectedStatuses.get(title), 'passed', `${processSpec.id} omitted ${title}`)
    for (const title of caseManifest.selected.filter(
      value => !processSpec.selected.includes(value)
    ))
      assert.ok(['pending', 'skipped'].includes(selectedStatuses.get(title)))
    for (const title of caseManifest.deselected)
      assert.ok(['pending', 'skipped'].includes(selectedStatuses.get(title)))
    assert.ok(['pending', 'skipped'].includes(selectedStatuses.get(decoyTitle)))
  }
  const completePattern = `^Windows plugin storage DACL privacy (?:${manifestCaseTitles
    .map(escapeRegExp)
    .join('|')})$`
  const completeInventory = runSelection(completePattern, 'complete-inventory.json')
  assert.equal(completeInventory.numTotalTests, manifestCaseTitles.length + 1)
  assert.equal(completeInventory.numPassedTests, manifestCaseTitles.length)
  assert.equal(completeInventory.numPendingTests, 1)
  assert.equal(completeInventory.numFailedTests, 0)
  rmSync(selectionFile)

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
    nativePhase: 'inspect-start',
    nativeOrdinal: 2,
  })
  assert.equal(
    cases.get('plugin ACL helper-load diagnostic').failure.category,
    'native-helper-load-failed'
  )
  assert.deepEqual(cases.get('plugin ACL helper-load diagnostic').failure.pluginStorageDiagnostic, {
    failure: 'helper-load-failed',
    elapsedMs: 4200,
    exitStatus: 2,
    nativePhase: 'helper-load-start',
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
      nativePhase: 'request-prepare-start',
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
  const focusedWorkflow = readFileSync(
    path.join(here, '../../.github/workflows/pr977-windows-focused.yml'),
    'utf8'
  )
  const fullWorkflow = readFileSync(
    path.join(here, '../../.github/workflows/pr977-exact-source-windows-full-sharded.yml'),
    'utf8'
  )
  const focusedRunner = readFileSync(path.join(here, 'run-focused-windows-processes.mjs'), 'utf8')
  const expectedSourceSha = '0725bd5b872682c49c231225eda98aaea21fc16a'
  const expectedValidationRef = '${{ github.sha }}'
  const focusedConfig = loadYaml(focusedWorkflow)
  const fullConfig = loadYaml(fullWorkflow)
  const getCheckoutSteps = (workflow, checkoutPath) =>
    Object.values(workflow.jobs)
      .flatMap(job => job.steps ?? [])
      .filter(
        step => step.uses?.startsWith('actions/checkout@') && step.with?.path === checkoutPath
      )
  const assertPinnedCheckouts = (workflow, label, expectedSourceCheckouts) => {
    assert.equal(workflow.env.PR977_SOURCE_SHA, expectedSourceSha, `${label} source guard SHA`)
    const sourceCheckouts = getCheckoutSteps(workflow, 'source')
    const validationCheckouts = getCheckoutSteps(workflow, 'validation')
    assert.equal(sourceCheckouts.length, expectedSourceCheckouts, `${label} source checkout count`)
    assert.equal(
      validationCheckouts.length,
      expectedSourceCheckouts,
      `${label} validation checkout count`
    )
    for (const step of sourceCheckouts) {
      assert.equal(step.with.ref, expectedSourceSha, `${label} source checkout ref`)
    }
    for (const step of validationCheckouts) {
      assert.equal(step.with.ref, expectedValidationRef, `${label} validation checkout ref`)
    }
    const sourceCheckoutJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps?.some(
        step => step.uses?.startsWith('actions/checkout@') && step.with?.path === 'source'
      )
    )
    assert.equal(
      sourceCheckoutJobs.length,
      expectedSourceCheckouts,
      `${label} source-checkout jobs`
    )
    for (const [jobName, job] of sourceCheckoutJobs) {
      const verificationStep = job.steps.find(step => /Verify .*source/i.test(step.name ?? ''))
      assert.ok(verificationStep, `${label} ${jobName} must verify source and harness revisions`)
      const run = verificationStep.run ?? ''
      assert.ok(
        run.includes('$sourceSha -ne $env:PR977_SOURCE_SHA'),
        `${label} ${jobName} must compare the source checkout with its SHA guard`
      )
      assert.ok(
        run.includes('$harnessSha -ne $env:GITHUB_SHA') ||
          run.includes('$triggerSha -ne $harnessSha') ||
          run.includes('$env:GITHUB_SHA -ne $harnessSha'),
        `${label} ${jobName} must compare the harness checkout with the workflow SHA`
      )
    }
  }
  assert.equal(focusedConfig.on.push.branches[0], 'test/pr977-windows-68b8ea74-20261030-r24l11')
  assert.equal(fullConfig.on.push.branches[0], 'test/pr977-windows-68b8ea74-20261030-r24l11')
  assert.deepEqual(fullConfig.on.push.paths, ['.validation/windows/pr977-r24m7-run-2.trigger'])
  assertPinnedCheckouts(focusedConfig, 'Focused workflow', 1)
  assertPinnedCheckouts(fullConfig, 'Full workflow', 4)
  const staleFocusedConfig = structuredClone(focusedConfig)
  getCheckoutSteps(staleFocusedConfig, 'source')[0].with.ref =
    '68b8ea7430ade92e1107381f0d08d76a2c72ec71'
  assert.throws(
    () => assertPinnedCheckouts(staleFocusedConfig, 'Focused workflow', 1),
    /Focused workflow source checkout ref/
  )
  const staleFullConfig = structuredClone(fullConfig)
  getCheckoutSteps(staleFullConfig, 'source')[2].with.ref =
    '68b8ea7430ade92e1107381f0d08d76a2c72ec71'
  assert.throws(
    () => assertPinnedCheckouts(staleFullConfig, 'Full workflow', 4),
    /Full workflow source checkout ref/
  )
  assert.match(focusedWorkflow, /timeout-minutes:\s*12/)
  assert.match(focusedWorkflow, /noProgressMs -ne 120000/)
  assert.match(
    focusedWorkflow,
    /Run focused consent and audit processes with independent watchdogs/
  )
  assert.doesNotMatch(focusedWorkflow, /^\s*continue-on-error:\s*true\s*$/m)
  assert.match(focusedWorkflow, /if \(\$env:FOCUSED_RESULT -ne 'success'\)/)
  assert.match(focusedRunner, /--maximum-runtime-ms=\$\{processSpec\.maximumRuntimeMs\}/)
  assert.match(focusedRunner, /--no-progress-ms=\$\{processSpec\.noProgressMs\}/)
  assert.match(focusedRunner, /--retry=0/)
  assert.equal(caseManifest.selected.length, 5)
  assert.deepEqual(
    caseManifest.processes.map(value => value.maximumRuntimeMs),
    [345000, 180000]
  )
  assert.equal(
    caseManifest.processes.reduce((sum, value) => sum + value.maximumRuntimeMs, 0),
    525000
  )
  assert.match(focusedWorkflow, /Verify fixed native stderr phase capture/)
  assert.match(fullWorkflow, /desktop-windows-build:[\s\S]*?timeout-minutes:\s*20/)
  assert.match(fullWorkflow, /native-windows-authority:[\s\S]*?timeout-minutes:\s*20/)
  assert.match(fullWorkflow, /desktop-windows-shard:[\s\S]*?timeout-minutes:\s*25/)
  assert.match(fullWorkflow, /NATIVE_SUITE_STEP: \$\{\{ steps\.native_suite\.outcome \}\}/)
  assert.match(fullWorkflow, /FULL_SUITE_STEP: \$\{\{ steps\.full_suite\.outcome \}\}/)
  assert.match(fullWorkflow, /AGGREGATE_STEP: \$\{\{ steps\.aggregate\.outcome \}\}/)
  assert.equal(fullConfig.jobs['aggregate-windows-suite'].if, 'always()')
  assert.match(fullWorkflow, /if \(\$env:NATIVE_SUITE_STEP -ne 'success'\)/)
  assert.match(fullWorkflow, /if \(\$env:FULL_SUITE_STEP -ne 'success'\)/)
  assert.match(fullWorkflow, /if \(\$env:AGGREGATE_STEP -ne 'success'\)/)
  assert.match(fullWorkflow, /--maximum-runtime-ms=960000/)
  assert.match(fullWorkflow, /--maximum-runtime-ms=1200000/)
  assert.equal((fullWorkflow.match(/--no-progress-ms=120000/g) ?? []).length, 2)
  process.stdout.write(
    'Actual Vitest nested-suite, original-message, verifier, timeout, setup, teardown and assertion proofs passed.\n'
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
