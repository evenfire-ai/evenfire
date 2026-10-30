'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { syncBuiltinESMExports } = require('node:module')

const MAX_ELAPSED_MS = 60_000
const MAX_ATTEMPTS_BYTES = 256 * 1024
const ALLOWED_PROCESS_IDS = new Set(['consent', 'audit-rotation'])
const ALLOWED_PHASES = new Set([
  'child-start',
  'helper-load-start',
  'helper-load-complete',
  'request-prepare-start',
  'request-prepare-complete',
  'current-user-ready',
  'inspect-start',
  'inspect-complete',
  'response-serialize-start',
  'response-serialize-complete',
])
const ALLOWED_PROCESS_ERRORS = new Set([
  'EACCES',
  'E2BIG',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOMEM',
  'ENOBUFS',
  'EPERM',
  'ETIMEDOUT',
])
const ALLOWED_SIGNALS = new Set(['SIGABRT', 'SIGBREAK', 'SIGINT', 'SIGKILL', 'SIGTERM'])
const VERSION = /^\d{1,5}(?:\.\d{1,5}){1,3}$/
const SHA256 = /^[a-f0-9]{64}$/
const SHA1 = /^[a-f0-9]{40}$/

function clampElapsed(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_ELAPSED_MS, Math.round(value))) : 0
}

