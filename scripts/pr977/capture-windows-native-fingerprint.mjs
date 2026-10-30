import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import diagnostics from './windows-native-spawn-observer.cjs'

const { buildEnvironmentFingerprint } = diagnostics
const PROBE_TIMEOUT_MS = 5_000
const PROBE_MAX_ELAPSED_MS = 6_000
const PROCESS_START_ERRORS = new Set([
  'EACCES',
  'E2BIG',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOMEM',
  'ENOTDIR',
  'EPERM',
])

function classifyProcessError(error) {
  if (error?.code === 'ETIMEDOUT') return 'query-timeout'
  if (PROCESS_START_ERRORS.has(error?.code)) return 'query-start-failed'
  return 'unknown'
}

function getEnvironmentValue(name, environment) {
  const key = Object.keys(environment).find(value => value.toLowerCase() === name.toLowerCase())
  return key ? environment[key] : undefined
}

function readRevision(repositoryPath) {
  const result = spawnSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  })
  const value = result.status === 0 ? result.stdout.trim() : ''
  return /^[a-f0-9]{40}$/.test(value) ? value : null
}

export function readRuntimeVersions({ environment = process.env, spawn = spawnSync } = {}) {
  const startedAt = process.hrtime.bigint()
  const finish = (classification, windowsPowerShellVersion = null, clrVersion = null) => ({
    classification,
    elapsedMs: Math.min(
      PROBE_MAX_ELAPSED_MS,
      Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6))
    ),
    windowsPowerShellVersion,
    clrVersion,
  })
  const systemRoot = getEnvironmentValue('SystemRoot', environment)
  if (!systemRoot) return finish('environment-unavailable')
  const registry = path.win32.join(systemRoot, 'System32', 'reg.exe')
  const minimalEnvironment = {
    SystemRoot: systemRoot,
    WINDIR: getEnvironmentValue('WINDIR', environment) ?? systemRoot,
    PATH: getEnvironmentValue('PATH', environment) ?? '',
  }
  let result
  try {
    result = spawn(
      registry,
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine'],
      {
        encoding: 'utf8',
        env: minimalEnvironment,
        maxBuffer: 2_048,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      }
    )
  } catch (error) {
    return finish(classifyProcessError(error))
  }
  if (result?.error) {
    return finish(classifyProcessError(result.error))
  }
  if (result?.status !== 0) {
    if (result?.status !== null && result?.status !== undefined) return finish('query-nonzero')
    if (result?.signal === 'SIGTERM') return finish('query-timeout')
    return finish('unknown')
  }
  if (typeof result.stdout !== 'string') return finish('unknown')

  const values = new Map()
  let invalidValue = false
  for (const line of result.stdout.split(/\r?\n/)) {
    const entry = line.match(/^\s*(PowerShellVersion|CLRVersion)\s+(\S+)\s+(\S+)\s*$/i)
    if (!entry) continue
    const key = entry[1].toLowerCase()
    if (entry[2].toUpperCase() !== 'REG_SZ' || !/^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(entry[3])) {
      invalidValue = true
      continue
    }
    values.set(key, entry[3])
  }
  const windowsPowerShellVersion = values.get('powershellversion') ?? null
  const clrVersion = values.get('clrversion') ?? null
  if (invalidValue) return finish('value-invalid', windowsPowerShellVersion, clrVersion)
  if (!windowsPowerShellVersion || !clrVersion)
    return finish('value-missing', windowsPowerShellVersion, clrVersion)
  return finish('ok', windowsPowerShellVersion, clrVersion)
}

