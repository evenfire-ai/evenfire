import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureFingerprint, readRuntimeVersions } from './capture-windows-native-fingerprint.mjs'
import { validateFocusedFingerprintPreflight } from './run-focused-windows-processes.mjs'
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
  assert.doesNotMatch(
    focusedRunner,
    /NODE_OPTIONS/,
    'Focused launcher must not encode the observer path in a Node environment string'
  )
  assert.doesNotMatch(focusedRunner, /shell:\s*true/)
  assert.match(focusedRunner, /buildObservedVitestNodeArgs/)
  assert.match(focusedRunner, /--execArgv=--require/)
  assert.match(focusedRunner, /`--execArgv=\$\{spawnObserver\}`/)
  const archivedRunPath = path.join(
    scriptRoot,
    'fixtures/run-41139571472-environment-fingerprint.json'
  )
  const archivedRun = JSON.parse(readFileSync(archivedRunPath, 'utf8'))
  assert.match(focusedWorkflow, /capture-windows-native-fingerprint\.mjs/)
  assert.match(focusedWorkflow, /test-windows-native-fingerprint\.mjs/)
  assert.match(focusedWorkflow, /environment-fingerprint\.json/)
  assert.match(focusedWorkflow, /native-helper-load-attempts\.jsonl/)
  assert.match(focusedWorkflow, /Required native source\/helper fingerprint checks failed/)
  assert.match(focusedRunner, /validateEnvironmentFingerprint/)
  assert.match(focusedRunner, /windows-native-spawn-observer\.cjs/)
  assert.match(focusedRunner, /validateNativeHelperAttempt/)
  assert.doesNotMatch(focusedRunner, /!fingerprint\.runtimeProbeSucceeded/)
  assert.match(focusedRunner, /validateFocusedFingerprintPreflight\(fingerprint/)
  assert.doesNotMatch(focusedWorkflow, /runtimeProbeSucceeded|runtimeProbeClassification/)
  assert.match(fingerprintCapture, /System32[\s\S]*reg\.exe/)
  assert.match(
    fingerprintCapture,
    /HKLM\\\\SOFTWARE\\\\Microsoft\\\\PowerShell\\\\3\\\\PowerShellEngine/
  )
  assert.doesNotMatch(fingerprintCapture, /spawnSync\(\s*powershell/)
  assert.equal(archivedRun.sourceSha, '585ab1466433c3bbb5120152baca17daafe7ef6f')
  assert.equal(archivedRun.harnessSha, '6fe9ccdc5c18129c2497f422ec06b99d432e1003')
  assert.equal(archivedRun.runtimeProbeSucceeded, false)
  assert.equal(archivedRun.windowsPowerShellVersion, null)
  assert.equal(archivedRun.clrVersion, null)
  assert.equal(archivedRun.nativeHelper.preparationSucceeded, true)
  assert.equal(
    archivedRun.nativeHelper.sha256,
    '24b21755682e7e1a4edd30e756af5ac59004cd336f2bb7a5347fe60e20f0e96b'
  )
  assert.equal(archivedRun.nativeHelper.byteLength, 13_312)
  assert.equal(!archivedRun.runtimeProbeSucceeded, true)

  const registryEnvironment = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' }
  const registryQuery = 'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine'
  const runProbe = (result, environment = registryEnvironment) =>
    readRuntimeVersions({
      environment,
      spawn: (command, args, options) => {
        assert.match(command, /System32[\\/]reg\.exe$/i)
        assert.deepEqual(args, ['query', registryQuery])
        assert.equal(options.timeout, 5_000)
        assert.equal(options.stdio[2], 'ignore')
        return result
      },
    })
  const successfulProbe = runProbe({
    status: 0,
    stdout:
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine\\r\n' +
      '    PowerShellVersion    REG_SZ    5.1.26100.7705\r\n' +
      '    CLRVersion            REG_SZ    4.0.30319.42000\r\n',
  })
  assert.equal(successfulProbe.classification, 'ok')
  assert.equal(successfulProbe.windowsPowerShellVersion, '5.1.26100.7705')
  assert.equal(successfulProbe.clrVersion, '4.0.30319.42000')
  assert.ok(successfulProbe.elapsedMs >= 0 && successfulProbe.elapsedMs <= 6_000)
  assert.equal(
    runProbe({ status: 1, stdout: 'arbitrary registry output' }).classification,
    'query-nonzero'
  )
  assert.equal(
    runProbe({ error: { code: 'ENOENT' }, status: null }).classification,
    'query-start-failed'
  )
  assert.equal(
    readRuntimeVersions({
      environment: registryEnvironment,
      spawn: () => {
        throw Object.assign(new Error('private error message'), { code: 'EACCES' })
      },
    }).classification,
    'query-start-failed'
  )
  assert.equal(
    runProbe({ error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, status: null }).classification,
    'unknown'
  )
  assert.equal(
    runProbe({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM' }).classification,
    'query-timeout'
  )
  assert.equal(
    readRuntimeVersions({ environment: {}, spawn: () => assert.fail('must not spawn') })
      .classification,
    'environment-unavailable'
  )
  const missingVersion = runProbe({
    status: 0,
    stdout: 'PowerShellVersion REG_SZ 5.1.26100.7705\n',
  })
  assert.equal(missingVersion.classification, 'value-missing')
  assert.equal(missingVersion.windowsPowerShellVersion, '5.1.26100.7705')
  assert.equal(missingVersion.clrVersion, null)
  const invalidVersion = runProbe({
    status: 0,
    stdout: 'PowerShellVersion REG_SZ 5.1\nCLRVersion REG_SZ arbitrary-data\n',
  })
  assert.equal(invalidVersion.classification, 'value-invalid')
  assert.equal(invalidVersion.windowsPowerShellVersion, '5.1')
  assert.equal(invalidVersion.clrVersion, null)
  assert.equal(runProbe({ status: null, signal: 'SIGKILL' }).classification, 'unknown')

  const sourceSha = '585ab1466433c3bbb5120152baca17daafe7ef6f'
  const harnessSha = 'd689fcaa27b9a365344b37c47fc7d683353ee24a'
  const captureDesktopRoot = path.join(directory, 'capture/source/desktop-app')
  const captureSourceRoot = path.resolve(captureDesktopRoot, '..')
  const captureValidationRoot = path.resolve(captureDesktopRoot, '../..', 'validation')
  const captureRunnerTemp = path.join(directory, 'capture-runner')
  const captureDllPath = path.join(
    captureDesktopRoot,
    'resources/WindowsSessionAuthorityNative.dll'
  )
  mkdirSync(path.dirname(captureDllPath), { recursive: true })
  mkdirSync(captureValidationRoot, { recursive: true })
  writeFileSync(path.join(captureSourceRoot, '.nvmrc'), '24.22.1\n')
  writeFileSync(captureDllPath, Buffer.from('prepared Windows helper fixture'))
  const captureEnvironment = {
    RUNNER_TEMP: captureRunnerTemp,
    PR977_NATIVE_PREPARATION_ELAPSED_MS: '33838',
    PR977_NATIVE_PREPARATION_SUCCEEDED: 'true',
    PR977_RUNNER_IMAGE_LABEL: 'windows-2025',
    PR977_SOURCE_SHA: sourceSha,
    GITHUB_SHA: harnessSha,
    ImageOS: 'win25-vs2026',
    ImageVersion: '20261021.278.1',
  }
  const readCaptureRevision = repositoryPath => {
    if (repositoryPath === captureSourceRoot) return sourceSha
    if (repositoryPath === captureValidationRoot) return harnessSha
    return null
  }
  const captureParameters = {
    environment: captureEnvironment,
    desktopRoot: captureDesktopRoot,
    runtimeProbe: () => ({
      classification: 'query-nonzero',
      elapsedMs: 20,
      windowsPowerShellVersion: null,
      clrVersion: null,
    }),
    readRevisionFor: readCaptureRevision,
    nodeVersion: 'v24.22.1',
  }
  const capturedOptionalFailure = captureFingerprint(captureParameters)
  const capturedArtifactPath = path.join(
    captureRunnerTemp,
    'pr977-focused/environment-fingerprint.json'
  )
  const capturedArtifact = JSON.parse(readFileSync(capturedArtifactPath, 'utf8'))
  assert.equal(capturedArtifact.runtimeProbeSucceeded, false)
  assert.equal(capturedArtifact.runtimeProbeClassification, 'query-nonzero')
  assert.equal(capturedArtifact.runtimeProbeElapsedMs, 20)
  assert.equal(capturedArtifact.nativeHelper.preparationSucceeded, true)
  assert.equal(
    capturedArtifact.nativeHelper.byteLength,
    Buffer.byteLength('prepared Windows helper fixture')
  )
  assert.equal(capturedArtifact.nativeHelper.sha256, capturedOptionalFailure.nativeHelper.sha256)
  assert.deepEqual(
    validateEnvironmentFingerprint(capturedArtifact, sourceSha, harnessSha),
    capturedArtifact
  )
  assert.equal(
    readFileSync(
      path.join(captureRunnerTemp, 'pr977-focused/native-helper-load-attempts.jsonl'),
      'utf8'
    ),
    ''
  )
  rmSync(captureDllPath)
  const missingDllFingerprint = captureFingerprint(captureParameters)
  assert.equal(missingDllFingerprint.nativeHelper.preparationSucceeded, false)
  assert.equal(missingDllFingerprint.nativeHelper.sha256, null)
  assert.equal(missingDllFingerprint.nativeHelper.byteLength, 0)

  const fingerprint = buildEnvironmentFingerprint({
    schemaVersion: 2,
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
    runtimeProbeClassification: 'ok',
    runtimeProbeElapsedMs: 14,
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
      'runtimeProbeClassification',
      'runtimeProbeElapsedMs',
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
  assert.throws(() => validateEnvironmentFingerprint(fingerprint, sourceSha, '0'.repeat(40)))
  assert.throws(() => validateEnvironmentFingerprint(null, sourceSha, harnessSha), /missing/)
  assert.throws(() => JSON.parse('{malformed'), SyntaxError)
  assert.throws(() =>
    buildEnvironmentFingerprint({ ...fingerprint, runnerImageOS: 'win25\nsecret' })
  )
  const failedPreflightFingerprint = buildEnvironmentFingerprint({
    schemaVersion: 2,
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
    runtimeProbeClassification: 'unknown',
    runtimeProbeElapsedMs: null,
    nativeHelperPreparationSucceeded: false,
    preparationElapsedMs: 1,
    nativeHelperSha256: null,
    nativeHelperByteLength: 0,
    inspectorTimeoutMs: 15_000,
  })
  assert.equal(failedPreflightFingerprint.runtimeProbeSucceeded, false)
  assert.equal(failedPreflightFingerprint.runtimeProbeClassification, 'unknown')
  assert.equal(failedPreflightFingerprint.nativeHelper.preparationSucceeded, false)
  assert.deepEqual(
    validateEnvironmentFingerprint(failedPreflightFingerprint, sourceSha, harnessSha),
    failedPreflightFingerprint
  )

  // The archived pre-fix artifact lacks classification and probe timing; do not edit that fixture.
  // Project only its recorded failure and helper identity into the new schema as unknown/unmeasured.
  const archivedEvidence = buildEnvironmentFingerprint({
    schemaVersion: 2,
    sourceSha: archivedRun.sourceSha,
    harnessSha: archivedRun.harnessSha,
    runnerImageLabel: archivedRun.runner.label,
    runnerImageOS: archivedRun.runner.imageOS,
    runnerImageVersion: archivedRun.runner.imageVersion,
    pinnedNodeVersion: archivedRun.node.pinnedVersion,
    nodeVersion: archivedRun.node.actualVersion,
    windowsPowerShellVersion: archivedRun.windowsPowerShellVersion,
    clrVersion: archivedRun.clrVersion,
    runtimeProbeSucceeded: archivedRun.runtimeProbeSucceeded,
    runtimeProbeClassification: 'unknown',
    runtimeProbeElapsedMs: null,
    nativeHelperPreparationSucceeded: archivedRun.nativeHelper.preparationSucceeded,
    preparationElapsedMs: archivedRun.nativeHelper.preparationElapsedMs,
    nativeHelperSha256: archivedRun.nativeHelper.sha256,
    nativeHelperByteLength: archivedRun.nativeHelper.byteLength,
    inspectorTimeoutMs: archivedRun.nativeHelper.inspectorTimeoutMs,
  })
  assert.equal(archivedRun.runtimeProbeSucceeded, false, 'archived evidence remains unchanged')
  assert.equal(archivedEvidence.runtimeProbeSucceeded, false)
  assert.equal(archivedEvidence.runtimeProbeClassification, 'unknown')
  assert.equal(archivedEvidence.runtimeProbeElapsedMs, null)
  assert.equal(archivedEvidence.nativeHelper.sha256, archivedRun.nativeHelper.sha256)
  assert.equal(
    validateEnvironmentFingerprint(archivedEvidence, archivedRun.sourceSha, archivedRun.harnessSha)
      .runtimeProbeClassification,
    'unknown'
  )
  const helperAttemptsPath = path.join(directory, 'preflight-attempts.jsonl')
  writeFileSync(helperAttemptsPath, '', { encoding: 'utf8' })
  assert.equal(validateFocusedFingerprintPreflight(archivedEvidence, helperAttemptsPath), true)
  assert.throws(
    () => validateFocusedFingerprintPreflight(failedPreflightFingerprint, helperAttemptsPath),
    /incomplete native environment diagnostics/
  )
  assert.throws(
    () =>
      validateEnvironmentFingerprint(
        { ...archivedEvidence, unexpected: true },
        archivedRun.sourceSha,
        archivedRun.harnessSha
      ),
    /does not match expected revisions/
  )
  assert.throws(
    () =>
      validateEnvironmentFingerprint(
        { ...archivedEvidence, runtimeProbeClassification: 'success' },
        archivedRun.sourceSha,
        archivedRun.harnessSha
      ),
    /incomplete or invalid/
  )
  assert.throws(
    () =>
      validateEnvironmentFingerprint(
        { ...archivedEvidence, runtimeProbeSucceeded: true },
        archivedRun.sourceSha,
        archivedRun.harnessSha
      ),
    /incomplete or invalid/
  )
  assert.throws(
    () =>
      validateEnvironmentFingerprint(
        { ...archivedEvidence, runtimeProbeElapsedMs: 6_001 },
        archivedRun.sourceSha,
        archivedRun.harnessSha
      ),
    /incomplete or invalid/
  )
  assert.throws(
    () =>
      validateEnvironmentFingerprint(
        { ...archivedEvidence, nativeHelper: { ...archivedEvidence.nativeHelper, sha256: null } },
        archivedRun.sourceSha,
        archivedRun.harnessSha
      ),
    /incomplete or invalid/
  )

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
  const launcherIntegration = spawnSync(
    process.execPath,
    [path.join(scriptRoot, 'test-focused-windows-launcher.mjs')],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, CODEX_SCRATCH_ROOT: scratchRoot },
      shell: false,
      timeout: 90_000,
      windowsHide: true,
    }
  )
  assert.equal(
    launcherIntegration.status,
    0,
    'Focused launcher preload and watchdog integration contracts must pass'
  )
  process.stdout.write(
    'Windows native fingerprint, observer preload, and watchdog contracts passed\n'
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