function phaseMarkers(stderr) {
  const content = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
  const markers = []
  const pattern =
    /^EVENFIRE_PLUGIN_ACL_PHASE=([a-z-]{1,40});ordinal=(\d{1,2});elapsedMs=(\d{1,5})\r?$/gm
  for (const match of content.matchAll(pattern)) {
    const ordinal = Number(match[2])
    const elapsedMs = Number(match[3])
    if (
      ALLOWED_PHASES.has(match[1]) &&
      Number.isSafeInteger(ordinal) &&
      ordinal >= 0 &&
      ordinal <= 64 &&
      Number.isSafeInteger(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs <= MAX_ELAPSED_MS
    ) {
      markers.push({ phase: match[1], ordinal, elapsedMs })
    }
  }
  return markers
}

function sanitizeNativeHelperAttempt(result, invocationElapsedMs, timeoutMs, processId) {
  if (!ALLOWED_PROCESS_IDS.has(processId)) throw new Error('Invalid focused process identifier')
  const markers = phaseMarkers(result?.stderr)
  const start = markers.find(marker => marker.phase === 'helper-load-start')
  const complete = markers.find(marker => marker.phase === 'helper-load-complete')
  const rawErrorCode = result?.error?.code
  const rawSignal = result?.signal
  const status = result?.status
  const validStatus = Number.isSafeInteger(status) && status >= -1 && status <= 255
  const elapsedMs = clampElapsed(invocationElapsedMs)
  const validTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60_000
  const outcome =
    rawErrorCode === 'ETIMEDOUT'
      ? 'process-timeout'
      : rawErrorCode
        ? 'process-error'
        : rawSignal
          ? 'process-terminated'
          : status === 0
            ? 'completed'
            : 'process-exit-failed'

  return {
    schemaVersion: 1,
    processId,
    outcome,
    invocationElapsedMs: elapsedMs,
    timeoutMs: validTimeout ? timeoutMs : null,
    processErrorCode: ALLOWED_PROCESS_ERRORS.has(rawErrorCode)
      ? rawErrorCode
      : rawErrorCode
        ? 'OTHER'
        : null,
    exitStatus: status === null ? null : validStatus ? status : null,
    signal: ALLOWED_SIGNALS.has(rawSignal) ? rawSignal : rawSignal ? 'OTHER' : null,
    lastPhase: markers.at(-1)?.phase ?? null,
    nativeOrdinal: markers.at(-1)?.ordinal ?? null,
    helperLoadStartElapsedMs: start?.elapsedMs ?? null,
    helperLoadCompleteElapsedMs: complete?.elapsedMs ?? null,
    helperLoadElapsedMs:
      start && complete && complete.elapsedMs >= start.elapsedMs
        ? complete.elapsedMs - start.elapsedMs
        : null,
  }
}

function validateNativeHelperAttempt(value, expectedProcessId) {
  const expectedKeys = [
    'schemaVersion',
    'processId',
    'outcome',
    'invocationElapsedMs',
    'timeoutMs',
    'processErrorCode',
    'exitStatus',
    'signal',
    'lastPhase',
    'nativeOrdinal',
    'helperLoadStartElapsedMs',
    'helperLoadCompleteElapsedMs',
    'helperLoadElapsedMs',
  ]
  const nullableBoundedInteger = (item, min = 0, max = MAX_ELAPSED_MS) =>
    item === null || (Number.isSafeInteger(item) && item >= min && item <= max)
  const exactKeys =
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expectedKeys.sort().join(',')
  if (
    !exactKeys ||
    value.schemaVersion !== 1 ||
    value.processId !== expectedProcessId ||
    !ALLOWED_PROCESS_IDS.has(value.processId) ||
    ![
      'completed',
      'process-timeout',
      'process-error',
      'process-terminated',
      'process-exit-failed',
    ].includes(value.outcome) ||
    !nullableBoundedInteger(value.invocationElapsedMs) ||
    value.timeoutMs !== 15_000 ||
    !(
      value.processErrorCode === null ||
      ALLOWED_PROCESS_ERRORS.has(value.processErrorCode) ||
      value.processErrorCode === 'OTHER'
    ) ||
    !nullableBoundedInteger(value.exitStatus, -1, 255) ||
    !(value.signal === null || ALLOWED_SIGNALS.has(value.signal) || value.signal === 'OTHER') ||
    !(value.lastPhase === null || ALLOWED_PHASES.has(value.lastPhase)) ||
    !nullableBoundedInteger(value.nativeOrdinal, 0, 64) ||
    !nullableBoundedInteger(value.helperLoadStartElapsedMs) ||
    !nullableBoundedInteger(value.helperLoadCompleteElapsedMs) ||
    !nullableBoundedInteger(value.helperLoadElapsedMs)
  ) {
    return false
  }
  if ((value.lastPhase === null) !== (value.nativeOrdinal === null)) return false
  if (
    value.helperLoadCompleteElapsedMs !== null &&
    (value.helperLoadStartElapsedMs === null ||
      value.helperLoadCompleteElapsedMs < value.helperLoadStartElapsedMs)
  ) {
    return false
  }
  if (
    (value.outcome === 'completed' &&
      (value.exitStatus !== 0 || value.processErrorCode !== null || value.signal !== null)) ||
    (value.outcome === 'process-timeout' &&
      (value.processErrorCode !== 'ETIMEDOUT' || value.exitStatus !== null)) ||
    (value.outcome === 'process-error' &&
      (value.processErrorCode === null || value.processErrorCode === 'ETIMEDOUT')) ||
    (value.outcome === 'process-terminated' &&
      (value.signal === null || value.processErrorCode !== null)) ||
    (value.outcome === 'process-exit-failed' &&
      (value.exitStatus === 0 || value.processErrorCode !== null || value.signal !== null))
  ) {
    return false
  }
  if (value.helperLoadElapsedMs !== null) {
    return (
      value.helperLoadStartElapsedMs !== null &&
      value.helperLoadCompleteElapsedMs !== null &&
      value.helperLoadCompleteElapsedMs - value.helperLoadStartElapsedMs ===
        value.helperLoadElapsedMs
    )
  }
  if (
    value.outcome === 'completed' &&
    (value.helperLoadStartElapsedMs === null || value.helperLoadCompleteElapsedMs === null)
  ) {
    return false
  }
  return true
}

function createObservedSpawnSync(original, outputPath, processId, onWriteFailure = () => {}) {
  if (typeof original !== 'function' || !path.isAbsolute(outputPath))
    throw new Error('Invalid native observer configuration')
  if (!ALLOWED_PROCESS_IDS.has(processId)) throw new Error('Invalid focused process identifier')

  return function observedSpawnSync(command, args, options) {
    const isPowerShell = path.win32.basename(String(command)).toLowerCase() === 'powershell.exe'
    const argumentScript = Array.isArray(args)
      ? args.filter(value => typeof value === 'string').join('\n')
      : ''
    const script = `${argumentScript}\n${typeof options?.input === 'string' ? options.input : ''}`
    const isNativeInspector =
      isPowerShell &&
      script.includes("Write-Phase 'helper-load-start'") &&
      script.includes('Add-Type -Path $assemblyPath')
    if (!isNativeInspector) return original.call(this, command, args, options)

    const startedAt = process.hrtime.bigint()
    let result
    try {
      result = original.call(this, command, args, options)
    } catch (error) {
      const elapsedMs = clampElapsed(Number(process.hrtime.bigint() - startedAt) / 1e6)
      const record = sanitizeNativeHelperAttempt(
        { error: { code: error?.code }, status: null, signal: null, stderr: '' },
        elapsedMs,
        options?.timeout,
        processId
      )
      appendRecord(record)
      throw error
    }

    const elapsedMs = clampElapsed(Number(process.hrtime.bigint() - startedAt) / 1e6)
    const record = sanitizeNativeHelperAttempt(result, elapsedMs, options?.timeout, processId)
    appendRecord(record)
    return result

    function appendRecord(record) {
      try {
        if (fs.statSync(outputPath).size >= MAX_ATTEMPTS_BYTES)
          throw new Error('Native helper diagnostic limit reached')
        fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
      } catch {
        onWriteFailure()
        throw new Error('Native helper diagnostic recording failed')
      }
    }
  }
}

function buildEnvironmentFingerprint(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid fingerprint input')
  const validText = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value)
  const validVersion = value => typeof value === 'string' && VERSION.test(value)
  const validNodeVersion = value =>
    typeof value === 'string' && value.startsWith('v') && VERSION.test(value.slice(1))
  const prepared = input.nativeHelperPreparationSucceeded
  const sha = input.nativeHelperSha256
  const byteLength = input.nativeHelperByteLength
  if (
    input.schemaVersion !== 1 ||
    !SHA1.test(input.sourceSha ?? '') ||
    !SHA1.test(input.harnessSha ?? '') ||
    !validText(input.runnerImageLabel) ||
    !validText(input.runnerImageOS) ||
    !validText(input.runnerImageVersion) ||
    !validVersion(input.pinnedNodeVersion) ||
    !validNodeVersion(input.nodeVersion) ||
    input.nodeVersion !== `v${input.pinnedNodeVersion}` ||
    typeof input.runtimeProbeSucceeded !== 'boolean' ||
    (input.runtimeProbeSucceeded &&
      (!validVersion(input.windowsPowerShellVersion) || !validVersion(input.clrVersion))) ||
    (!input.runtimeProbeSucceeded &&
      (input.windowsPowerShellVersion !== null || input.clrVersion !== null)) ||
    typeof prepared !== 'boolean' ||
    !Number.isSafeInteger(input.preparationElapsedMs) ||
    input.preparationElapsedMs < 0 ||
    input.preparationElapsedMs > 600_000 ||
    !Number.isSafeInteger(input.inspectorTimeoutMs) ||
    input.inspectorTimeoutMs !== 15_000 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > 20 * 1024 * 1024 ||
    (prepared && (!SHA256.test(sha ?? '') || byteLength === 0)) ||
    (!prepared && (sha !== null || byteLength !== 0))
  ) {
    throw new Error('Windows native environment fingerprint is incomplete or invalid')
  }

  return {
    schemaVersion: 1,
    sourceSha: input.sourceSha,
    harnessSha: input.harnessSha,
    runner: {
      label: input.runnerImageLabel,
      imageOS: input.runnerImageOS,
      imageVersion: input.runnerImageVersion,
    },
    node: {
      pinnedVersion: input.pinnedNodeVersion,
      actualVersion: input.nodeVersion,
    },
    windowsPowerShellVersion: input.windowsPowerShellVersion,
    clrVersion: input.clrVersion,
    runtimeProbeSucceeded: input.runtimeProbeSucceeded,
    nativeHelper: {
      preparationSucceeded: prepared,
      preparationElapsedMs: input.preparationElapsedMs,
      sha256: prepared ? sha : null,
      byteLength: prepared ? byteLength : 0,
      inspectorTimeoutMs: 15_000,
      loadAttemptsFile: 'native-helper-load-attempts.jsonl',
    },
  }
}

