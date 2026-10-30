import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { type BigIntStats, promises as fs } from 'node:fs'
import path from 'node:path'
import {
  WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV,
  windowsSessionAuthorityNativeAssemblyPath,
} from './windowsSessionAuthorityNativeAssembly.js'
import { createWindowsSessionAuthorityPowerShellEnvironment } from './windowsSessionAuthorityPowerShellEnvironment.js'

const REQUEST_ENV = 'EVENFIRE_PLUGIN_STORAGE_ACL_REQUEST'
const LAUNCHER = '$sourceText = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($sourceText))'
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$phase = 'load-native-helper'
try {
  $assemblyPath = [Environment]::GetEnvironmentVariable('EVENFIRE_SESSION_AUTHORITY_NATIVE_ASSEMBLY')
  if (-not $assemblyPath) { throw 'native-helper-path-missing' }
  Add-Type -Path $assemblyPath -ErrorAction Stop
  $payload = [Environment]::GetEnvironmentVariable('EVENFIRE_PLUGIN_STORAGE_ACL_REQUEST')
  if (-not $payload) { throw 'request-missing' }
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  $creatorOwnerSid = 'S-1-3-0'
  $readMask = [uint32]0x00120089
  $writeMask = [uint32]0x00120116
  $relevantMask = [uint32]0x001F01FF
  $results = @()
  foreach ($item in $request.items) {
    $phase = 'inspect-object'
    $snapshot = [SessionAuthorityNative]::Inspect([string]$item.path)
    $expected = [IO.Path]::GetFullPath([string]$item.path).TrimEnd('\')
    $actual = [IO.Path]::GetFullPath([string]$snapshot.FinalPath).TrimEnd('\')
    if ([string]::Compare($expected, $actual, $true) -ne 0 -or
      $snapshot.IsReparsePoint -or $snapshot.IsDirectory -ne [bool]$item.directory -or
      -not $snapshot.DaclPresent -or $snapshot.Aces.Count -eq 0 -or
      $allowed -notcontains $snapshot.OwnerSid) {
      throw 'object-identity-or-owner-invalid'
    }
    $hasInheritedUser = $false
    foreach ($ace in $snapshot.Aces) {
      if ($ace.Qualifier -ne 'AccessAllowed' -and $ace.Qualifier -ne 'AccessDenied') {
        throw 'unsupported-ace'
      }
      if ($ace.Qualifier -ne 'AccessAllowed') { continue }
      if ($ace.Sid -eq $currentSid -and $ace.Inherited -and -not $ace.InheritOnly) {
        $hasInheritedUser = $true
      }
      if ($ace.Sid -eq $creatorOwnerSid -and [bool]$item.directory -and $ace.InheritOnly) {
        continue
      }
      if (($ace.Mask -band $relevantMask) -ne 0 -and $allowed -notcontains $ace.Sid) {
        throw 'unauthorized-principal-access'
      }
    }
    if ([bool]$item.requireInherited -and -not $hasInheritedUser) {
      throw 'user-access-not-inherited'
    }
    $effectiveRead = ($snapshot.EffectiveAccess -band $readMask) -eq $readMask
    $effectiveWrite = ($snapshot.EffectiveAccess -band $writeMask) -eq $writeMask
    if (-not $effectiveRead -or -not $effectiveWrite) { throw 'current-user-access-insufficient' }
    $results += [ordered]@{
      ok = $true
      identity = $snapshot.Identity
      directory = [bool]$snapshot.IsDirectory
      effectiveRead = [bool]$effectiveRead
      effectiveWrite = [bool]$effectiveWrite
      inheritedUserAccess = [bool]$hasInheritedUser
      allowedPrincipalsOnly = $true
    }
  }
  [ordered]@{ ok = $true; items = $results } | ConvertTo-Json -Compress -Depth 5
  exit 0
} catch {
  $operation = $_.Exception.Data['sessionAuthorityOperation']
  $safeOperation = if ($operation -is [string] -and $operation -match '^[a-z-]{1,40}$') { $operation } else { $null }
  $win32 = if ($_.Exception -is [ComponentModel.Win32Exception]) { $_.Exception.NativeErrorCode } else { $null }
  [ordered]@{
    ok = $false
    phase = if ($phase -match '^[a-z-]{1,40}$') { $phase } else { 'verification' }
    errorType = $_.Exception.GetType().Name
    hresult = ('0x{0:X8}' -f $_.Exception.HResult)
    nativeOperation = $safeOperation
    win32Error = $win32
    reason = if ($_.Exception.Message -match '^[a-z-]{1,60}$') { $_.Exception.Message } else { 'inspection-failed' }
  } | ConvertTo-Json -Compress
  exit 2
}
`

type PathCheck = { path: string; directory: boolean; requireInherited: boolean }
export type WindowsPluginStorageEvidence = {
  identity: string
  directory: boolean
  effectiveRead: true
  effectiveWrite: true
  inheritedUserAccess: boolean
  allowedPrincipalsOnly: true
}

export type PluginStorageNativeDiagnostic = {
  failure:
    | 'process-timeout'
    | 'process-start-failed'
    | 'process-error'
    | 'process-terminated'
    | 'process-exit-failed'
    | 'response-missing'
    | 'response-malformed'
    | 'verifier-rejected'
    | 'evidence-invalid'
  elapsedMs: number
  processErrorCode?:
    | 'EACCES'
    | 'EINVAL'
    | 'EIO'
    | 'EMFILE'
    | 'ENFILE'
    | 'ENOBUFS'
    | 'ENOENT'
    | 'ENOMEM'
    | 'ENOTDIR'
    | 'EPERM'
    | 'EPIPE'
    | 'ETIMEDOUT'
  exitStatus?: number | null
  signal?: 'SIGABRT' | 'SIGBREAK' | 'SIGINT' | 'SIGKILL' | 'SIGTERM'
  nativePhase?: 'inspect-object' | 'load-native-helper' | 'verification'
  nativeErrorType?:
    | 'ArgumentException'
    | 'FileNotFoundException'
    | 'InvalidOperationException'
    | 'PlatformNotSupportedException'
    | 'ReflectionTypeLoadException'
    | 'RuntimeException'
    | 'UnauthorizedAccessException'
    | 'TypeInitializationException'
    | 'Win32Exception'
  hresult?: string
  nativeOperation?: string
  win32Error?: number
  nativeReason?: string
}

export class PluginStoragePrivacyError extends Error {
  constructor(
    readonly reason: string,
    readonly diagnostic?: PluginStorageNativeDiagnostic
  ) {
    super('Plugin storage privacy could not be verified')
    this.name = 'PluginStoragePrivacyError'
  }
}

type FileStats = BigIntStats

function nodeIdentity(stats: FileStats): string {
  return `${stats.dev}:${stats.ino}`
}

function nativeIdentityMatches(identity: string, stats: FileStats): boolean {
  const dev = stats.dev.toString(16).toUpperCase().padStart(8, '0')
  const ino = stats.ino.toString(16).toUpperCase().padStart(16, '0')
  return identity === `${dev}:${ino}`
}

type NativeResult = { ok: true; items: WindowsPluginStorageEvidence[] }

/** Validate the allowlisted native response independently from process execution. */
export function validateWindowsPluginStorageEvidence(value: unknown): NativeResult {
  if (!value || typeof value !== 'object') {
    throw new PluginStoragePrivacyError('native-inspection-malformed')
  }
  const record = value as Record<string, unknown>
  if (record.ok !== true || !Array.isArray(record.items)) {
    throw new PluginStoragePrivacyError('native-policy-rejected')
  }
  for (const item of record.items) {
    if (!item || typeof item !== 'object') {
      throw new PluginStoragePrivacyError('native-inspection-malformed')
    }
    const evidence = item as Record<string, unknown>
    if (
      evidence.ok !== true ||
      typeof evidence.identity !== 'string' ||
      typeof evidence.directory !== 'boolean' ||
      evidence.effectiveRead !== true ||
      evidence.effectiveWrite !== true ||
      typeof evidence.inheritedUserAccess !== 'boolean' ||
      evidence.allowedPrincipalsOnly !== true
    ) {
      throw new PluginStoragePrivacyError('native-inspection-malformed')
    }
  }
  return record as NativeResult
}

const PROCESS_ERROR_CODES = new Set([
  'EACCES',
  'EINVAL',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOBUFS',
  'ENOENT',
  'ENOMEM',
  'ENOTDIR',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
])
const PROCESS_SIGNALS = new Set(['SIGABRT', 'SIGBREAK', 'SIGINT', 'SIGKILL', 'SIGTERM'])
const NATIVE_PHASES = new Set(['inspect-object', 'load-native-helper', 'verification'])
const NATIVE_ERROR_TYPES = new Set([
  'ArgumentException',
  'FileNotFoundException',
  'FormatException',
  'IOException',
  'InvalidDataException',
  'InvalidOperationException',
  'PlatformNotSupportedException',
  'ReflectionTypeLoadException',
  'RuntimeException',
  'SecurityException',
  'TypeLoadException',
  'TypeInitializationException',
  'UnauthorizedAccessException',
  'Win32Exception',
])

function boundedElapsedMs(elapsedMs: number): number {
  return Math.max(0, Math.min(60_000, Math.round(elapsedMs)))
}

function nativeDiagnostic(
  failure: PluginStorageNativeDiagnostic['failure'],
  result: SpawnSyncReturns<string>,
  elapsedMs: number,
  response?: unknown
): PluginStorageNativeDiagnostic {
  const diagnostic: PluginStorageNativeDiagnostic = {
    failure,
    elapsedMs: boundedElapsedMs(elapsedMs),
  }
  const processErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (typeof processErrorCode === 'string' && PROCESS_ERROR_CODES.has(processErrorCode)) {
    diagnostic.processErrorCode =
      processErrorCode as PluginStorageNativeDiagnostic['processErrorCode']
  }
  diagnostic.exitStatus =
    Number.isSafeInteger(result.status) && result.status !== null
      ? Math.max(-1, Math.min(255, result.status))
      : null
  if (typeof result.signal === 'string' && PROCESS_SIGNALS.has(result.signal)) {
    diagnostic.signal = result.signal as PluginStorageNativeDiagnostic['signal']
  }
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const fields = response as Record<string, unknown>
    if (typeof fields.phase === 'string' && NATIVE_PHASES.has(fields.phase)) {
      diagnostic.nativePhase = fields.phase as PluginStorageNativeDiagnostic['nativePhase']
    }
    if (typeof fields.errorType === 'string' && NATIVE_ERROR_TYPES.has(fields.errorType)) {
      diagnostic.nativeErrorType =
        fields.errorType as PluginStorageNativeDiagnostic['nativeErrorType']
    }
    if (typeof fields.hresult === 'string' && /^0x[0-9A-F]{8}$/i.test(fields.hresult)) {
      diagnostic.hresult = `0x${fields.hresult.slice(2).toUpperCase()}`
    }
    if (
      typeof fields.nativeOperation === 'string' &&
      /^[a-z-]{1,40}$/.test(fields.nativeOperation)
    ) {
      diagnostic.nativeOperation = fields.nativeOperation
    }
    if (
      typeof fields.win32Error === 'number' &&
      Number.isSafeInteger(fields.win32Error) &&
      fields.win32Error >= 0 &&
      fields.win32Error <= 0xffff
    ) {
      diagnostic.win32Error = fields.win32Error
    }
    if (typeof fields.reason === 'string' && /^[a-z-]{1,60}$/.test(fields.reason)) {
      diagnostic.nativeReason = fields.reason
    }
  }
  return diagnostic
}

function sanitizedResult(result: SpawnSyncReturns<string>, elapsedMs: number): NativeResult {
  if (result.error) {
    const processErrorCode = (result.error as NodeJS.ErrnoException).code
    const timedOut = processErrorCode === 'ETIMEDOUT'
    const launchFailed = ['EACCES', 'ENOENT', 'EPERM'].includes(String(processErrorCode))
    throw new PluginStoragePrivacyError(
      timedOut
        ? 'native-inspection-process-timeout'
        : launchFailed
          ? 'native-inspection-process-start-failed'
          : 'native-inspection-process-error',
      nativeDiagnostic(
        timedOut ? 'process-timeout' : launchFailed ? 'process-start-failed' : 'process-error',
        result,
        elapsedMs
      )
    )
  }
  if (result.signal) {
    throw new PluginStoragePrivacyError(
      'native-inspection-process-terminated',
      nativeDiagnostic('process-terminated', result, elapsedMs)
    )
  }
  if (!result.stdout) {
    throw new PluginStoragePrivacyError(
      'native-inspection-response-missing',
      nativeDiagnostic('response-missing', result, elapsedMs)
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    throw new PluginStoragePrivacyError(
      'native-inspection-response-malformed',
      nativeDiagnostic('response-malformed', result, elapsedMs)
    )
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).ok === false
  ) {
    throw new PluginStoragePrivacyError(
      'native-verifier-rejected',
      nativeDiagnostic('verifier-rejected', result, elapsedMs, parsed)
    )
  }
  if (result.status !== 0) {
    throw new PluginStoragePrivacyError(
      'native-inspection-process-exit-failed',
      nativeDiagnostic('process-exit-failed', result, elapsedMs, parsed)
    )
  }
  try {
    return validateWindowsPluginStorageEvidence(parsed)
  } catch (error) {
    if (error instanceof PluginStoragePrivacyError) {
      throw new PluginStoragePrivacyError(
        'native-inspection-evidence-invalid',
        nativeDiagnostic('evidence-invalid', result, elapsedMs, parsed)
      )
    }
    throw error
  }
}

/** Inspect actual Windows handles using the existing compiled native helper. */
export function inspectWindowsPluginStoragePaths(
  checks: readonly PathCheck[]
): WindowsPluginStorageEvidence[] {
  if (process.platform !== 'win32') throw new PluginStoragePrivacyError('unsupported-platform')
  if (checks.length === 0 || checks.some(check => !path.win32.isAbsolute(check.path))) {
    throw new PluginStoragePrivacyError('path-invalid')
  }
  const systemRoot = process.env.SystemRoot
  const temporaryDirectory = process.env.TEMP ?? process.env.TMP
  if (!systemRoot || !temporaryDirectory) {
    throw new PluginStoragePrivacyError('system-path-unavailable')
  }
  const request = Buffer.from(JSON.stringify({ items: checks }), 'utf8').toString('base64')
  const executable = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const startedAt = performance.now()
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LAUNCHER],
    {
      encoding: 'utf8',
      env: {
        ...createWindowsSessionAuthorityPowerShellEnvironment(systemRoot, temporaryDirectory),
        [REQUEST_ENV]: request,
        [WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV]:
          windowsSessionAuthorityNativeAssemblyPath(),
      },
      input: SCRIPT,
      maxBuffer: 8192,
      timeout: 15_000,
      windowsHide: true,
    }
  )
  const items = sanitizedResult(result, performance.now() - startedAt).items
  if (items.length !== checks.length) {
    throw new PluginStoragePrivacyError('native-inspection-incomplete')
  }
  return items
}

/**
 * Verify plugin storage directories and files once per object identity. A private parent and the
 * verified allowlist prevent unprivileged replacement or DACL changes. The current user, SYSTEM,
 * and Administrators are trusted to change their own DACLs. Cheap lstat identity checks detect a
 * changed object without launching PowerShell for every consent lookup or audit append.
 */
export class PluginStoragePrivacyGuard {
  private readonly verified = new Map<
    string,
    { identity: string; evidence: WindowsPluginStorageEvidence }
  >()

  constructor(private readonly baseDirectory: string) {}

  async ensureDirectory(): Promise<void> {
    if (process.platform !== 'win32') return
    const parent = path.dirname(this.baseDirectory)
    await this.verifyObjects([{ path: parent, directory: true, requireInherited: false }])
    await fs.mkdir(this.baseDirectory, { recursive: true, mode: 0o700 })
    await this.verifyDirectory()
  }

  async verifyDirectory(): Promise<void> {
    if (process.platform !== 'win32') return
    const parent = path.dirname(this.baseDirectory)
    await this.verifyObjects([
      { path: parent, directory: true, requireInherited: false },
      { path: this.baseDirectory, directory: true, requireInherited: true },
    ])
  }

  async verifyFile(file: string): Promise<string | undefined> {
    if (process.platform !== 'win32') return undefined
    let stats: FileStats
    try {
      stats = await fs.lstat(file, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new PluginStoragePrivacyError('file-stat-failed')
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new PluginStoragePrivacyError('object-type-invalid')
    }
    await this.verifyDirectory()
    await this.verifyObjects([{ path: file, directory: false, requireInherited: true }])
    return this.verified.get(file)?.identity
  }

  async recordRename(source: string, destination: string): Promise<void> {
    if (process.platform !== 'win32') return
    const sourceRecord = this.verified.get(source)
    if (!sourceRecord) throw new PluginStoragePrivacyError('rename-source-unverified')
    let stats: FileStats
    try {
      stats = await fs.lstat(destination, { bigint: true })
    } catch {
      throw new PluginStoragePrivacyError('rename-target-unavailable')
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      !nativeIdentityMatches(sourceRecord.evidence.identity, stats)
    ) {
      throw new PluginStoragePrivacyError('rename-identity-changed')
    }
    this.verified.delete(source)
    this.verified.set(destination, {
      identity: nodeIdentity(stats),
      evidence: sourceRecord.evidence,
    })
    return
  }

  forget(file: string): void {
    this.verified.delete(file)
  }

  private async verifyObjects(checks: PathCheck[]): Promise<void> {
    const pending: PathCheck[] = []
    const pendingStats: FileStats[] = []
    for (const check of checks) {
      let stats: FileStats
      try {
        stats = await fs.lstat(check.path, { bigint: true })
      } catch {
        throw new PluginStoragePrivacyError('object-unavailable')
      }
      if (stats.isSymbolicLink() || (check.directory ? !stats.isDirectory() : !stats.isFile())) {
        throw new PluginStoragePrivacyError('object-type-invalid')
      }
      const cached = this.verified.get(check.path)
      const identity = nodeIdentity(stats)
      if (cached?.identity === identity) continue
      pending.push(check)
      pendingStats.push(stats)
    }
    if (pending.length === 0) return
    const evidence = inspectWindowsPluginStoragePaths(pending)
    if (evidence.length !== pending.length) {
      throw new PluginStoragePrivacyError('native-inspection-incomplete')
    }
    for (let index = 0; index < pending.length; index += 1) {
      const check = pending[index]!
      const stats = pendingStats[index]!
      const itemEvidence = evidence[index]!
      if (
        itemEvidence.directory !== check.directory ||
        !nativeIdentityMatches(itemEvidence.identity, stats)
      ) {
        throw new PluginStoragePrivacyError('native-identity-mismatch')
      }
      this.verified.set(check.path, { identity: nodeIdentity(stats), evidence: itemEvidence })
    }
  }
}
