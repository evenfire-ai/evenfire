import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import diagnostics from './windows-native-spawn-observer.cjs'

const {
  buildEnvironmentFingerprint,
  createObservedSpawnSync,
  sanitizeNativeHelperAttempt,
  validateEnvironmentFingerprint,
  validateNativeHelperAttempt,
} = diagnostics
const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot || !path.isAbsolute(scratchRoot))
  throw new Error('Fingerprint contract requires CODEX_SCRATCH_ROOT')
const scratchDirectory = path.join(scratchRoot, 'evenfire')
mkdirSync(scratchDirectory, { recursive: true })
const directory = mkdtempSync(path.join(scratchDirectory, 'pr977-native-fingerprint-proof-'))
const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const validationRoot = path.resolve(scriptRoot, '../..')

try {
  const focusedWorkflow = readFileSync(
    path.join(validationRoot, '.github/workflows/pr977-windows-focused.yml'),
    'utf8'
  )
  const focusedRunner = readFileSync(
    path.join(scriptRoot, 'run-focused-windows-processes.mjs'),
    'utf8'
  )
  const fingerprintCapture = readFileSync(
    path.join(scriptRoot, 'capture-windows-native-fingerprint.mjs'),
    'utf8'
  )
  assert.match(focusedWorkflow, /capture-windows-native-fingerprint\.mjs/)
  assert.match(focusedWorkflow, /test-windows-native-fingerprint\.mjs/)
  assert.match(focusedWorkflow, /environment-fingerprint\.json/)
  assert.match(focusedWorkflow, /native-helper-load-attempts\.jsonl/)
  assert.match(focusedRunner, /validateEnvironmentFingerprint/)
  assert.match(focusedRunner, /windows-native-spawn-observer\.cjs/)
  assert.match(focusedRunner, /validateNativeHelperAttempt/)
  assert.match(fingerprintCapture, /System32[\s\S]*reg\.exe/)
  assert.match(
    fingerprintCapture,
    /HKLM\\\\SOFTWARE\\\\Microsoft\\\\PowerShell\\\\3\\\\PowerShellEngine/
  )
  assert.doesNotMatch(fingerprintCapture, /spawnSync\(\s*powershell/)

  const sourceSha = '585ab1466433c3bbb5120152baca17daafe7ef6f'
  const harnessSha = 'd689fcaa27b9a365344b37c47fc7d683353ee24a'
  const fingerprint = buildEnvironmentFingerprint({
    schemaVersion: 1,
    sourceSha,
    harnessSha,
    runnerImageLabel: 'windows-2025',
    runnerImageOS: 'win25',
    runnerImageVersion: '20261024.1.0',
    pinnedNodeVersion: '24.22.1',
    nodeVersion: 'v24.22.1',
    windowsPowerShellVersion: '5.1.26100.7705',
    clrVersion: '4.0.30319.42000',
    runtimeProbeSucceeded: true,
    nativeHelperPreparationSucceeded: true,
    preparationElapsedMs: 4_211,
    nativeHelperSha256: 'a'.repeat(64),
    nativeHelperByteLength: 24_576,
    inspectorTimeoutMs: 15_000,
    privatePath: 'C:\\Users\\person\\private\\helper.dll',
    token: 'sensitive-value',
  })
  assert.equal(fingerprint.nativeHelper.preparationElapsedMs, 4_211)
  assert.equal(fingerprint.nativeHelper.inspectorTimeoutMs, 15_000)
  assert.equal(fingerprint.nativeHelper.sha256, 'a'.repeat(64))
  assert.equal(fingerprint.nativeHelper.byteLength, 24_576)
  assert.equal(
    Object.keys(fingerprint).sort().join(','),
    [
      'clrVersion',
      'harnessSha',
      'nativeHelper',
      'node',
      'runner',
      'runtimeProbeSucceeded',
      'schemaVersion',
      'sourceSha',
      'windowsPowerShellVersion',
    ]
      .sort()
      .join(',')
  )
  assert.doesNotMatch(JSON.stringify(fingerprint), /private|person|token|sensitive-value/i)
  assert.deepEqual(validateEnvironmentFingerprint(fingerprint, sourceSha, harnessSha), fingerprint)
  assert.throws(() => validateEnvironmentFingerprint(fingerprint, '0'.repeat(40), harnessSha))
  assert.throws(() =>
    buildEnvironmentFingerprint({ ...fingerprint, runnerImageOS: 'win25\nsecret' })
  )
  const failedPreflightFingerprint = buildEnvironmentFingerprint({
    schemaVersion: 1,
    sourceSha,
    harnessSha,
    runnerImageLabel: 'windows-2025',
    runnerImageOS: 'win25',
    runnerImageVersion: '20261024.1.0',
    pinnedNodeVersion: '24.22.1',
    nodeVersion: 'v24.22.1',
    windowsPowerShellVersion: null,
    clrVersion: null,
    runtimeProbeSucceeded: false,
    nativeHelperPreparationSucceeded: false,
    preparationElapsedMs: 1,
    nativeHelperSha256: null,
    nativeHelperByteLength: 0,
    inspectorTimeoutMs: 15_000,
  })
  assert.equal(failedPreflightFingerprint.runtimeProbeSucceeded, false)
  assert.equal(failedPreflightFingerprint.nativeHelper.preparationSucceeded, false)

  const outputPath = path.join(directory, 'attempts.jsonl')
  writeFileSync(outputPath, '', { encoding: 'utf8' })
  const phases =
    'EVENFIRE_PLUGIN_ACL_PHASE=helper-load-start;ordinal=0;elapsedMs=9\r\n' +
    'EVENFIRE_PLUGIN_ACL_PHASE=helper-load-complete;ordinal=0;elapsedMs=47\r\n' +
    'EVENFIRE_PLUGIN_ACL_PHASE=inspect-complete;ordinal=1;elapsedMs=63\r\n' +
    'C:\\Users\\person\\private\\arbitrary output'
  const completedResult = {
    error: null,
    signal: null,
    status: 0,
    stdout: 'sensitive stdout',
    stderr: phases,
  }
  let receivedThis
  let receivedArguments
  const original = function (...args) {
    receivedThis = this
    receivedArguments = args
    return completedResult
  }
  const observed = createObservedSpawnSync(original, outputPath, 'consent')
  const receiver = { operation: 'sentinel' }
  const command = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const commandArguments = ['-Command', 'Invoke-Expression $scriptFromStdin']
  const options = {
    timeout: 15_000,
    input:
      "Write-Phase 'helper-load-start'; Add-Type -Path $assemblyPath; C:\\Users\\person\\private",
    secret: 'never serialize options',
  }
  assert.strictEqual(observed.call(receiver, command, commandArguments, options), completedResult)
  assert.strictEqual(receivedThis, receiver)
  assert.deepEqual(receivedArguments, [command, commandArguments, options])
  let diagnosticWriteFailure = false
  const failedObserver = createObservedSpawnSync(
    original,
    path.join(directory, 'missing', 'attempts.jsonl'),
    'consent',
    () => {
      diagnosticWriteFailure = true
    }
  )
  assert.throws(
    () => failedObserver(command, commandArguments, options),
    /Native helper diagnostic recording failed/
  )
  assert.equal(diagnosticWriteFailure, true)

  const timeoutAttempt = sanitizeNativeHelperAttempt(
    {
      error: { code: 'ETIMEDOUT', message: 'C:\\Users\\person\\private' },
      signal: 'SIGTERM',
      status: null,
      stderr:
        'EVENFIRE_PLUGIN_ACL_PHASE=helper-load-start;ordinal=0;elapsedMs=5\r\n' +
        'C:\\Users\\person\\private\\raw stderr',
    },
    15_004,
    15_000,
    'audit-rotation'
  )
  assert.equal(timeoutAttempt.outcome, 'process-timeout')
  assert.equal(timeoutAttempt.processErrorCode, 'ETIMEDOUT')
  assert.equal(timeoutAttempt.signal, 'SIGTERM')
  assert.equal(timeoutAttempt.lastPhase, 'helper-load-start')
  assert.equal(timeoutAttempt.helperLoadStartElapsedMs, 5)
  assert.equal(timeoutAttempt.helperLoadCompleteElapsedMs, null)
  assert.equal(timeoutAttempt.helperLoadElapsedMs, null)
  assert.equal(validateNativeHelperAttempt(timeoutAttempt, 'audit-rotation'), true)
  assert.equal(
    validateNativeHelperAttempt({ ...timeoutAttempt, timeoutMs: null }, 'audit-rotation'),
    false
  )
  assert.equal(
    validateNativeHelperAttempt(
      { ...timeoutAttempt, helperLoadCompleteElapsedMs: 4 },
      'audit-rotation'
    ),
    false
  )
  assert.equal(
    validateNativeHelperAttempt(
      { ...timeoutAttempt, privatePath: 'C:\\private' },
      'audit-rotation'
    ),
    false
  )
  assert.doesNotMatch(JSON.stringify(timeoutAttempt), /private|stderr|sensitive|secret/i)

  const records = readFileSync(outputPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(value => JSON.parse(value))
  assert.equal(records.length, 1)
  assert.deepEqual(records[0], {
    schemaVersion: 1,
    processId: 'consent',
    outcome: 'completed',
    invocationElapsedMs: records[0].invocationElapsedMs,
    timeoutMs: 15_000,
    processErrorCode: null,
    exitStatus: 0,
    signal: null,
    lastPhase: 'inspect-complete',
    nativeOrdinal: 1,
    helperLoadStartElapsedMs: 9,
    helperLoadCompleteElapsedMs: 47,
    helperLoadElapsedMs: 38,
  })
  assert.ok(Number.isSafeInteger(records[0].invocationElapsedMs))
  assert.doesNotMatch(JSON.stringify(records), /private|person|stdout|stderr|secret/i)

  const esmOutputPath = path.join(directory, 'esm-attempts.jsonl')
  writeFileSync(esmOutputPath, '', { encoding: 'utf8' })
  const observerPath = path.join(scriptRoot, 'windows-native-spawn-observer.cjs')
  const missingPowerShell = 'C:\\codex-scratch\\missing\\powershell.exe'
  const inspectorInput =
    "Write-Phase 'helper-load-start'; Add-Type -Path $assemblyPath; C:\\Users\\person\\private"
  const esmProbe = `
    import { spawnSync } from 'node:child_process'
    const result = spawnSync(${JSON.stringify(missingPowerShell)}, ['-Command', 'Invoke-Expression'], {
      encoding: 'utf8',
      input: ${JSON.stringify(inspectorInput)},
      timeout: 15000,
    })
    if (result.error?.code !== 'ENOENT') process.exitCode = 2
  `
  const esmResult = spawnSync(
    process.execPath,
    ['--require', observerPath, '--input-type=module', '--eval', esmProbe],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PR977_FOCUSED_PROCESS_ID: 'consent',
        PR977_NATIVE_LOAD_ATTEMPTS_PATH: esmOutputPath,
      },
      timeout: 5_000,
      windowsHide: true,
    }
  )
  assert.equal(esmResult.status, 0, 'ESM spawnSync observer integration must complete')
  const esmRecords = readFileSync(esmOutputPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(value => JSON.parse(value))
  assert.equal(esmRecords.length, 1)
  assert.equal(esmRecords[0].processErrorCode, 'ENOENT')
  assert.equal(esmRecords[0].lastPhase, null)
  assert.equal(validateNativeHelperAttempt(esmRecords[0], 'consent'), true)
  assert.doesNotMatch(JSON.stringify(esmRecords), /private|person|stdout|stderr|secret/i)
  process.stdout.write(
    'Windows native fingerprint schema, redaction, timing, and observer contracts passed\n'
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