function validateEnvironmentFingerprint(value, expectedSourceSha, expectedHarnessSha) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Windows native environment fingerprint is missing')
  const nativeHelper = value.nativeHelper
  const runner = value.runner
  const node = value.node
  const normalized = buildEnvironmentFingerprint({
    schemaVersion: value.schemaVersion,
    sourceSha: value.sourceSha,
    harnessSha: value.harnessSha,
    runnerImageLabel: runner?.label,
    runnerImageOS: runner?.imageOS,
    runnerImageVersion: runner?.imageVersion,
    pinnedNodeVersion: node?.pinnedVersion,
    nodeVersion: node?.actualVersion,
    windowsPowerShellVersion: value.windowsPowerShellVersion,
    clrVersion: value.clrVersion,
    runtimeProbeSucceeded: value.runtimeProbeSucceeded,
    nativeHelperPreparationSucceeded: nativeHelper?.preparationSucceeded,
    preparationElapsedMs: nativeHelper?.preparationElapsedMs,
    nativeHelperSha256: nativeHelper?.sha256,
    nativeHelperByteLength: nativeHelper?.byteLength,
    inspectorTimeoutMs: nativeHelper?.inspectorTimeoutMs,
  })
  if (
    value.sourceSha !== expectedSourceSha ||
    value.harnessSha !== expectedHarnessSha ||
    JSON.stringify(value) !== JSON.stringify(normalized)
  ) {
    throw new Error('Windows native environment fingerprint does not match expected revisions')
  }
  return normalized
}

function installFromEnvironment() {
  const outputPath = process.env.PR977_NATIVE_LOAD_ATTEMPTS_PATH
  const processId = process.env.PR977_FOCUSED_PROCESS_ID
  if (!outputPath && !processId) return
  if (!outputPath || !path.isAbsolute(outputPath) || !ALLOWED_PROCESS_IDS.has(processId)) {
    process.exitCode = 1
    return
  }
  childProcess.spawnSync = createObservedSpawnSync(
    childProcess.spawnSync,
    outputPath,
    processId,
    () => {
      process.exitCode = 1
    }
  )
  syncBuiltinESMExports()
}

installFromEnvironment()

module.exports = {
  buildEnvironmentFingerprint,
  createObservedSpawnSync,
  phaseMarkers,
  sanitizeNativeHelperAttempt,
  validateNativeHelperAttempt,
  validateEnvironmentFingerprint,
}