export function captureFingerprint({
  environment = process.env,
  desktopRoot = process.cwd(),
  runtimeProbe = () => readRuntimeVersions({ environment }),
  readRevisionFor = readRevision,
  nodeVersion = process.version,
} = {}) {
  const sourceRoot = path.resolve(desktopRoot, '..')
  const validationRoot = path.resolve(desktopRoot, '../..', 'validation')
  const runnerTemp = getEnvironmentValue('RUNNER_TEMP', environment)
  const artifactRoot = runnerTemp ? path.join(runnerTemp, 'pr977-focused') : null
  if (!artifactRoot || !path.isAbsolute(artifactRoot))
    throw new Error('Windows native fingerprint artifact root is unavailable')

  const preparationElapsedMs = Number(
    getEnvironmentValue('PR977_NATIVE_PREPARATION_ELAPSED_MS', environment)
  )
  let preparationSucceeded = getEnvironmentValue('PR977_NATIVE_PREPARATION_SUCCEEDED', environment)
  const pinnedNodeVersion = readFileSync(path.join(sourceRoot, '.nvmrc'), 'utf8').trim()
  const runnerImageLabel = getEnvironmentValue('PR977_RUNNER_IMAGE_LABEL', environment)
  const runnerImageOS = getEnvironmentValue('ImageOS', environment)
  const runnerImageVersion = getEnvironmentValue('ImageVersion', environment)
  const sourceSha = readRevisionFor(sourceRoot)
  const harnessSha = readRevisionFor(validationRoot)
  const runtime = runtimeProbe()
  const dllPath = path.join(desktopRoot, 'resources', 'WindowsSessionAuthorityNative.dll')
  let nativeHelperSha256 = null
  let nativeHelperByteLength = 0
  if (preparationSucceeded === 'true') {
    try {
      const stat = statSync(dllPath)
      if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024)
        throw new Error('Invalid native helper file')
      const dll = readFileSync(dllPath)
      if (dll.byteLength !== stat.size)
        throw new Error('Native helper changed while fingerprinting')
      nativeHelperSha256 = createHash('sha256').update(dll).digest('hex')
      nativeHelperByteLength = dll.byteLength
    } catch {
      preparationSucceeded = 'false'
      nativeHelperSha256 = null
      nativeHelperByteLength = 0
    }
  }

  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^[a-f0-9]{40}$/.test(harnessSha ?? ''))
    throw new Error('Windows native fingerprint revision check failed')
  if (
    sourceSha !== getEnvironmentValue('PR977_SOURCE_SHA', environment) ||
    harnessSha !== getEnvironmentValue('GITHUB_SHA', environment)
  )
    throw new Error('Windows native fingerprint revision mismatch')
  if (!Number.isSafeInteger(preparationElapsedMs) || preparationElapsedMs < 0)
    throw new Error('Windows native preparation duration is invalid')
  if (!['true', 'false'].includes(preparationSucceeded))
    throw new Error('Windows native preparation result is invalid')

  const fingerprint = buildEnvironmentFingerprint({
    schemaVersion: 2,
    sourceSha,
    harnessSha,
    runnerImageLabel,
    runnerImageOS,
    runnerImageVersion,
    pinnedNodeVersion,
    nodeVersion,
    windowsPowerShellVersion: runtime.windowsPowerShellVersion,
    clrVersion: runtime.clrVersion,
    runtimeProbeSucceeded: runtime.classification === 'ok',
    runtimeProbeClassification: runtime.classification,
    runtimeProbeElapsedMs: runtime.elapsedMs,
    nativeHelperPreparationSucceeded: preparationSucceeded === 'true',
    preparationElapsedMs,
    nativeHelperSha256,
    nativeHelperByteLength,
    inspectorTimeoutMs: 15_000,
  })

  mkdirSync(artifactRoot, { recursive: true })
  writeFileSync(
    path.join(artifactRoot, 'environment-fingerprint.json'),
    `${JSON.stringify(fingerprint, null, 2)}\n`,
    { encoding: 'utf8' }
  )
  writeFileSync(path.join(artifactRoot, 'native-helper-load-attempts.jsonl'), '', {
    encoding: 'utf8',
  })

  return fingerprint
}

function main() {
  const fingerprint = captureFingerprint()
  if (!fingerprint.nativeHelper.preparationSucceeded) {
    process.stderr.write('Windows native helper preparation failed fingerprint integrity checks\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch {
    process.stderr.write('Windows native fingerprint capture failed integrity checks\n')
    process.exitCode = 1
  }
}
