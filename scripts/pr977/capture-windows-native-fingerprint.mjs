import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import diagnostics from './windows-native-spawn-observer.cjs'

const { buildEnvironmentFingerprint } = diagnostics
const desktopRoot = process.cwd()
const sourceRoot = path.resolve(desktopRoot, '..')
const validationRoot = path.resolve(desktopRoot, '../..', 'validation')
const artifactRoot = process.env.RUNNER_TEMP
  ? path.join(process.env.RUNNER_TEMP, 'pr977-focused')
  : null
if (!artifactRoot || !path.isAbsolute(artifactRoot))
  throw new Error('Windows native fingerprint artifact root is unavailable')

function getEnvironmentValue(name) {
  const key = Object.keys(process.env).find(value => value.toLowerCase() === name.toLowerCase())
  return key ? process.env[key] : undefined
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

function readRuntimeVersions() {
  const systemRoot = getEnvironmentValue('SystemRoot')
  if (!systemRoot) return { succeeded: false, windowsPowerShellVersion: null, clrVersion: null }
  const registry = path.win32.join(systemRoot, 'System32', 'reg.exe')
  const minimalEnvironment = {
    SystemRoot: systemRoot,
    WINDIR: getEnvironmentValue('WINDIR') ?? systemRoot,
    PATH: getEnvironmentValue('PATH') ?? '',
  }
  const result = spawnSync(
    registry,
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine'],
    {
      encoding: 'utf8',
      env: minimalEnvironment,
      maxBuffer: 2_048,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    }
  )
  if (result.error || result.status !== 0)
    return { succeeded: false, windowsPowerShellVersion: null, clrVersion: null }
  const values = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(PowerShellVersion|CLRVersion)\s+REG_SZ\s+(\d{1,5}(?:\.\d{1,5}){1,3})\s*$/i
    )
    if (match) values.set(match[1].toLowerCase(), match[2])
  }
  const windowsPowerShellVersion = values.get('powershellversion')
  const clrVersion = values.get('clrversion')
  if (!windowsPowerShellVersion || !clrVersion)
    return { succeeded: false, windowsPowerShellVersion: null, clrVersion: null }
  return {
    succeeded: true,
    windowsPowerShellVersion,
    clrVersion,
  }
}

const preparationElapsedMs = Number(process.env.PR977_NATIVE_PREPARATION_ELAPSED_MS)
let preparationSucceeded = process.env.PR977_NATIVE_PREPARATION_SUCCEEDED
const pinnedNodeVersion = readFileSync(path.join(sourceRoot, '.nvmrc'), 'utf8').trim()
const runnerImageLabel = process.env.PR977_RUNNER_IMAGE_LABEL
const runnerImageOS = getEnvironmentValue('ImageOS')
const runnerImageVersion = getEnvironmentValue('ImageVersion')
const sourceSha = readRevision(sourceRoot)
const harnessSha = readRevision(validationRoot)
const runtime = readRuntimeVersions()
const dllPath = path.join(desktopRoot, 'resources', 'WindowsSessionAuthorityNative.dll')
let nativeHelperSha256 = null
let nativeHelperByteLength = 0
if (preparationSucceeded === 'true') {
  try {
    const stat = statSync(dllPath)
    if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024)
      throw new Error('Invalid native helper file')
    const dll = readFileSync(dllPath)
    if (dll.byteLength !== stat.size) throw new Error('Native helper changed while fingerprinting')
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
if (sourceSha !== process.env.PR977_SOURCE_SHA || harnessSha !== process.env.GITHUB_SHA)
  throw new Error('Windows native fingerprint revision mismatch')
if (!Number.isSafeInteger(preparationElapsedMs) || preparationElapsedMs < 0)
  throw new Error('Windows native preparation duration is invalid')
if (!['true', 'false'].includes(preparationSucceeded))
  throw new Error('Windows native preparation result is invalid')

const fingerprint = buildEnvironmentFingerprint({
  schemaVersion: 1,
  sourceSha,
  harnessSha,
  runnerImageLabel,
  runnerImageOS,
  runnerImageVersion,
  pinnedNodeVersion,
  nodeVersion: process.version,
  windowsPowerShellVersion: runtime.windowsPowerShellVersion,
  clrVersion: runtime.clrVersion,
  runtimeProbeSucceeded: runtime.succeeded,
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

if (!runtime.succeeded || preparationSucceeded !== 'true') {
  process.stderr.write('Windows native environment fingerprint did not pass required preflight\n')
  process.exitCode = 1
}
